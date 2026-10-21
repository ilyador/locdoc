//! One guarded writer for Markdown projections. Never detach an open desktop
//! writer by replacing its inode. Leases also keep readers out of partial writes.
use super::*;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
const F_SETSIG: libc::c_int = 10; // Linux fcntl ABI; not exported by libc.

/// File fsync does not persist directory entries. Sync each directory whose
/// child may have been created, stopping at the workspace root.
pub(super) fn sync_directories(directory: &Path, root: &Path) -> Result<()> {
    let mut current = directory;
    loop {
        fs::File::open(current)?.sync_all()?;
        if current == root {
            return Ok(());
        }
        current = current
            .parent()
            .filter(|parent| parent.starts_with(root))
            .ok_or_else(|| bad("Directory is outside the documents folder."))?;
    }
}

/// Atomic same-filesystem rename without std::fs::rename's overwrite behavior.
/// Linux is also required by the document writer's inode leases.
pub(super) fn rename_new(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == -1 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Held for the Store lifetime, by the server and by the restore pass alike.
/// SQLite transactions alone cannot serialize two independent CRDT/file
/// projection coordinators over the same state folder.
pub(super) struct StateLock(fs::File);
impl StateLock {
    pub(super) fn acquire(data: &Path) -> Result<Self> {
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(data.join(".instance.lock"))?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == -1 {
            return Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                format!(
                    "Another Locdoc process is using the state folder {}. Stop it first.",
                    data.display()
                ),
            ));
        }
        Ok(Self(file))
    }
}
impl Drop for StateLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct Stamp {
    device: u64,
    inode: u64,
    bytes: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}
impl Stamp {
    fn metadata(value: fs::Metadata) -> Self {
        Self {
            device: value.dev(),
            inode: value.ino(),
            bytes: value.len(),
            modified: (value.mtime(), value.mtime_nsec()),
            changed: (value.ctime(), value.ctime_nsec()),
        }
    }
    pub(super) fn read(path: &Path) -> Option<Self> {
        fs::metadata(path).ok().map(Self::metadata)
    }
}

pub(super) struct DiskFile(fs::File, libc::c_int);
impl DiskFile {
    pub(super) fn stamp(&self) -> Option<Stamp> {
        self.0.metadata().ok().map(Stamp::metadata)
    }
    pub(super) fn metadata(&self) -> std::io::Result<fs::Metadata> {
        self.0.metadata()
    }

    pub(super) fn open(path: &Path) -> Result<Option<Self>> {
        Self::leased(path, libc::F_WRLCK)
    }
    pub(super) fn open_read(path: &Path) -> Result<Option<Self>> {
        Self::leased(path, libc::F_RDLCK)
    }
    fn leased(path: &Path, lease: libc::c_int) -> Result<Option<Self>> {
        let file = match fs::OpenOptions::new()
            .read(true)
            .write(lease == libc::F_WRLCK)
            // Opening a file can itself wait for another lease to break (45 s
            // on a typical Linux installation), before F_SETLEASE runs. Let
            // the coordinator retry instead of stalling every document.
            .custom_flags(libc::O_NONBLOCK)
            .open(path)
        {
            Ok(file) => file,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound
                        | std::io::ErrorKind::PermissionDenied
                        | std::io::ErrorKind::WouldBlock
                ) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        };
        let fd = file.as_raw_fd();
        // SIGURG has an ignored default disposition. A conflicting opener waits
        // only for this short synchronous commit, then continues on the SAME inode.
        // No process-wide signal handler or privileged filesystem monitor is needed.
        if unsafe { libc::fcntl(fd, F_SETSIG, libc::SIGURG) } == -1 {
            return Err(std::io::Error::last_os_error().into());
        }
        if unsafe { libc::fcntl(fd, libc::F_SETLEASE, lease) } == -1 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EAGAIN) {
                return Ok(None);
            }
            // Fail closed on filesystems without leases; a timer cannot prove
            // that a non-cooperating desktop writer has finished.
            return Err(error.into());
        }
        Ok(Some(Self(file, lease)))
    }
    pub(super) fn read_bytes(&mut self) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        self.0.seek(SeekFrom::Start(0))?;
        (&mut self.0)
            .take((5 * MB + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 5 * MB {
            return Err(bad("Documents are limited to 5 MB."));
        }
        Ok(bytes)
    }
    pub(super) fn read(&mut self) -> Result<String> {
        String::from_utf8(self.read_bytes()?).map_err(|_| bad("This file is not valid UTF-8 text."))
    }
    pub(super) fn write(&mut self, content: &str) -> Result<()> {
        self.0.seek(SeekFrom::Start(0))?;
        self.0.write_all(content.as_bytes())?;
        self.0.set_len(content.len() as u64)?;
        self.0.sync_all()?;
        Ok(())
    }
    pub(super) fn writable(&self) -> bool {
        self.1 == libc::F_WRLCK
    }
    pub(super) fn intact(&self) -> bool {
        // F_GETLEASE reports the target lease while a break is pending.
        unsafe { libc::fcntl(self.0.as_raw_fd(), libc::F_GETLEASE) == self.1 }
    }
    /// A pending reader break asks only for consistent bytes: its open waits
    /// until this handle closes, then sees the finished write. Only writers
    /// and truncation must cancel a projection before its first byte.
    pub(super) fn excludes_writers(&self) -> bool {
        let lease = unsafe { libc::fcntl(self.0.as_raw_fd(), libc::F_GETLEASE) };
        lease == self.1 || (self.1 == libc::F_WRLCK && lease == libc::F_RDLCK)
    }
    pub(super) fn is_current(&self, path: &Path) -> bool {
        let Ok(held) = self.0.metadata() else {
            return false;
        };
        fs::metadata(path)
            .is_ok_and(|current| current.dev() == held.dev() && current.ino() == held.ino())
    }
}

impl Drop for DiskFile {
    fn drop(&mut self) {
        unsafe {
            libc::fcntl(self.0.as_raw_fd(), libc::F_SETLEASE, libc::F_UNLCK);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn atomic_renames_preserve_the_inode_and_never_replace_a_destination() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.md");
        let destination = directory.path().join("destination.md");
        fs::write(&source, "Original").unwrap();
        fs::write(&destination, "Unrelated").unwrap();
        let inode = fs::metadata(&source).unwrap().ino();
        assert_eq!(
            rename_new(&source, &destination).unwrap_err().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read_to_string(&source).unwrap(), "Original");
        assert_eq!(fs::read_to_string(&destination).unwrap(), "Unrelated");
        fs::remove_file(&destination).unwrap();
        let held = fs::File::open(&source).unwrap();
        rename_new(&source, &destination).unwrap();
        sync_directories(directory.path(), directory.path()).unwrap();
        assert!(!source.exists());
        assert_eq!(held.metadata().unwrap().ino(), inode);
        assert_eq!(fs::metadata(destination).unwrap().ino(), inode);
    }
    #[test]
    fn recovery_reads_preserve_exact_bytes_while_normal_reads_require_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("torn.md");
        let bytes = [b'A', 0xf0, 0x9f];
        fs::write(&path, bytes).unwrap();
        let mut file = DiskFile::open_read(&path).unwrap().unwrap();
        assert!(file.read().is_err());
        assert_eq!(file.read_bytes().unwrap(), bytes);
    }
    #[test]
    fn a_state_directory_accepts_only_one_live_projection_coordinator() {
        let dir = tempfile::tempdir().unwrap();
        let first = StateLock::acquire(dir.path()).unwrap();
        assert!(StateLock::acquire(dir.path()).is_err());
        drop(first);
        assert!(StateLock::acquire(dir.path()).is_ok());
    }
    #[test]
    fn conflicting_leases_return_promptly_and_retry_after_release() {
        use std::time::Duration;
        for (held_write, requested_write) in [(false, true), (true, false), (true, true)] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("busy.md");
            fs::write(&path, "Unchanged synthetic document").unwrap();
            let inode = fs::metadata(&path).unwrap().ino();
            let held = if held_write {
                DiskFile::open(&path)
            } else {
                DiskFile::open_read(&path)
            }
            .unwrap()
            .unwrap();
            let (done, result) = std::sync::mpsc::channel();
            let target = path.clone();
            let worker = std::thread::spawn(move || {
                let result = if requested_write {
                    DiskFile::open(&target)
                } else {
                    DiskFile::open_read(&target)
                };
                done.send(result.unwrap().is_none()).unwrap();
            });
            let promptly_unavailable = result.recv_timeout(Duration::from_millis(500));
            // Release before asserting so the old blocking implementation
            // fails quickly without leaving a thread stuck on the kernel lease.
            drop(held);
            worker.join().unwrap();
            assert!(
                promptly_unavailable.unwrap_or(false),
                "A conflicting lease must return unavailable without waiting for its kernel timeout"
            );
            let retry = if requested_write {
                DiskFile::open(&path)
            } else {
                DiskFile::open_read(&path)
            }
            .unwrap();
            assert!(
                retry.is_some(),
                "The same inode must become available after release"
            );
            drop(retry);
            assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
            assert_eq!(
                fs::read_to_string(&path).unwrap(),
                "Unchanged synthetic document"
            );
        }
    }
    #[test]
    fn readers_waiting_for_a_write_lease_do_not_cancel_it_but_writers_do() {
        use std::os::unix::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lease.md");
        fs::write(&path, "Browser projection").unwrap();
        let guard = DiskFile::open(&path).unwrap().unwrap();
        // A nonblocking opener still starts the kernel's lease break.
        let open = |write: bool| {
            fs::OpenOptions::new()
                .read(!write)
                .write(write)
                .custom_flags(libc::O_NONBLOCK)
                .open(&path)
                .unwrap_err()
                .kind()
        };
        assert_eq!(open(false), std::io::ErrorKind::WouldBlock);
        assert!(!guard.intact());
        assert!(
            guard.excludes_writers(),
            "A reader only needs the finished bytes"
        );
        assert_eq!(open(true), std::io::ErrorKind::WouldBlock);
        assert!(
            !guard.excludes_writers(),
            "A desktop writer must win before the first projected byte"
        );
    }
    #[test]
    fn a_desktop_opener_waiting_for_our_lease_keeps_the_same_inode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lease.md");
        fs::write(&path, "Browser projection").unwrap();
        let inode = fs::metadata(&path).unwrap().ino();
        let guard = DiskFile::open(&path).unwrap().unwrap();
        let (done, completion) = std::sync::mpsc::channel();
        let target = path.clone();
        let writer = std::thread::spawn(move || {
            let mut file = fs::OpenOptions::new().append(true).open(target).unwrap();
            file.write_all(b" and desktop save").unwrap();
            done.send(()).unwrap();
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while guard.intact() && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert!(!guard.intact());
        assert!(completion.try_recv().is_err());
        drop(guard);
        completion
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        writer.join().unwrap();
        assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "Browser projection and desktop save"
        );
    }
}

//! One guarded writer for Markdown projections. Never detach an open desktop
//! writer by replacing its inode. Leases also keep readers out of partial writes.
use super::*;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
const F_SETSIG: libc::c_int = 10; // Linux fcntl ABI; not exported by libc.

pub(super) struct DiskFile(fs::File, libc::c_int);
impl DiskFile {
    pub(super) fn open(path: &Path) -> Result<Option<Self>> {
        Self::leased(path, libc::F_WRLCK)
    }
    pub(super) fn open_read(path: &Path) -> Result<Option<Self>> {
        Self::leased(path, libc::F_RDLCK)
    }
    fn leased(path: &Path, lease: libc::c_int) -> Result<Option<Self>> {
        let file = fs::OpenOptions::new()
            .read(true)
            .write(lease == libc::F_WRLCK)
            .open(path)?;
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
    pub(super) fn read(&mut self) -> Result<String> {
        let mut text = String::new();
        self.0.seek(SeekFrom::Start(0))?;
        (&mut self.0)
            .take((5 * MB + 1) as u64)
            .read_to_string(&mut text)?;
        if text.len() > 5 * MB {
            return Err(bad("Markdown documents are limited to 5 MB."));
        }
        Ok(text)
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
        // F_GETLEASE reports the target lease while a break is pending. Yield
        // before starting a write if an opener arrived during reconciliation.
        unsafe { libc::fcntl(self.0.as_raw_fd(), libc::F_GETLEASE) == self.1 }
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

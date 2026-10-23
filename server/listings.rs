//! The document lists open tabs ask for every few seconds.
//!
//! A listing is walked again only after something it shows may have
//! changed: a watcher notice that adds, removes or renames a name under the
//! documents folder or changes a folder's permissions, a change to a
//! database row the walk reads, or a minute since the last walk. A notice
//! that only rewrites a document's file can change nothing but that
//! document's time, so it patches that entry instead. Without a watcher, or
//! after it reported an error, or for a folder on a filesystem whose other
//! clients change files unseen, every listing is walked, as before.
//!
//! Each view also keeps the last few listings it sent. A caller that names
//! one of them by its tag and accepts splices (RFC 3229 delta encoding,
//! `A-IM: splice`) is answered `226 IM Used` with only what changed since:
//! while someone types, that is the one entry whose time changed.
use super::*;
use axum::http::{HeaderName, HeaderValue};
use std::collections::VecDeque;
use std::os::unix::fs::MetadataExt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// A listing is walked again at least this often, whatever the watcher
/// says, so a change no notice reported shows within this time.
const REWALK: Duration = Duration::from_secs(60);
/// Views kept: the owner's tree and folder links'.
const VIEWS: usize = 32;
/// Listings each view keeps after sending them, so that a caller holding
/// one is sent only what changed since. Each tab or device holds one.
const SENT: usize = 8;
/// The instance manipulation (RFC 3229) of an answer that holds only what
/// changed since the listing its caller holds.
pub(super) const SPLICE: &str = "splice";
/// Document files whose time a notice may have changed, kept for patching.
const TOUCHED: usize = 4096;

/// What the watcher and the database reported, for deciding whether a
/// listing may stand.
#[derive(Default)]
pub(super) struct Notices {
    /// Bumped by every change that may alter a listing beyond a time.
    namespace: AtomicU64,
    /// Whether a watcher delivers notices for the documents folder.
    watching: AtomicBool,
    /// Whether the watcher reported an error: notices may be missing since.
    failed: AtomicBool,
    times: Mutex<Times>,
}

#[derive(Default)]
struct Times {
    /// The number of the latest notice.
    latest: u64,
    /// Each document file's latest notice.
    files: HashMap<PathBuf, u64>,
    /// Notices up to this one are forgotten.
    forgotten: u64,
}

impl Notices {
    /// Something a listing shows may have changed.
    pub(super) fn changed(&self) {
        self.namespace.fetch_add(1, Ordering::AcqRel);
    }

    /// A file was written: at most its time changed.
    fn touched(&self, path: &Path) {
        let mut times = self.times.lock().unwrap();
        times.latest += 1;
        let latest = times.latest;
        if times.files.len() >= TOUCHED && !times.files.contains_key(path) {
            times.files.clear();
            times.forgotten = latest - 1;
        }
        times.files.insert(path.to_owned(), latest);
    }

    /// One watcher notice, by what it can change.
    pub(super) fn notice(&self, event: &notify::Result<notify::Event>) {
        use notify::event::{AccessKind, AccessMode, EventKind, ModifyKind};
        let event = match event {
            Ok(event) if !event.need_rescan() => event,
            Ok(_) => return self.changed(),
            Err(error) => {
                if !self.failed.swap(true, Ordering::AcqRel) {
                    tracing::warn!("listings are walked on every poll from now on: {error}");
                }
                return self.changed();
            }
        };
        let document = |path: &PathBuf| documents::format(&path.to_string_lossy()).is_some();
        match event.kind {
            // Opening or reading a file changes nothing a listing shows.
            EventKind::Access(
                AccessKind::Open(_)
                | AccessKind::Read
                | AccessKind::Close(AccessMode::Read | AccessMode::Execute),
            ) => {}
            EventKind::Access(AccessKind::Close(AccessMode::Write))
            | EventKind::Modify(ModifyKind::Data(_)) => {
                for path in event.paths.iter().filter(|path| document(path)) {
                    self.touched(path);
                }
            }
            // A folder's permissions decide whether a walk can read it.
            EventKind::Modify(ModifyKind::Metadata(_)) => {
                for path in &event.paths {
                    match fs::symlink_metadata(path) {
                        Ok(metadata) if !metadata.is_dir() => {
                            if document(path) {
                                self.touched(path);
                            }
                        }
                        _ => self.changed(),
                    }
                }
            }
            _ => self.changed(),
        }
    }

    /// A watcher started or stopped delivering notices. A listing walked
    /// without one may have missed any change, so none made before stands.
    pub(super) fn watching(&self, on: bool) {
        self.watching.store(on, Ordering::Release);
        self.changed();
    }

    fn trusted(&self) -> bool {
        self.watching.load(Ordering::Acquire) && !self.failed.load(Ordering::Acquire)
    }

    /// The namespace and the latest notice, read before a walk starts.
    fn now(&self) -> (u64, u64) {
        let namespace = self.namespace.load(Ordering::Acquire);
        (namespace, self.times.lock().unwrap().latest)
    }

    /// The document files written after notice `since`, or None when some
    /// of those notices are forgotten.
    fn touched_since(&self, since: u64) -> Option<Vec<PathBuf>> {
        let times = self.times.lock().unwrap();
        (times.forgotten <= since).then(|| {
            times
                .files
                .iter()
                .filter(|(_, at)| **at > since)
                .map(|(path, _)| path.clone())
                .collect()
        })
    }
}

/// The database rows a listing reads change through triggers that call
/// back here: a document's path, link, state or file identity, a folder
/// link, or a journaled move. Saves of a document's text change none of
/// them. The triggers are TEMP, this connection's own: nothing is written
/// to the state folder.
pub(super) fn watch_rows(db: &Connection, notices: Arc<Notices>) -> rusqlite::Result<()> {
    use rusqlite::functions::FunctionFlags;
    db.create_scalar_function(
        "locdoc_listing_changed",
        0,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_INNOCUOUS,
        move |_| {
            notices.changed();
            Ok(0)
        },
    )?;
    let mut triggers = String::new();
    let changes = [
        ("docs", "UPDATE OF id,path,permission,token,active"),
        ("document_identities", "UPDATE"),
        ("folder_shares", "UPDATE"),
        ("document_moves", "UPDATE"),
        ("entry_moves", "UPDATE"),
    ];
    for (table, update) in changes {
        for (name, change) in [
            ("inserted", "INSERT"),
            ("deleted", "DELETE"),
            ("updated", update),
        ] {
            triggers.push_str(&format!(
                "CREATE TEMP TRIGGER IF NOT EXISTS listing_{table}_{name} AFTER {change} ON {table}
                 BEGIN SELECT locdoc_listing_changed(); END;"
            ));
        }
    }
    db.execute_batch(&triggers)
}

/// A network or user-space filesystem, whose files its other clients can
/// change without a notice here. Unknown counts as such.
pub(super) fn unwatched(folder: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    const REMOTE: [u32; 13] = [
        0x6969,      // NFS
        0x517b,      // SMB
        0xff53_4d42, // CIFS
        0xfe53_4d42, // SMB2
        0x6573_5546, // FUSE: sshfs, rclone and other user-space mounts
        0x0102_1997, // 9P: WSL's Windows drives, virtual machine shares
        0x786f_4256, // VirtualBox shared folders
        0x00c3_6400, // Ceph
        0x5346_414f, // AFS
        0x7375_7245, // Coda
        0x0bd0_0bd0, // Lustre
        0x0116_1970, // GFS2
        0x7461_636f, // OCFS2
    ];
    let Ok(path) = std::ffi::CString::new(folder.as_os_str().as_bytes()) else {
        return true;
    };
    // SAFETY: statfs reads a NUL-terminated path and fills the struct.
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(path.as_ptr(), &mut stat) } != 0 {
        return true;
    }
    REMOTE.contains(&(stat.f_type as u32))
}

/// A listing as some view sent it. Its tag names it, and no other, in this
/// run of the server.
pub(super) struct Listing {
    pub(super) tag: String,
    pub(super) entries: Vec<Arc<Entry>>,
}

/// A view's latest listing and what decides whether it still stands.
struct Current {
    namespace: u64,
    touched: u64,
    walked: Instant,
    /// The folder the entries' paths start from.
    base: PathBuf,
    listing: Arc<Listing>,
    /// Where its entries are; a patch changes times, not places.
    index: Arc<Index>,
    /// Documents left out until a pass decides whose files they are.
    unmatched: bool,
    /// Whether a notice reaches every change it could show.
    watched: bool,
}

struct Index {
    /// Each entry's position, by path.
    paths: HashMap<String, usize>,
    /// Each listed document's position, by its file's device and inode;
    /// `usize::MAX` for a file listed under two names.
    files: HashMap<(u64, u64), usize>,
}

#[derive(Default)]
struct View {
    used: u64,
    current: Option<Arc<Current>>,
    /// The listings sent last, newest last.
    sent: VecDeque<Arc<Listing>>,
}

#[derive(Default)]
struct Views {
    clock: u64,
    views: HashMap<String, View>,
}

impl Views {
    fn view(&mut self, scope: &str) -> &mut View {
        self.clock += 1;
        if !self.views.contains_key(scope) && self.views.len() >= VIEWS {
            let oldest = self
                .views
                .iter()
                .min_by_key(|(_, view)| view.used)
                .map(|(scope, _)| scope.clone());
            if let Some(oldest) = oldest {
                self.views.remove(&oldest);
            }
        }
        let view = self.views.entry(scope.to_owned()).or_default();
        view.used = self.clock;
        view
    }
}

pub(super) struct Listings {
    pub(super) notices: Arc<Notices>,
    views: Mutex<Views>,
    /// Tags of another run of the server never name a listing of this one.
    instance: String,
    /// The next listing's number; every listing of every view has its own.
    next: AtomicU64,
    /// Walks so far, for tests and measurements.
    walks: AtomicU64,
}

impl Listings {
    pub(super) fn new(notices: Arc<Notices>) -> Self {
        Self {
            notices,
            views: Mutex::default(),
            instance: uuid::Uuid::new_v4().simple().to_string()[..12].to_owned(),
            next: AtomicU64::new(1),
            walks: AtomicU64::new(0),
        }
    }

    #[cfg(test)]
    pub(super) fn walks(&self) -> u64 {
        self.walks.load(Ordering::Acquire)
    }

    fn tag(&self) -> String {
        let number = self.next.fetch_add(1, Ordering::AcqRel);
        format!("W/\"{}-{number}\"", self.instance)
    }

    /// The view's latest listing while nothing it shows can have changed,
    /// with new times where only times can have.
    fn reuse(
        &self,
        s: &Store,
        scope: &str,
        base: &Path,
        (namespace, touched): (u64, u64),
    ) -> Option<Arc<Listing>> {
        if !self.notices.trusted() {
            return None;
        }
        let current = self.views.lock().unwrap().view(scope).current.clone()?;
        if !current.watched
            || current.namespace != namespace
            || current.base != base
            || current.walked.elapsed() >= REWALK
        {
            return None;
        }
        if current.unmatched {
            // A walk would ask a pass to match those files again.
            s.listing_unmatched();
        }
        if current.touched == touched {
            return Some(current.listing.clone());
        }
        let written = self.notices.touched_since(current.touched)?;
        let entries = patch(&current, &written)?;
        let listing = if entries
            .iter()
            .zip(&current.listing.entries)
            .all(|(new, old)| Arc::ptr_eq(new, old))
        {
            current.listing.clone()
        } else {
            Arc::new(Listing {
                tag: self.tag(),
                entries,
            })
        };
        let patched = Arc::new(Current {
            namespace: current.namespace,
            touched,
            walked: current.walked,
            base: current.base.clone(),
            listing: listing.clone(),
            index: current.index.clone(),
            unmatched: current.unmatched,
            watched: current.watched,
        });
        let mut views = self.views.lock().unwrap();
        let view = views.view(scope);
        // A walk that finished meanwhile is newer than this patch.
        if view
            .current
            .as_ref()
            .is_some_and(|now| Arc::ptr_eq(now, &current))
        {
            view.current = Some(patched);
        }
        Some(listing)
    }

    /// A new walk's listing. One equal to the view's latest is that one,
    /// under its tag, and each entry equal to one listed before keeps it.
    fn walked(
        &self,
        scope: &str,
        base: PathBuf,
        (namespace, touched): (u64, u64),
        walk: Walk,
    ) -> Arc<Listing> {
        self.walks.fetch_add(1, Ordering::AcqRel);
        let mut views = self.views.lock().unwrap();
        let view = views.view(scope);
        let previous = view.current.clone();
        let mut paths = HashMap::with_capacity(walk.entries.len());
        let mut files = HashMap::new();
        let mut entries = Vec::with_capacity(walk.entries.len());
        for (position, entry) in walk.entries.into_iter().enumerate() {
            let known = previous.as_ref().and_then(|previous| {
                let at = *previous.index.paths.get(&entry.path)?;
                let known = &previous.listing.entries[at];
                (**known == entry).then(|| known.clone())
            });
            if let Some(file) = entry.file {
                // Two names for one file: neither is patched by its notices.
                files
                    .entry(file)
                    .and_modify(|at| *at = usize::MAX)
                    .or_insert(position);
            }
            paths.insert(entry.path.clone(), position);
            entries.push(known.unwrap_or_else(|| Arc::new(entry)));
        }
        let listing = match previous {
            Some(previous)
                if previous.listing.entries.len() == entries.len()
                    && previous
                        .listing
                        .entries
                        .iter()
                        .zip(&entries)
                        .all(|(old, new)| Arc::ptr_eq(old, new)) =>
            {
                previous.listing.clone()
            }
            _ => Arc::new(Listing {
                tag: self.tag(),
                entries,
            }),
        };
        view.current = Some(Arc::new(Current {
            namespace,
            touched,
            walked: Instant::now(),
            base,
            listing: listing.clone(),
            index: Arc::new(Index { paths, files }),
            unmatched: walk.unmatched,
            watched: !walk.unwatched,
        }));
        listing
    }
}

/// The entries with the times of the document files written, or None when
/// a write shows more than a time may have changed.
fn patch(current: &Current, written: &[PathBuf]) -> Option<Vec<Arc<Entry>>> {
    let mut entries = current.listing.entries.clone();
    for path in written {
        let listed = path
            .strip_prefix(&current.base)
            .ok()
            .and_then(|relative| relative.to_str())
            .and_then(|relative| current.index.paths.get(relative))
            .copied();
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            // Gone since: a removal notice follows; nothing is listed there.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && listed.is_none() => {
                continue;
            }
            Err(_) => return None,
        };
        let file = metadata.is_file().then(|| (metadata.dev(), metadata.ino()));
        if let Some(at) = listed
            && entries[at].file.is_none_or(|listed| Some(listed) != file)
        {
            // Another file, or none, where the walk listed this one.
            return None;
        }
        // The file under any of its names: a hard link elsewhere writes the
        // listed document's file too.
        let Some(at) = file
            .and_then(|file| current.index.files.get(&file))
            .copied()
        else {
            continue;
        };
        if at == usize::MAX {
            return None;
        }
        let modified = modified(&metadata);
        if entries[at].modified != modified {
            let mut entry = (*entries[at]).clone();
            entry.modified = modified;
            entries[at] = Arc::new(entry);
        }
    }
    Some(entries)
}

/// A file's modification time in whole seconds, as listings show it.
pub(super) fn modified(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// The view's listing as it is now: the one it holds while nothing it shows
/// can have changed, with new times where only times can have, or walked
/// again on a storage worker.
pub(super) async fn listing(
    s: &App,
    scope: &str,
    base: PathBuf,
    walk: impl FnOnce(&Store) -> Result<Walk> + Send + 'static,
) -> Result<Arc<Listing>> {
    // Read before the walk, so a change during it is a change after it.
    let now = s.listings.notices.now();
    if let Some(listing) = s.listings.reuse(s, scope, &base, now) {
        return Ok(listing);
    }
    let walked = job(s.clone(), walk).await?;
    Ok(s.listings.walked(scope, base, now, walked))
}

impl Listings {
    /// The listing for a caller of this view: 304 Not Modified when its
    /// If-None-Match names it; 226 IM Used with only what changed when it
    /// names a listing this view sent recently and accepts splices; the
    /// whole listing otherwise. A tag is compared only once the handler has
    /// authorized the caller for this view, and only with this view's
    /// listings, so it never stands for another caller's listing.
    pub(super) fn answer(
        &self,
        h: &HeaderMap,
        scope: &str,
        listing: &Arc<Listing>,
    ) -> Result<Response> {
        let etag = HeaderValue::from_str(&listing.tag).expect("a listing's tag is a header value");
        if conditional::names(h, &listing.tag) {
            return Ok((StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response());
        }
        let held = {
            let mut views = self.views.lock().unwrap();
            let view = views.view(scope);
            let held = conditional::manipulates(h, SPLICE)
                .then(|| {
                    view.sent
                        .iter()
                        .rev()
                        .find(|sent| conditional::names(h, &sent.tag))
                        .cloned()
                })
                .flatten();
            if !view
                .sent
                .back()
                .is_some_and(|sent| Arc::ptr_eq(sent, listing))
            {
                view.sent.retain(|sent| !Arc::ptr_eq(sent, listing));
                view.sent.push_back(listing.clone());
                if view.sent.len() > SENT {
                    view.sent.pop_front();
                }
            }
            held
        };
        let json = HeaderValue::from_static("application/json");
        if let Some(held) = held
            && let Some(edits) = edits(&held.entries, &listing.entries)
        {
            #[derive(Serialize)]
            struct Splice<'a> {
                edits: Vec<Edit<'a>>,
            }
            let base = HeaderValue::from_str(&held.tag).expect("a listing's tag is a header value");
            return Ok((
                StatusCode::IM_USED,
                [
                    (header::CONTENT_TYPE, json),
                    (header::ETAG, etag),
                    (
                        HeaderName::from_static("im"),
                        HeaderValue::from_static(SPLICE),
                    ),
                    (HeaderName::from_static("delta-base"), base),
                ],
                serde_json::to_vec(&Splice { edits }).map_err(unprepared)?,
            )
                .into_response());
        }
        #[derive(Serialize)]
        struct Whole<'a> {
            entries: Vec<&'a Entry>,
        }
        let body = serde_json::to_vec(&Whole {
            entries: listing.entries.iter().map(|entry| &**entry).collect(),
        })
        .map_err(unprepared)?;
        Ok(([(header::CONTENT_TYPE, json), (header::ETAG, etag)], body).into_response())
    }
}

fn unprepared(_: serde_json::Error) -> ApiError {
    ApiError(
        StatusCode::INTERNAL_SERVER_ERROR,
        "The listing could not be prepared.".into(),
    )
}

/// One change to a listing: `removed` entries of it from position `at`
/// give way to `entries`.
type Edit<'a> = (usize, usize, Vec<&'a Entry>);

/// What changed from listing `old` to `new`, as edits in order, each at a
/// position of `old`. None when they would hold more than half of `new`:
/// the whole listing is then about as small.
fn edits<'a>(old: &[Arc<Entry>], new: &'a [Arc<Entry>]) -> Option<Vec<Edit<'a>>> {
    use similar::{Algorithm, DiffTag, capture_diff_slices_deadline};
    // Each distinct entry as a number, which the diff compares.
    fn numbered<'e>(numbers: &mut HashMap<&'e Entry, u32>, entries: &'e [Arc<Entry>]) -> Vec<u32> {
        entries
            .iter()
            .map(|entry| {
                let next = numbers.len() as u32;
                *numbers.entry(entry).or_insert(next)
            })
            .collect()
    }
    // Listings in a row share the entries that did not change: only the
    // part between the first and the last that differ is compared by value.
    let same = |(a, b): (&Arc<Entry>, &Arc<Entry>)| Arc::ptr_eq(a, b);
    let start = old.iter().zip(new).take_while(|&pair| same(pair)).count();
    let end = old[start..]
        .iter()
        .rev()
        .zip(new[start..].iter().rev())
        .take_while(|&pair| same(pair))
        .count();
    let mut numbers = HashMap::new();
    let before = numbered(&mut numbers, &old[start..old.len() - end]);
    let after = numbered(&mut numbers, &new[start..new.len() - end]);
    // A diff that takes too long is coarser, never wrong.
    let deadline = Instant::now() + Duration::from_millis(20);
    let mut edits: Vec<Edit<'a>> = Vec::new();
    let mut sent = 0;
    let ops = capture_diff_slices_deadline(Algorithm::Myers, &before, &after, Some(deadline));
    for op in ops {
        let (tag, removed, added) = op.as_tag_tuple();
        if tag == DiffTag::Equal {
            continue;
        }
        let (at, removed) = (start + removed.start, removed.len());
        let added = start + added.start..start + added.end;
        sent += added.len();
        let added = new[added].iter().map(|entry| &**entry);
        match edits.last_mut() {
            // Next to the last edit, with nothing kept between: one edit.
            Some(last) if last.0 + last.1 == at => {
                last.1 += removed;
                last.2.extend(added);
            }
            _ => edits.push((at, removed, added.collect())),
        }
    }
    (sent * 2 <= new.len()).then_some(edits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{
        AccessKind, AccessMode, CreateKind, DataChange, EventKind, MetadataKind, ModifyKind,
        RemoveKind, RenameMode,
    };

    fn event(kind: EventKind, path: &Path) -> notify::Result<notify::Event> {
        Ok(notify::Event::new(kind).add_path(path.to_owned()))
    }

    #[test]
    fn a_notice_bumps_the_namespace_only_when_more_than_a_time_can_change() {
        let directory = tempfile::tempdir().unwrap();
        let (document, image, folder) = (
            directory.path().join("plan.md"),
            directory.path().join("photo.png"),
            directory.path().join("Notes.md"),
        );
        fs::write(&document, "Plan\n").unwrap();
        fs::write(&image, "PNG").unwrap();
        fs::create_dir(&folder).unwrap();
        let notices = Notices::default();
        let start = notices.now();
        // Reading changes nothing; neither does writing a file no listing shows.
        for kind in [
            EventKind::Access(AccessKind::Open(AccessMode::Any)),
            EventKind::Access(AccessKind::Close(AccessMode::Read)),
        ] {
            notices.notice(&event(kind, &document));
        }
        notices.notice(&event(
            EventKind::Modify(ModifyKind::Data(DataChange::Any)),
            &image,
        ));
        assert_eq!(notices.now(), start);
        // Writing a document changes its time alone.
        for kind in [
            EventKind::Modify(ModifyKind::Data(DataChange::Any)),
            EventKind::Access(AccessKind::Close(AccessMode::Write)),
            EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any)),
        ] {
            notices.notice(&event(kind, &document));
        }
        let (namespace, latest) = notices.now();
        assert_eq!(namespace, start.0);
        assert_eq!(latest, start.1 + 3);
        assert_eq!(notices.touched_since(start.1), Some(vec![document.clone()]));
        assert_eq!(notices.touched_since(latest), Some(vec![]));
        // Names, folders' permissions and lost notices change the namespace.
        let mut namespace = namespace;
        for (kind, path) in [
            (EventKind::Create(CreateKind::File), &document),
            (EventKind::Remove(RemoveKind::File), &document),
            (
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                &document,
            ),
            (
                EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any)),
                &folder,
            ),
            (EventKind::Other, &document),
        ] {
            notices.notice(&event(kind, path));
            assert_eq!(notices.now().0, namespace + 1, "{kind:?} at {path:?}");
            namespace += 1;
        }
        notices.notice(&Ok(
            notify::Event::new(EventKind::Any).set_flag(notify::event::Flag::Rescan)
        ));
        assert_eq!(notices.now().0, namespace + 1);
        // An error may have lost notices: no listing stands after it.
        notices.watching(true);
        assert!(notices.trusted());
        notices.notice(&Err(notify::Error::generic("watch limit reached")));
        assert!(!notices.trusted());
    }

    #[test]
    fn forgotten_writes_never_patch_a_listing() {
        let notices = Notices::default();
        let start = notices.now().1;
        for n in 0..TOUCHED + 1 {
            notices.touched(&PathBuf::from(format!("/docs/{n}.md")));
        }
        assert_eq!(notices.touched_since(start), None);
        let latest = notices.now().1;
        assert_eq!(
            notices.touched_since(latest - 1).map(|paths| paths.len()),
            Some(1)
        );
    }

    #[test]
    fn rows_a_listing_reads_change_the_namespace_and_saving_text_does_not() {
        let directory = tempfile::tempdir().unwrap();
        let s = Store::open(
            directory.path().join("docs"),
            directory.path().join("state"),
            "http://localhost:3477".into(),
        )
        .unwrap();
        let d = s.create_document("plan.md").unwrap();
        let namespace = || s.listings.notices.now().0;
        let run = |sql: &str| {
            s.db.lock().unwrap().execute(sql, [&d.id]).unwrap();
        };
        let before = namespace();
        // What saving typed text writes.
        run("UPDATE docs SET state=x'00' WHERE id=?");
        run("INSERT INTO doc_updates(doc,content) VALUES(?,x'00')");
        assert_eq!(namespace(), before, "saved text is no reason to walk");
        let mut seen = before;
        for sql in [
            "UPDATE docs SET permission='view',token='plan-link' WHERE id=?",
            "UPDATE docs SET path='renamed.md' WHERE id=?",
            "UPDATE docs SET active=2 WHERE id=?",
            "UPDATE document_identities SET identity='elsewhere' WHERE doc=?",
            "DELETE FROM document_identities WHERE doc=?",
            "INSERT INTO folder_shares(path,identity,permission,token) VALUES('Notes','x','view',?)",
        ] {
            run(sql);
            assert!(namespace() > seen, "{sql}");
            seen = namespace();
        }
        // The triggers are this connection's own; the state file has none.
        let stored: i64 =
            s.db.lock()
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM main.sqlite_schema WHERE type='trigger'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
        assert_eq!(stored, 0);
    }

    fn listed(path: &str, modified: u64) -> Arc<Entry> {
        Arc::new(Entry {
            path: path.into(),
            kind: "file",
            id: Some(path.into()),
            shared: false,
            modified,
            title: path.into(),
            url: None,
            format: Some("markdown"),
            file: None,
        })
    }

    #[test]
    fn edits_make_the_new_listing_from_the_old_one() {
        // A small, fixed-seed generator: every run tries the same lists.
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut random = |bound: usize| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % bound as u64) as usize
        };
        for round in 0..300 {
            let old: Vec<_> = (0..random(60))
                .map(|n| listed(&format!("{n}.md"), 1))
                .collect();
            let mut new = old.clone();
            for _ in 0..random(4) {
                match random(4) {
                    0 if !new.is_empty() => {
                        new.remove(random(new.len()));
                    }
                    1 => {
                        let at = random(new.len() + 1);
                        new.insert(at, listed(&format!("new {round} {at}.md"), 2));
                    }
                    2 if !new.is_empty() => {
                        let at = random(new.len());
                        new[at] = listed(&new[at].path.clone(), 3);
                    }
                    _ if new.len() > 1 => {
                        let entry = new.remove(random(new.len()));
                        new.insert(random(new.len() + 1), entry);
                    }
                    _ => {}
                }
            }
            let Some(edits) = edits(&old, &new) else {
                continue;
            };
            let mut made: Vec<&Entry> = Vec::new();
            let mut next = 0;
            for (at, removed, added) in &edits {
                assert!(*at >= next && at + removed <= old.len(), "round {round}");
                made.extend(old[next..*at].iter().map(|entry| &**entry));
                made.extend(added.iter().copied());
                next = at + removed;
            }
            made.extend(old[next..].iter().map(|entry| &**entry));
            assert!(
                made.iter().copied().eq(new.iter().map(|entry| &**entry)),
                "round {round}"
            );
        }
        // One changed time is one entry; most changed is the whole listing.
        let old: Vec<_> = (0..10).map(|n| listed(&format!("{n}.md"), 1)).collect();
        let mut new = old.clone();
        new[4] = listed("4.md", 2);
        let one = edits(&old, &new).unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!((one[0].0, one[0].1, one[0].2.len()), (4, 1, 1));
        let most: Vec<_> = (0..10).map(|n| listed(&format!("{n}.md"), 2)).collect();
        assert!(edits(&old, &most).is_none());
        let emptied = edits(&old, &[]).unwrap();
        assert_eq!(emptied.len(), 1);
        assert_eq!((emptied[0].0, emptied[0].1, emptied[0].2.len()), (0, 10, 0));
    }

    #[test]
    fn a_local_folder_is_watched() {
        let directory = tempfile::tempdir().unwrap();
        assert!(!unwatched(directory.path()));
        assert!(unwatched(&directory.path().join("missing")));
    }
}

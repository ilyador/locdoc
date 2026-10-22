//! The only boundary that decides which file is which document, and the only
//! one that changes filenames. One pass settles journaled Locdoc renames,
//! observes the documents tree, classifies every document from evidence and
//! applies all path and identity changes in one transaction. A recorded file
//! identity outranks a path: a pathname alone never moves a document's links,
//! history or text onto another document's file.
use super::documents::{FORMATS, format, relative_path, retire, retire_trashed};
use super::*;
use std::hash::Hash;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::time::{Duration, Instant};

/// Retry after a busy room, a concurrent change or an engine request.
const RETRY: Duration = Duration::from_secs(1);
/// Retry after an unreadable folder kept a missing document from retiring.
const INCOMPLETE_RETRY: Duration = Duration::from_secs(30);
/// How long an editor's save may leave a document's name empty. Passes wait
/// this long after a removal; a file born later at an emptied name is not
/// the document's own.
pub(super) const SETTLE: Duration = Duration::from_secs(1);

/// Wall-clock nanoseconds, the unit of file birth times.
fn clock() -> i64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_nanos() as i64);
    #[cfg(test)]
    let now = now + tests::CLOCK.get();
    now
}

/// Evidence that a directory entry is one particular file: device, inode and
/// birth time. An inode alone can be reused after deletion; files without a
/// birth time carry no evidence. A hard link is another name for the same
/// file, so it still shows whose file it is, but not where that file moved.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct Identity(String);
impl Identity {
    pub(super) fn of(metadata: &fs::Metadata) -> Option<Self> {
        metadata.is_file().then_some(())?;
        Some(Self(format!(
            "{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            FileMove::birth(metadata)?
        )))
    }
    pub(super) fn as_str(&self) -> &str {
        &self.0
    }
    fn born(&self) -> Option<i64> {
        self.0.rsplit(':').next()?.parse().ok()
    }
}

/// Whether a file at a document's name, which a pass saw without the
/// document's file at `since`, may still be the document's own: a non-atomic
/// save writes it within the settle window. A file born later, or moved
/// there from elsewhere once the window passed, is another file.
fn continues(since: i64, now: i64, evidence: Option<&Identity>) -> bool {
    let window = SETTLE.as_nanos() as i64;
    now <= since + window
        || evidence
            .and_then(Identity::born)
            .is_some_and(|born| (since - window..=since + window).contains(&born))
}

/// Record a document's evidence, or forget it when its file carries none.
pub(super) fn record_identity(
    db: &Connection,
    id: &str,
    evidence: Option<&Identity>,
) -> Result<()> {
    match evidence {
        Some(Identity(identity)) => db.execute(
            "INSERT INTO document_identities(doc,identity) VALUES(?,?)
             ON CONFLICT(doc) DO UPDATE SET identity=excluded.identity
             WHERE identity!=excluded.identity",
            params![id, identity],
        )?,
        None => db.execute("DELETE FROM document_identities WHERE doc=?", [id])?,
    };
    Ok(())
}

/// When the maintenance loop should run the next settled pass. Engine paths
/// hold a room and so cannot wait for `document_files`; they ask instead.
#[derive(Default)]
pub(super) struct Requests(Mutex<Requested>);

#[derive(Default)]
struct Requested {
    next: Option<Instant>,
    /// Missing documents the last incomplete listing keeps until its own
    /// retry, each with a folder it could not list that may hide its file.
    /// Asking again for them cannot complete the listing sooner.
    held: HashMap<String, PathBuf>,
    /// Where the last pass found the file of a document whose row could not
    /// follow yet: a busy room, or a name another document still keeps.
    elsewhere: HashMap<String, String>,
}

impl Requests {
    pub(super) fn after(&self, delay: Duration) {
        let at = Instant::now() + delay;
        let mut requested = self.0.lock().unwrap();
        requested.next = Some(requested.next.map_or(at, |next| next.min(at)));
    }
    /// An engine path cannot use this document's file yet.
    fn unmatched(&self, document: &str) {
        if !self.holds(document) {
            self.after(RETRY);
        }
    }
    /// A listing or a desktop save found a file no pass has matched yet.
    /// While an incomplete walk holds missing documents only its own retry
    /// can settle them, and every pass meanwhile walks the tree, so neither
    /// asks.
    fn unlisted(&self) {
        let held = !self.0.lock().unwrap().held.is_empty();
        if !held {
            self.after(RETRY);
        }
    }
    fn hold(&self, documents: HashMap<String, PathBuf>) {
        self.0.lock().unwrap().held = documents;
    }
    fn holds(&self, document: &str) -> bool {
        self.0.lock().unwrap().held.contains_key(document)
    }
    /// The folder the last listing could not read that may hide the file of
    /// a document it keeps from retiring.
    fn holder(&self, document: &str) -> Option<PathBuf> {
        self.0.lock().unwrap().held.get(document).cloned()
    }
    /// Whether a document is now found somewhere it was not before.
    fn found(&self, elsewhere: HashMap<String, String>) -> bool {
        let mut requested = self.0.lock().unwrap();
        let narrower = elsewhere
            .iter()
            .any(|(id, path)| requested.elsewhere.get(id) != Some(path));
        requested.elsewhere = elsewhere;
        narrower
    }
    fn keep_found(&self, keep: impl Fn(&str) -> bool) {
        self.0.lock().unwrap().elsewhere.retain(|id, _| keep(id));
    }
    fn elsewhere(&self, document: &str) -> Option<String> {
        self.0.lock().unwrap().elsewhere.get(document).cloned()
    }
    pub(super) fn take(&self) -> Option<Instant> {
        self.0.lock().unwrap().next.take()
    }
}

/// SQLite and a directory cannot commit atomically. Only a Locdoc rename has
/// a filesystem step of its own, so only it keeps a durable intent until both
/// the directory entry and document identity have committed. File identity
/// binds recovery to our file; birth time, where supported, additionally
/// distinguishes an unrelated file that reuses the same inode.
struct FileMove {
    document: String,
    source: String,
    destination: String,
    device: String,
    inode: String,
    born: Option<String>,
}
impl FileMove {
    fn new(document: &str, source: String, destination: String, metadata: &fs::Metadata) -> Self {
        Self {
            document: document.into(),
            source,
            destination,
            device: metadata.dev().to_string(),
            inode: metadata.ino().to_string(),
            born: Self::birth(metadata),
        }
    }
    fn birth(metadata: &fs::Metadata) -> Option<String> {
        metadata
            .created()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|time| time.as_nanos().to_string())
    }
    fn contains(&self, path: &Path) -> std::io::Result<bool> {
        match fs::symlink_metadata(path) {
            Ok(metadata) => Ok(metadata.is_file()
                && metadata.dev().to_string() == self.device
                && metadata.ino().to_string() == self.inode
                && self
                    .born
                    .as_ref()
                    .is_none_or(|born| Self::birth(&metadata).as_ref() == Some(born))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }
}

/// How a journaled rename settled.
enum Outcome {
    Moved,
    /// The intent is gone and the document keeps its row path; a pass places
    /// it from file evidence.
    Dropped,
}

/// Locdoc's trash, a hidden folder at the documents root. Walks, listings
/// and media never enter it, so nothing in it is found, listed or served.
/// Each deleted entry keeps its name inside a folder named by its item.
pub(super) const TRASH: &str = ".locdoc-trash";

/// What a journaled entry move does once its file or folder is in place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    /// A folder moves to another visible path.
    Rename,
    /// A document's file or a folder moves into the trash.
    Trash,
    /// A trash item moves back to its original path.
    Restore,
}
impl Action {
    fn as_str(self) -> &'static str {
        match self {
            Self::Rename => "rename",
            Self::Trash => "trash",
            Self::Restore => "restore",
        }
    }
    fn parse(value: &str) -> Option<Self> {
        [Self::Rename, Self::Trash, Self::Restore]
            .into_iter()
            .find(|action| action.as_str() == value)
    }
}

/// What a trash item or an entry move carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum EntryKind {
    Document,
    Folder,
}
impl EntryKind {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Document => "document",
            Self::Folder => "folder",
        }
    }
    pub(super) fn parse(value: &str) -> Option<Self> {
        [Self::Document, Self::Folder]
            .into_iter()
            .find(|entry| entry.as_str() == value)
    }
}

/// A folder move, a delete into the trash or a restore: the file or folder
/// by device, inode and birth time, with its final destination, journaled
/// before the filesystem changes. Every pass settles what is left from
/// where that entry is now, as a document rename does, before it observes
/// the tree.
struct EntryMove {
    /// The trash item, for a delete or a restore.
    id: String,
    action: Action,
    entry: EntryKind,
    /// The document whose file a document delete moves.
    document: Option<String>,
    source: String,
    destination: String,
    device: String,
    inode: String,
    born: Option<String>,
}
impl EntryMove {
    fn new(
        id: String,
        action: Action,
        entry: EntryKind,
        document: Option<String>,
        (source, destination): (String, String),
        metadata: &fs::Metadata,
    ) -> Self {
        Self {
            id,
            action,
            entry,
            document,
            source,
            destination,
            device: metadata.dev().to_string(),
            inode: metadata.ino().to_string(),
            born: FileMove::birth(metadata),
        }
    }
    /// Whether `path` holds the journaled file or folder.
    fn contains(&self, path: &Path) -> std::io::Result<bool> {
        match fs::symlink_metadata(path) {
            Ok(metadata) => Ok(match self.entry {
                EntryKind::Document => metadata.is_file(),
                EntryKind::Folder => metadata.is_dir(),
            } && metadata.dev().to_string() == self.device
                && metadata.ino().to_string() == self.inode
                && self
                    .born
                    .as_ref()
                    .is_none_or(|born| FileMove::birth(&metadata).as_ref() == Some(born))),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }
    /// Whether this move carries the active document recorded at `path`.
    /// A restore carries trashed documents, which no pass tracks.
    fn carries(&self, id: &str, path: &str) -> bool {
        match (self.action, self.entry) {
            (Action::Restore, _) => false,
            (_, EntryKind::Document) => self.document.as_deref() == Some(id),
            (_, EntryKind::Folder) => below(path, &self.source).is_some(),
        }
    }
    /// Whether settling this move may change what `path` names.
    fn covers(&self, path: &str) -> bool {
        overlap(path, &self.source) || overlap(path, &self.destination)
    }
}

/// The part of `path` below `folder`: empty for the folder itself.
fn below<'a>(path: &'a str, folder: &str) -> Option<&'a str> {
    if path == folder {
        return Some("");
    }
    path.strip_prefix(folder)?.strip_prefix('/')
}

/// Where `path` is once `from` has moved to `to`.
fn rebase(path: &str, from: &str, to: &str) -> Option<String> {
    below(path, from).map(|rest| {
        if rest.is_empty() {
            to.to_owned()
        } else {
            format!("{to}/{rest}")
        }
    })
}

/// Whether one path is the other or inside it.
fn overlap(a: &str, b: &str) -> bool {
    below(a, b).is_some() || below(b, a).is_some()
}

fn busy_entry() -> ApiError {
    ApiError(
        StatusCode::CONFLICT,
        "A file here is busy or still being matched to its document. Retry after its save finishes."
            .into(),
    )
}

fn pending_entry() -> ApiError {
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "A file move is being recovered. Try again shortly.".into(),
    )
}

/// What one observation shows at a document's path.
#[derive(Clone, Debug, PartialEq)]
enum Seen<E> {
    /// A regular file, with its evidence when it carries any.
    File(Option<E>),
    Absent,
    /// Unreadable, or changed while the tree was walked.
    Unknown,
}

/// An active document without a pending rename.
struct Tracked<E> {
    id: String,
    path: String,
    recorded: Option<E>,
    seen: Seen<E>,
    /// When a pass first saw its name without its own file, until a pass
    /// sees the document at its name again.
    gap: Option<i64>,
}

struct Move<E> {
    id: String,
    from: String,
    to: String,
    evidence: E,
}

/// A document whose own file is nowhere in the observation.
struct Missing<E> {
    id: String,
    path: String,
    seen: Seen<E>,
    /// Its own recorded evidence, which a second look may still find.
    evidence: Option<E>,
}

struct Plan<E> {
    moves: Vec<Move<E>>,
    /// New evidence for documents that keep their path.
    records: Vec<(String, Option<E>)>,
    missing: Vec<Missing<E>>,
    /// Documents this observation could not decide.
    undecided: Vec<String>,
}

/// Decide where every tracked document is from evidence alone, never from
/// names or text. Recorded evidence found at one path places its document
/// there, even over another document's row. A path keeps its document only
/// when its file carries evidence that no other document has recorded and
/// no other document's path shows, or none: that is how atomic saves keep
/// their identity. A document in `lapsed`, whose name was seen empty before
/// the settle window, no longer keeps a different file there. Evidence
/// recorded for two documents, copies, hard links and files seen at two
/// paths never transfer a document. `pending` is evidence of documents whose
/// rename is pending; `files` holds only files no other name links to.
fn classify<E: Clone + Eq + Hash>(
    tracked: &[Tracked<E>],
    pending: &[(&str, &E)],
    files: &HashMap<String, Option<E>>,
    lapsed: &HashSet<&str>,
) -> Plan<E> {
    let mut recorded: HashMap<&E, Vec<&str>> = HashMap::new();
    for document in tracked {
        if let Some(evidence) = &document.recorded {
            recorded.entry(evidence).or_default().push(&document.id);
        }
    }
    for (id, evidence) in pending {
        recorded.entry(*evidence).or_default().push(id);
    }
    // Older versions could record one file for two documents. Such evidence
    // identifies neither; each is placed by its path instead.
    let owner: HashMap<&E, &str> = recorded
        .into_iter()
        .filter_map(|(evidence, ids)| (ids.len() == 1).then(|| (evidence, ids[0])))
        .collect();
    let mut found: HashMap<&E, Vec<&str>> = HashMap::new();
    for (path, evidence) in files {
        if let Some(evidence) = evidence {
            found.entry(evidence).or_default().push(path);
        }
    }
    // One file linked at two documents' names is an atomic save of neither.
    let mut shown: HashMap<&E, usize> = HashMap::new();
    for document in tracked {
        if let Seen::File(Some(evidence)) = &document.seen {
            *shown.entry(evidence).or_default() += 1;
        }
    }
    let mut plan = Plan {
        moves: Vec::new(),
        records: Vec::new(),
        missing: Vec::new(),
        undecided: Vec::new(),
    };
    for document in tracked {
        let own = document
            .recorded
            .as_ref()
            .filter(|evidence| owner.get(evidence) == Some(&document.id.as_str()));
        if document.recorded.is_some() && own.is_none() {
            plan.records.push((document.id.clone(), None));
        }
        if let Some(evidence) = own {
            match found.get(evidence).map(Vec::as_slice) {
                Some([path]) if *path == document.path => continue,
                Some([path]) => {
                    plan.moves.push(Move {
                        id: document.id.clone(),
                        from: document.path.clone(),
                        to: (*path).to_owned(),
                        evidence: evidence.clone(),
                    });
                    continue;
                }
                // Seen at two paths: it moved while the tree was walked.
                Some(_) => {
                    plan.undecided.push(document.id.clone());
                    continue;
                }
                None => {}
            }
        }
        match &document.seen {
            Seen::File(Some(evidence))
                if owner.get(evidence).is_some_and(|id| *id != document.id)
                    || (own != Some(evidence) && shown[evidence] > 1) =>
            {
                plan.missing.push(Missing {
                    id: document.id.clone(),
                    path: document.path.clone(),
                    seen: document.seen.clone(),
                    evidence: own.cloned(),
                });
            }
            Seen::File(evidence)
                if evidence.as_ref() != own && lapsed.contains(document.id.as_str()) =>
            {
                plan.missing.push(Missing {
                    id: document.id.clone(),
                    path: document.path.clone(),
                    seen: document.seen.clone(),
                    evidence: own.cloned(),
                });
            }
            Seen::File(evidence) => {
                if evidence.as_ref() != own {
                    plan.records.push((document.id.clone(), evidence.clone()));
                }
            }
            Seen::Absent => plan.missing.push(Missing {
                id: document.id.clone(),
                path: document.path.clone(),
                seen: Seen::Absent,
                evidence: own.cloned(),
            }),
            Seen::Unknown => plan.undecided.push(document.id.clone()),
        }
    }
    plan
}

/// How the owner's restore pass placed a document that was active or in the
/// trash before it.
pub(super) struct Placement {
    pub(super) id: String,
    /// The path the restored database recorded.
    pub(super) recorded: String,
    /// Its path now, or None once retired or in the trash.
    pub(super) restored: Option<String>,
    /// identity, content, path, retired, trashed when it is in the trash, or
    /// undecided when it is not placed.
    pub(super) evidence: &'static str,
}

pub(super) struct Restoration {
    pub(super) documents: Vec<Placement>,
    /// Restored files no document claims. Discovery indexes each one as a
    /// new private document.
    pub(super) unclaimed: Vec<String>,
    /// Why the pass could not complete, if it could not.
    pub(super) problem: Option<String>,
}

/// Locdoc's trash as the restore pass finds it in the copy.
struct RestoredTrash {
    /// Document files in it with a single name that no trashed document's
    /// row names, by path from the root.
    files: HashMap<String, Option<Identity>>,
    documents: Vec<TrashedDocument>,
    /// Each item's kind, original path and location.
    items: HashMap<String, (EntryKind, String, String)>,
}

/// A trashed document as the restored database records it.
struct TrashedDocument {
    id: String,
    item: String,
    /// The path a restore gives it.
    original: String,
    /// Whether the copy holds anything where its row names its file.
    present: bool,
}

/// What the restore pass changes in the trash.
#[derive(Default)]
struct TrashChanges {
    /// Documents whose text it found only in the trash, which go to the
    /// item holding that text, or move to it within the trash.
    trashed: Vec<Trashing>,
    /// Items for them the database does not know: id, kind, original path
    /// and location.
    items: Vec<(String, EntryKind, String, String)>,
    /// Trashed documents whose text it found outside the trash, with that
    /// file's path and evidence and the path a restore would give them.
    restored: Vec<(String, String, Option<Identity>, String)>,
    /// Items trashed documents leave, which may be left empty.
    left: HashSet<String>,
}
impl TrashChanges {
    fn is_empty(&self) -> bool {
        self.trashed.is_empty() && self.restored.is_empty()
    }
}

/// A document the restore pass puts in the trash.
struct Trashing {
    id: String,
    item: String,
    /// Where its file is in the trash.
    path: String,
    /// The path a restore gives it.
    original: String,
    evidence: Option<Identity>,
    /// Where its media approvals name files from: its row path, or the path
    /// a restore would have given it.
    from: String,
}

/// Turn the restore pass's matches into the trash's changes. A document
/// whose text it found in the trash goes to the item whose folder there
/// holds that text. A known item keeps its kind and paths. One the database
/// does not know is a document item at that document's own path when its
/// folder holds the file itself, or else a folder item at the path most of
/// its documents' paths give, or at the root when none does. A trashed
/// document whose text it found outside the trash comes back there.
fn trash_changes(
    tracked: &[Tracked<Identity>],
    files: &HashMap<String, Option<Identity>>,
    trash: &RestoredTrash,
    matches: &HashMap<String, String>,
) -> TrashChanges {
    let mut changes = TrashChanges::default();
    // Where each document was before it went to the trash.
    let originals: HashMap<&str, &str> = tracked
        .iter()
        .map(|document| (document.id.as_str(), document.path.as_str()))
        .chain(
            trash
                .documents
                .iter()
                .map(|document| (document.id.as_str(), document.original.as_str())),
        )
        .collect();
    let item = |id: &str| {
        trash
            .documents
            .iter()
            .find(|document| document.id == id)
            .map(|document| document.item.clone())
    };
    // The documents found in each item: id, path, entry name, path below it.
    let mut found: HashMap<&str, Vec<(&str, &str, &str, &str)>> = HashMap::new();
    for (id, path) in matches {
        let Some(inside) = below(path, TRASH) else {
            if let Some(item) = item(id) {
                changes.left.insert(item);
                changes.restored.push((
                    id.clone(),
                    path.clone(),
                    files[path].clone(),
                    originals[id.as_str()].to_owned(),
                ));
            }
            continue;
        };
        let mut parts = inside.splitn(3, '/');
        if let (Some(item), Some(name)) = (parts.next(), parts.next()) {
            let rest = parts.next().unwrap_or("");
            found.entry(item).or_default().push((id, path, name, rest));
        }
    }
    for (id, members) in found {
        let (name, folder) = (members[0].2, !members[0].3.is_empty());
        // A delete leaves one entry in its item's folder.
        if members
            .iter()
            .any(|(_, _, other, rest)| *other != name || rest.is_empty() == folder)
        {
            continue;
        }
        let kind = if folder {
            EntryKind::Folder
        } else {
            EntryKind::Document
        };
        let location = format!("{TRASH}/{id}/{name}");
        let original = match trash.items.get(id) {
            Some((known, path, at)) if *known == kind && *at == location => path.clone(),
            Some(_) => continue,
            None if folder => {
                let mut votes: HashMap<&str, usize> = HashMap::new();
                for (document, _, _, rest) in &members {
                    if let Some(parent) = originals[document]
                        .strip_suffix(rest)
                        .and_then(|path| path.strip_suffix('/'))
                    {
                        *votes.entry(parent).or_default() += 1;
                    }
                }
                votes
                    .into_iter()
                    .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(a.0)))
                    .map_or(name, |(path, _)| path)
                    .to_owned()
            }
            None => originals[members[0].0].to_owned(),
        };
        if !trash.items.contains_key(id) {
            changes
                .items
                .push((id.to_owned(), kind, original.clone(), location));
        }
        for (document, path, _, rest) in members {
            changes.left.extend(item(document));
            changes.trashed.push(Trashing {
                id: document.to_owned(),
                item: id.to_owned(),
                path: path.to_owned(),
                original: if folder {
                    format!("{original}/{rest}")
                } else {
                    original.clone()
                },
                evidence: trash.files[path].clone(),
                from: originals[document].to_owned(),
            });
        }
    }
    changes
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pass {
    /// Follow moves and record new evidence. Editors briefly remove or swap
    /// files while saving, so missing documents wait for a settled pass.
    Discover,
    /// Also retire documents that the observation could not find and that
    /// no folder it could not list may hide.
    Settled,
}

/// Active documents as the database records them.
struct Namespace {
    tracked: Vec<Tracked<Identity>>,
    /// Documents whose rename or entry move is still pending, with their
    /// evidence. A pass neither moves nor retires them.
    pending: Vec<(String, Option<Identity>)>,
    /// Trashed documents with their evidence. Their files are in the trash,
    /// where no walk looks, and no other document takes a file of theirs.
    trashed: Vec<(String, Option<Identity>)>,
    /// Paths a pending rename still owns. Nothing moves onto them.
    reserved: HashSet<String>,
}

fn sooner(retry: &mut Option<Duration>, delay: Duration) {
    *retry = Some(retry.map_or(delay, |retry| retry.min(delay)));
}

/// The folders a walk could not list in full. One can hide the file of a
/// document recorded inside it, and any moved file if this process could
/// enter it: a subfolder the walk cannot see may take files.
#[derive(Default)]
struct Unlisted {
    folders: Vec<PathBuf>,
    /// The first of them this process can enter.
    enterable: Option<PathBuf>,
}
impl Unlisted {
    fn add(&mut self, folder: &Path) {
        let path = std::ffi::CString::new(folder.as_os_str().as_bytes());
        let enterable =
            |path: std::ffi::CString| unsafe { libc::access(path.as_ptr(), libc::X_OK) == 0 };
        if self.enterable.is_none() && path.is_ok_and(enterable) {
            self.enterable = Some(folder.to_owned());
        }
        self.folders.push(folder.to_owned());
    }
    fn complete(&self) -> bool {
        self.folders.is_empty()
    }
    /// Whether the file of a document recorded at `path` may be in one.
    fn may_hide(&self, root: &Path, path: &str) -> bool {
        self.hiding(root, path).is_some()
    }
    /// The one that may hide the file of a document recorded at `path`: a
    /// folder holding that path, or else one this process can enter.
    fn hiding(&self, root: &Path, path: &str) -> Option<&Path> {
        let full = root.join(path);
        self.folders
            .iter()
            .find(|folder| full.starts_with(folder))
            .or(self.enterable.as_ref())
            .map(PathBuf::as_path)
    }
}

pub(super) fn migrate(connection: &Connection) -> Result<()> {
    let db = connection.unchecked_transaction()?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS document_moves(
            doc TEXT PRIMARY KEY,source TEXT NOT NULL,destination TEXT NOT NULL UNIQUE,
            device TEXT NOT NULL,inode TEXT NOT NULL,born TEXT);",
    )?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS document_identities(
            doc TEXT PRIMARY KEY,identity TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS document_physical_identity
            ON document_identities(identity);",
    )?;
    // Wall-clock nanoseconds when a pass first saw a document's name
    // without its own file. It outlives restarts so that a later file at
    // that name never continues the document.
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS document_gaps(doc TEXT PRIMARY KEY,since INTEGER NOT NULL);",
    )?;
    let has_move_birth = db
        .prepare("PRAGMA table_info(document_moves)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(std::result::Result::ok)
        .any(|column| column == "born");
    if !has_move_birth {
        db.execute("ALTER TABLE document_moves ADD COLUMN born TEXT", [])?;
    }
    // Folder moves, deletes into the trash and restores, each journaled
    // with the identity of the file or folder it moves. A trash item keeps
    // its original path; each document in it keeps its own, and its row's
    // path names where its file is in the trash.
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS entry_moves(
            id TEXT PRIMARY KEY,action TEXT NOT NULL,kind TEXT NOT NULL,document TEXT,
            source TEXT NOT NULL,destination TEXT NOT NULL UNIQUE,
            device TEXT NOT NULL,inode TEXT NOT NULL,born TEXT);
         CREATE TABLE IF NOT EXISTS trash(
            id TEXT PRIMARY KEY,kind TEXT NOT NULL,path TEXT NOT NULL,
            location TEXT NOT NULL,deleted INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS trashed_documents(
            doc TEXT PRIMARY KEY,trash TEXT NOT NULL,path TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS trashed_documents_item ON trashed_documents(trash);",
    )?;
    db.commit()?;
    Ok(())
}

impl Store {
    /// Look up or allocate the document for one file. Only a pass decides
    /// whose file a changed or moved entry is; a file that no document has
    /// recorded gets a fresh, private identity.
    pub(super) fn index_document(&self, input: &str) -> Result<Document> {
        self.find_document(input, true)
    }

    /// `index_document` for listings, which tabs poll every few seconds: a
    /// file no pass has matched yet is left to the maintenance loop and its
    /// backoff, never matched by walking the tree here.
    pub(super) fn listed_document(&self, input: &str) -> Result<Document> {
        self.find_document(input, false)
    }

    fn find_document(&self, input: &str, discover: bool) -> Result<Document> {
        let _files = self.document_files.lock().unwrap();
        let path = relative_path(input, false)?;
        self.finish_pending_path(&path)?;
        let full = self.safe(&path, false)?;
        let not_found = || ApiError(StatusCode::NOT_FOUND, "Document not found.".into());
        // A file in a state folder kept inside the documents folder is
        // never found, as one in the trash is not.
        if format(&path).is_none() || !full.is_file() || self.in_state(&full) {
            return Err(not_found());
        }
        let observe = || match fs::symlink_metadata(&full) {
            Ok(metadata) => Ok(Identity::of(&metadata)),
            // Removed since it was listed.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(not_found()),
            Err(error) => Err(error.into()),
        };
        let mut evidence = observe()?;
        if !self.assigned(&path, evidence.as_ref())? {
            let discover = discover && !self.awaits_held(&path, evidence.as_ref())?;
            if discover {
                self.reconcile(Pass::Discover)?;
                evidence = observe()?;
            }
            if !discover || !self.assigned(&path, evidence.as_ref())? {
                // A busy room or a move in progress; a later pass decides. A
                // second name for a document's file stays unlisted.
                self.reconciliation.unlisted();
                return Err(ApiError(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "This file is still being matched to its document. Try again shortly.".into(),
                ));
            }
        }
        let id = {
            let mut db = self.db.lock().unwrap();
            let tx = db.transaction()?;
            let indexed = tx
                .query_row(
                    "SELECT id FROM docs WHERE path=? AND active=1",
                    [&path],
                    |r| r.get::<_, String>(0),
                )
                .optional()?;
            let id = match indexed {
                Some(id) => id,
                None => {
                    let id = uuid::Uuid::new_v4().to_string();
                    tx.execute("INSERT INTO docs(id,path) VALUES(?,?)", params![id, path])?;
                    record_identity(&tx, &id, evidence.as_ref())?;
                    id
                }
            };
            tx.commit()?;
            id
        };
        self.doc(&id)
    }

    /// Whether a file no document records is at the name of a document an
    /// unlisted folder holds, born too late to be that document's own save.
    /// A pass could only leave it unlisted until the held document's retry.
    fn awaits_held(&self, path: &str, evidence: Option<&Identity>) -> Result<bool> {
        let gap = self
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT d.id,g.since FROM docs d JOIN document_gaps g ON g.doc=d.id
                 WHERE d.path=? AND d.active=1",
                [path],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;
        let Some((id, since)) = gap else {
            return Ok(false);
        };
        if !self.reconciliation.holds(&id) || continues(since, clock(), evidence) {
            return Ok(false);
        }
        // Another document's file there still tells a pass where it went.
        let Some(Identity(identity)) = evidence else {
            return Ok(true);
        };
        let claimed = self.db.lock().unwrap().query_row(
            "SELECT EXISTS(SELECT 1 FROM document_identities f JOIN docs d ON d.id=f.doc
             WHERE f.identity=? AND d.active=1)",
            [identity],
            |row| row.get::<_, bool>(0),
        )?;
        Ok(!claimed)
    }

    /// Whether the file at an indexed path carries its document's recorded
    /// evidence, or a file at an unindexed path carries no document's. A
    /// trashed document's file stays its own, not a new document, wherever
    /// it turns up; it is free once its document retires.
    fn assigned(&self, path: &str, evidence: Option<&Identity>) -> Result<bool> {
        let db = self.db.lock().unwrap();
        let indexed = db
            .query_row(
                "SELECT f.identity FROM docs d LEFT JOIN document_identities f ON f.doc=d.id
                 WHERE d.path=? AND d.active=1",
                [path],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?;
        Ok(match (indexed, evidence) {
            (Some(recorded), evidence) => {
                recorded.as_deref() == evidence.map(|Identity(identity)| identity.as_str())
            }
            (None, None) => true,
            (None, Some(Identity(identity))) => !db.query_row(
                "SELECT EXISTS(SELECT 1 FROM document_identities f JOIN docs d ON d.id=f.doc
                 WHERE f.identity=? AND d.active IN (1,2))",
                [identity],
                |row| row.get::<_, bool>(0),
            )?,
        })
    }

    /// Only a pass assigns files to documents. Engine paths call this with
    /// the file they opened, before importing from or projecting into it. A
    /// file other than the one recorded for this document stays untouched
    /// until a pass matches it: another document's file after a swap, or a
    /// new file at the name of a document whose own file moved. The
    /// maintenance loop is asked for that pass; this never waits for
    /// document_files.
    pub(super) fn unmatched_file(&self, document: &str, file: &fs::Metadata) -> Result<bool> {
        let recorded = self
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT identity FROM document_identities WHERE doc=?",
                [document],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let unmatched = recorded.map(Identity) != Identity::of(file);
        if unmatched {
            self.reconciliation.unmatched(document);
        }
        Ok(unmatched)
    }

    /// Where a pass found this document's file while its row could not move
    /// there yet. Grants scoped to a folder must cover that path as well as
    /// the row's, so a file moved out of a shared folder is not served on.
    pub(super) fn found_elsewhere(&self, document: &str) -> Option<String> {
        self.reconciliation.elsewhere(document)
    }

    /// Find moves missed while offline or during watcher overflow, and record
    /// atomic saves. Missing documents wait for the maintenance loop.
    pub(super) fn discover_file_moves(&self) -> Result<()> {
        let _files = self.document_files.lock().unwrap();
        self.reconcile(Pass::Discover)?;
        Ok(())
    }

    /// Discovery under a held document_files. Returns the documents whose
    /// file was seen away from their row path but which keep that path for
    /// now; explicit path reuse must not retire them.
    pub(super) fn discover_file_moves_locked(&self) -> Result<HashSet<String>> {
        self.reconcile(Pass::Discover)
    }

    /// The maintenance loop's settled pass, which also retires missing files.
    pub(super) fn retire_missing_documents(&self) -> Result<()> {
        let _files = self.document_files.lock().unwrap();
        self.reconcile(Pass::Settled)?;
        Ok(())
    }

    /// The owner's restore pass, after a backup's database and documents
    /// folder were copied back. Every file is new, so recorded identity
    /// rarely finds one, but it still comes first. A document whose recorded
    /// file is found nowhere then follows its content: a text its durable
    /// state last projected, was writing or still has to project, held by
    /// exactly one file no identity claims, and no other document known to
    /// have that file's text. The file's identity becomes the document's, so
    /// the match outranks path continuity as identity does. Duplicate
    /// contents fall back to paths, and the pass then follows, records and
    /// retires like a settled one. The trash is evidence too: a document
    /// whose text is only in the trash goes back into it, and a trashed one
    /// whose text left it comes back where that text is. It changes nothing
    /// unless it saw and read every file, nor when it would retire every
    /// document. Normal passes never compare content.
    pub(super) fn restore_documents(&self) -> Result<Restoration> {
        let _files = self.document_files.lock().unwrap();
        const PLACED: &str = "SELECT d.id,d.path,f.identity FROM docs d
            LEFT JOIN document_identities f ON f.doc=d.id WHERE d.active IN (1,2)
            ORDER BY d.path";
        let before = self
            .db
            .lock()
            .unwrap()
            .prepare(PLACED)?
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut content = HashMap::new();
        let mut problem = self.restore_pass(&mut content)?;
        let mut documents = Vec::new();
        for (id, recorded, previous) in before {
            const CURRENT: &str = "SELECT d.active,d.path,f.identity FROM docs d
                LEFT JOIN document_identities f ON f.doc=d.id WHERE d.id=?";
            let (active, path, identity) =
                self.db.lock().unwrap().query_row(CURRENT, [&id], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                    ))
                })?;
            let evidence = match active {
                0 => "retired",
                2 => "trashed",
                _ if self.inspect(&path) != Seen::File(identity.clone().map(Identity)) => {
                    "undecided"
                }
                _ if content.contains_key(&id) => "content",
                _ if identity.is_some() && identity == previous => "identity",
                _ => "path",
            };
            documents.push(Placement {
                id,
                recorded,
                restored: (active == 1).then_some(path),
                evidence,
            });
        }
        if problem.is_none() && documents.iter().any(|d| d.evidence == "undecided") {
            problem =
                Some("Some documents could not be placed yet. Run locdoc --restored again.".into());
        }
        Ok(Restoration {
            documents,
            unclaimed: self.unclaimed_files()?,
            problem,
        })
    }

    /// The restore pass under document_files. Returns why it could not
    /// complete; `content` collects the documents placed by content.
    fn restore_pass(&self, content: &mut HashMap<String, String>) -> Result<Option<String>> {
        if !self.root_identity.matches(&self.root) {
            return Ok(Some(
                "The documents folder is unavailable or changed during the restore.".into(),
            ));
        }
        // Restored files are new, so an interrupted rename settles under
        // neither name and its document is placed below. An interrupted
        // folder move, delete or restore settles from where the copy holds
        // its entry, and what it held is placed below too.
        self.settle_restored_entries()?;
        self.settle_intents(false)?;
        let started = clock();
        let Namespace {
            mut tracked,
            pending,
            reserved,
            ..
        } = self.namespace()?;
        if !pending.is_empty() || !self.pending_entries()?.is_empty() {
            return Ok(Some("An interrupted rename could not be settled. Check that every folder can be read, then run locdoc --restored again.".into()));
        }
        for document in &mut tracked {
            document.seen = self.inspect(&document.path);
        }
        let (files, linked, unlisted) = self.survey(&mut tracked);
        let trash = self.restored_trash()?;
        let Some(trash) = trash.filter(|_| {
            unlisted.complete()
                && tracked
                    .iter()
                    .all(|document| document.seen != Seen::Unknown)
        }) else {
            return Ok(Some("Some folders or files in the documents folder could not be read. Fix their permissions, then run locdoc --restored again.".into()));
        };
        let matches = match self.match_contents(&tracked, &files, &linked, &trash) {
            Ok(matches) => matches,
            Err(error) => return Ok(Some(error.1)),
        };
        let changes = trash_changes(&tracked, &files, &trash, &matches);
        // A document going into the trash is no longer placed here.
        tracked.retain(|document| {
            !changes
                .trashed
                .iter()
                .any(|trashed| trashed.id == document.id)
        });
        let moved: HashMap<&str, &str> = matches
            .iter()
            .filter(|(id, _)| tracked.iter().any(|document| &document.id == *id))
            .filter(|(_, path)| below(path, TRASH).is_none())
            .map(|(id, path)| (id.as_str(), path.as_str()))
            .collect();
        for document in &mut tracked {
            if let Some(path) = moved.get(document.id.as_str()) {
                document.recorded = files[*path].clone();
            }
        }
        // A trashed document coming back owns its file as a pending rename
        // does, so no document whose name it has keeps it.
        let returning: Vec<(&str, &Identity)> = changes
            .restored
            .iter()
            .filter_map(|(id, _, evidence, _)| Some((id.as_str(), evidence.as_ref()?)))
            .collect();
        // Every restored file is new, so an earlier gap is no evidence here.
        let mut plan = classify(&tracked, &returning, &files, &HashSet::new());
        self.confirm_missing(&mut plan, &unlisted);
        if !plan.undecided.is_empty() {
            return Ok(Some(
                "Some files changed while the restore pass looked at them. Run locdoc --restored again.".into(),
            ));
        }
        // Retiring revokes links. A copy holding none of the documents is an
        // empty or wrong backup, not a workspace whose every file was removed.
        if !tracked.is_empty() && plan.missing.len() == tracked.len() && changes.is_empty() {
            return Ok(Some(format!(
                "The restored documents folder holds none of the {} documents. Check that the backup copied the documents folder, then run locdoc --restored again.",
                tracked.len()
            )));
        }
        // A matched document records its file now, even if its move waits.
        for (id, path) in &moved {
            plan.records.retain(|(record, _)| record != id);
            plan.records.push(((*id).to_owned(), files[*path].clone()));
        }
        content.extend(
            moved
                .iter()
                .map(|(id, path)| ((*id).to_owned(), (*path).to_owned())),
        );
        content.extend(
            changes
                .restored
                .iter()
                .map(|(id, path, ..)| (id.clone(), path.clone())),
        );
        // Restored images are new files too. Identify each approval where its
        // document's row places it, or a trashed one's restore would, so a
        // move pins what stayed behind.
        let rows: Vec<(&str, &str)> = tracked
            .iter()
            .map(|document| (document.id.as_str(), document.path.as_str()))
            .chain(
                changes
                    .trashed
                    .iter()
                    .map(|trashed| (trashed.id.as_str(), trashed.from.as_str())),
            )
            .chain(
                changes
                    .restored
                    .iter()
                    .map(|(id, _, _, from)| (id.as_str(), from.as_str())),
            )
            .collect();
        self.refresh_media_identities(&rows)?;
        // Rows going to the trash first leave paths active documents may
        // take; trashed documents come back once those have left theirs.
        self.commit_trashed(&changes)?;
        self.apply(Pass::Settled, plan, &tracked, &reserved, &unlisted, started)?;
        self.commit_restored(&changes)?;
        Ok(None)
    }

    /// The restore pass settles each journaled folder move, delete or restore
    /// from where the copy holds its entry, since no restored file has the
    /// journaled identity. Found at its destination and not at its source,
    /// it commits; otherwise the intent ends. Nothing moves either way.
    fn settle_restored_entries(&self) -> Result<()> {
        for movement in self.pending_entries()? {
            let holds = |path: &str| -> Result<bool> {
                let Some(full) = self.entry_path(path)? else {
                    return Ok(false);
                };
                match fs::symlink_metadata(full) {
                    Ok(metadata) => Ok(match movement.entry {
                        EntryKind::Document => metadata.is_file(),
                        EntryKind::Folder => metadata.is_dir(),
                    }),
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                        ) =>
                    {
                        Ok(false)
                    }
                    Err(error) => Err(error.into()),
                }
            };
            let settled = holds(&movement.destination).and_then(|moved| {
                if moved && !holds(&movement.source)? {
                    self.finish_entry(&movement)
                } else {
                    self.drop_entry(&movement)
                }
            });
            // A move left pending keeps the pass from completing.
            if let Err(error) = settled {
                let action = movement.action.as_str();
                tracing::debug!(path = movement.source, "{action} still pending: {error}");
            }
        }
        Ok(())
    }

    /// One pass under document_files. A busy room or an undecidable file
    /// defers only that document and asks the maintenance loop to retry.
    /// Returns the documents left unplaced, as `discover_file_moves_locked`.
    /// A settled pass also retires trashed documents whose files a desktop
    /// application removed from the trash.
    fn reconcile(&self, pass: Pass) -> Result<HashSet<String>> {
        let unplaced = self.reconcile_tree(pass)?;
        if pass == Pass::Settled
            && let Err(error) = self.settle_trash()
        {
            tracing::debug!("trash check pending: {error}");
            self.reconciliation.after(INCOMPLETE_RETRY);
        }
        Ok(unplaced)
    }

    fn reconcile_tree(&self, pass: Pass) -> Result<HashSet<String>> {
        if !self.root_identity.matches(&self.root) {
            // A missing mount is never evidence about its documents.
            return Ok(HashSet::new());
        }
        self.settle_intents(false)?;
        // Taken before observing, so a file created after any observation of
        // this pass was born after it.
        let started = clock();
        let Namespace {
            mut tracked,
            pending,
            trashed,
            reserved,
        } = self.namespace()?;
        // Walk only when a tracked path no longer shows its recorded evidence.
        let mut changed = false;
        for document in &mut tracked {
            document.seen = self.inspect(&document.path);
            changed |= document.seen != Seen::Unknown
                && document.seen != Seen::File(document.recorded.clone());
        }
        if !changed {
            // Every readable path shows its own file; an unreadable one tells
            // nothing new about where its file was found.
            let unknown: HashSet<&str> = tracked
                .iter()
                .filter(|document| document.seen == Seen::Unknown)
                .map(|document| document.id.as_str())
                .collect();
            self.reconciliation.keep_found(|id| unknown.contains(id));
            let observed: Vec<&Tracked<Identity>> = tracked
                .iter()
                .filter(|document| document.seen != Seen::Unknown)
                .collect();
            self.observed_in_place(&observed)?;
            return Ok(HashSet::new());
        }
        let (files, _, unlisted) = self.survey(&mut tracked);
        // A trashed document's file found in the tree is still its own, as a
        // pending rename's is: no other document takes it as an atomic save.
        let held: Vec<(&str, &Identity)> = pending
            .iter()
            .chain(&trashed)
            .filter_map(|(id, evidence)| Some((id.as_str(), evidence.as_ref()?)))
            .collect();
        let lapsed: HashSet<&str> = tracked
            .iter()
            .filter(|document| match (&document.seen, document.gap) {
                (Seen::File(evidence), Some(since)) => {
                    *evidence != document.recorded && !continues(since, started, evidence.as_ref())
                }
                _ => false,
            })
            .map(|document| document.id.as_str())
            .collect();
        let mut plan = classify(&tracked, &held, &files, &lapsed);
        if pass == Pass::Settled {
            self.confirm_missing(&mut plan, &unlisted);
        }
        self.apply(pass, plan, &tracked, &reserved, &unlisted, started)
    }

    /// Walk the tree and settle what each tracked path shows, given what
    /// `inspect` saw there first. Returns the files no other name links to,
    /// the evidence of files that have other names, and the folders it could
    /// not list.
    fn survey(
        &self,
        tracked: &mut [Tracked<Identity>],
    ) -> (
        HashMap<String, Option<Identity>>,
        HashSet<Identity>,
        Unlisted,
    ) {
        let (mut files, mut linked, unlisted) = self.walk();
        for document in tracked.iter_mut() {
            let walked = files.get(&document.path).cloned();
            document.seen = match (&document.seen, walked) {
                (Seen::Unknown, _) => Seen::Unknown,
                (_, Some(evidence)) => Seen::File(evidence),
                (Seen::Absent, None) => Seen::Absent,
                // An unlisted folder, or a move during the walk. Only a second
                // look at the same file counts as seeing it.
                (seen, None) => {
                    let (again, aliased) = self.observe(&document.path);
                    if again == *seen {
                        if let Seen::File(evidence) = seen {
                            files.insert(document.path.clone(), evidence.clone());
                            if aliased {
                                linked.insert(document.path.clone());
                            }
                        }
                        seen.clone()
                    } else {
                        Seen::Unknown
                    }
                }
            };
        }
        // A linked file still tells each document whose file is at its path,
        // but not which of its names a moved document now has.
        let aliased = linked
            .iter()
            .filter_map(|path| files.remove(path).flatten())
            .collect();
        (files, aliased, unlisted)
    }

    /// A file moved between folders during the walk is in neither listing.
    /// Retire only what a second walk cannot find either. A document whose
    /// file a folder the first walk could not list may hide waits for it.
    fn confirm_missing(&self, plan: &mut Plan<Identity>, unlisted: &Unlisted) {
        let candidate = |missing: &Missing<Identity>| {
            missing.evidence.is_some() && !unlisted.may_hide(&self.root, &missing.path)
        };
        if !plan.missing.iter().any(candidate) {
            return;
        }
        let (again, again_linked, still) = self.walk();
        let present: HashSet<&Identity> = again
            .iter()
            .filter(|(path, _)| !again_linked.contains(*path))
            .filter_map(|(_, evidence)| evidence.as_ref())
            .collect();
        plan.missing.retain(|missing| {
            // The others retire or wait in `apply` whatever this walk shows.
            let Some(evidence) = missing.evidence.as_ref().filter(|_| candidate(missing)) else {
                return true;
            };
            let gone = !still.may_hide(&self.root, &missing.path) && !present.contains(evidence);
            if !gone {
                plan.undecided.push(missing.id.clone());
            }
            gone
        });
    }

    /// Documents a pass saw at their own name, with their own file or one it
    /// accepted there. Their gap ends, and their approved media is matched
    /// to the files it now resolves to.
    fn observed_in_place(&self, documents: &[&Tracked<Identity>]) -> Result<()> {
        let returned: Vec<&str> = documents
            .iter()
            .filter(|document| document.gap.is_some())
            .map(|document| document.id.as_str())
            .collect();
        if !returned.is_empty() {
            let mut db = self.db.lock().unwrap();
            let tx = db.transaction()?;
            for id in returned {
                tx.execute("DELETE FROM document_gaps WHERE doc=?", [id])?;
            }
            tx.commit()?;
        }
        let folders: Vec<(&str, &str)> = documents
            .iter()
            .map(|document| (document.id.as_str(), document.path.as_str()))
            .collect();
        if let Err(error) = self.refresh_media_identities(&folders) {
            tracing::debug!("media identities pending: {error}");
        }
        Ok(())
    }

    fn namespace(&self) -> Result<Namespace> {
        const DOCUMENTS: &str = "SELECT d.id,d.path,f.identity,m.destination,g.since FROM docs d
            LEFT JOIN document_identities f ON f.doc=d.id
            LEFT JOIN document_moves m ON m.doc=d.id
            LEFT JOIN document_gaps g ON g.doc=d.id WHERE d.active=1";
        let rows = self
            .db
            .lock()
            .unwrap()
            .prepare(DOCUMENTS)?
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        const TRASHED: &str = "SELECT d.id,f.identity FROM docs d
            LEFT JOIN document_identities f ON f.doc=d.id WHERE d.active=2";
        let trashed = self
            .db
            .lock()
            .unwrap()
            .prepare(TRASHED)?
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?.map(Identity),
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let entries = self.pending_entries()?;
        let mut namespace = Namespace {
            tracked: Vec::new(),
            pending: Vec::new(),
            trashed,
            reserved: HashSet::new(),
        };
        for (id, path, identity, destination, gap) in rows {
            let recorded = identity.map(Identity);
            let entry = entries.iter().find(|entry| entry.carries(&id, &path));
            match (destination, entry) {
                (Some(destination), _) => {
                    namespace.reserved.extend([path, destination]);
                    namespace.pending.push((id, recorded));
                }
                // Its folder move, delete or restore settles it first.
                (None, Some(entry)) => {
                    let moved = rebase(&path, &entry.source, &entry.destination);
                    namespace.reserved.extend(moved);
                    namespace.reserved.insert(path);
                    namespace.pending.push((id, recorded));
                }
                (None, None) => namespace.tracked.push(Tracked {
                    id,
                    path,
                    recorded,
                    seen: Seen::Unknown,
                    gap,
                }),
            }
        }
        // A pending restore brings its documents back to their own paths.
        for entry in entries
            .iter()
            .filter(|entry| entry.action == Action::Restore)
        {
            namespace.reserved.extend(
                self.db
                    .lock()
                    .unwrap()
                    .prepare("SELECT path FROM trashed_documents WHERE trash=?")?
                    .query_map([&entry.id], |row| row.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?,
            );
        }
        Ok(namespace)
    }

    /// What a tracked path shows. Inaccessibility is never evidence of a move.
    fn inspect(&self, path: &str) -> Seen<Identity> {
        self.observe(path).0
    }

    /// What a path shows, and whether other names link to its file.
    fn observe(&self, path: &str) -> (Seen<Identity>, bool) {
        let Ok(full) = self.safe(path, false) else {
            return (Seen::Unknown, false);
        };
        match fs::symlink_metadata(full) {
            Ok(metadata) if metadata.is_file() => {
                (Seen::File(Identity::of(&metadata)), metadata.nlink() > 1)
            }
            // A file in place of one of the path's folders is as conclusive
            // as nothing there.
            Err(error)
                if !matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                (Seen::Unknown, false)
            }
            _ => (Seen::Absent, false),
        }
    }

    /// Walk the tree once, never following symlinks or entering dot folders
    /// or the state folder. An entry that vanishes is skipped; a folder that
    /// cannot be listed in full is reported rather than failing the pass,
    /// except the root's lost+found, which fsck owns. Also returns the files
    /// that other names link to.
    fn walk(&self) -> (HashMap<String, Option<Identity>>, HashSet<String>, Unlisted) {
        self.walk_from(self.root.clone())
    }

    /// `walk` from a folder below the root, with paths still from the root.
    fn walk_from(
        &self,
        start: PathBuf,
    ) -> (HashMap<String, Option<Identity>>, HashSet<String>, Unlisted) {
        let mut files = HashMap::new();
        let mut linked = HashSet::new();
        let mut unlisted = Unlisted::default();
        let fsck = self.root.join("lost+found");
        let mut folders = vec![start];
        while let Some(folder) = folders.pop() {
            let children = match walk_step(&folder).and_then(|()| fs::read_dir(&folder)) {
                Ok(children) => children,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    if folder != fsck {
                        unlisted.add(&folder);
                    }
                    continue;
                }
            };
            let mut partial = false;
            for child in children {
                let Ok(child) = child else {
                    partial = true;
                    continue;
                };
                // Document paths are UTF-8 and never hidden.
                let name = child.file_name();
                if name.to_str().is_none_or(|name| name.starts_with('.')) {
                    continue;
                }
                let path = child.path();
                match walk_step(&path).and_then(|()| fs::symlink_metadata(&path)) {
                    Ok(metadata) if metadata.is_dir() && self.in_state(&path) => {}
                    Ok(metadata) if metadata.is_dir() => folders.push(path),
                    Ok(metadata) if metadata.is_file() => {
                        if let Some(relative) =
                            path.strip_prefix(&self.root).ok().and_then(Path::to_str)
                            && format(relative).is_some()
                        {
                            files.insert(relative.to_owned(), Identity::of(&metadata));
                            if metadata.nlink() > 1 {
                                linked.insert(relative.to_owned());
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    // An entry it cannot inspect could be a folder holding anything.
                    Err(_) => partial = true,
                }
            }
            if partial && folder != fsck {
                unlisted.add(&folder);
            }
        }
        (files, linked, unlisted)
    }

    /// For a restore only: pair each document whose recorded file is found
    /// nowhere with the one unclaimed file holding a text it is known to have
    /// had, when no other document is known to have that file's text. A file
    /// that cannot be read could hold a duplicate, so it fails the pass. A
    /// file with other names is still found: its document never follows a
    /// copy, though the link cannot show where it moved. Trashed documents
    /// take part as well: each owns its texts, and one whose file is not
    /// where its row names it in the trash is lost. Files in the trash that
    /// no trashed document's row names can be matched too.
    fn match_contents(
        &self,
        tracked: &[Tracked<Identity>],
        files: &HashMap<String, Option<Identity>>,
        linked: &HashSet<Identity>,
        trash: &RestoredTrash,
    ) -> Result<HashMap<String, String>> {
        let found: HashSet<&Identity> = files.values().flatten().chain(linked).collect();
        let lost = |document: &Tracked<Identity>| {
            document
                .recorded
                .as_ref()
                .is_none_or(|evidence| !found.contains(evidence))
        };
        if !tracked.iter().any(lost) && trash.documents.iter().all(|document| document.present) {
            return Ok(HashMap::new());
        }
        let mut owners: HashMap<String, HashSet<&str>> = HashMap::new();
        let mut wanted = Vec::new();
        let documents = tracked
            .iter()
            .map(|document| (document.id.as_str(), lost(document)))
            .chain(
                trash
                    .documents
                    .iter()
                    .map(|document| (document.id.as_str(), !document.present)),
            );
        for (id, lost) in documents {
            // Empty files are common and unrelated; a blank text identifies
            // no file.
            let digests: HashSet<String> = self
                .known_contents(id)?
                .iter()
                .filter(|text| !text.trim().is_empty())
                .map(|text| hash(text))
                .collect();
            for digest in &digests {
                owners.entry(digest.clone()).or_default().insert(id);
            }
            if lost {
                wanted.push((id, digests));
            }
        }
        let claimed: HashSet<&Identity> = tracked
            .iter()
            .filter_map(|document| document.recorded.as_ref())
            .collect();
        let mut holders: HashMap<String, Vec<&str>> = HashMap::new();
        let mut held = HashMap::new();
        let unclaimed = files
            .iter()
            .filter(|(_, evidence)| {
                evidence
                    .as_ref()
                    .is_none_or(|evidence| !claimed.contains(evidence))
            })
            .chain(&trash.files);
        for (path, evidence) in unclaimed {
            if let Some(text) = self.restored_text(path, evidence.as_ref())? {
                let digest = hash(&text);
                holders.entry(digest.clone()).or_default().push(path);
                held.insert(path.as_str(), digest);
            }
        }
        let mut matches = HashMap::new();
        for (id, digests) in wanted {
            let candidates: HashSet<&str> = digests
                .iter()
                .filter_map(|digest| holders.get(digest))
                .flatten()
                .copied()
                .collect();
            let [path] = candidates.into_iter().collect::<Vec<_>>()[..] else {
                continue;
            };
            // Only a file with an identity can become the document's.
            let evidence = files.get(path).or_else(|| trash.files.get(path));
            if evidence.is_some_and(Option::is_some) && owners[&held[path]].len() == 1 {
                matches.insert(id.to_owned(), path.to_owned());
            }
        }
        Ok(matches)
    }

    /// The trash as the restore pass reads it, or None when a folder or file
    /// in it cannot be read. It is walked as the documents folder is.
    fn restored_trash(&self) -> Result<Option<RestoredTrash>> {
        let (rows, items) = {
            let db = self.db.lock().unwrap();
            let rows = db
                .prepare(
                    "SELECT d.id,d.path,t.trash,t.path FROM docs d
                     JOIN trashed_documents t ON t.doc=d.id WHERE d.active=2",
                )?
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let items = db
                .prepare("SELECT id,kind,path,location FROM trash")?
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            (rows, items)
        };
        let folder = self.root.join(TRASH);
        let (mut files, linked, unlisted) = match fs::symlink_metadata(&folder) {
            Ok(metadata) if metadata.is_dir() => self.walk_from(folder),
            // Nothing else holds deleted files.
            Ok(_) => Default::default(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Default::default(),
            Err(_) => return Ok(None),
        };
        if !unlisted.complete() {
            return Ok(None);
        }
        for path in &linked {
            files.remove(path);
        }
        let mut documents = Vec::new();
        for (id, path, item, original) in rows {
            let present = match self.trashed_seen(&path) {
                Seen::Unknown => return Ok(None),
                Seen::Absent => false,
                // Whatever is there stays its own, as a path keeps its file.
                Seen::File(_) => {
                    files.remove(&path);
                    true
                }
            };
            documents.push(TrashedDocument {
                id,
                item,
                original,
                present,
            });
        }
        let items = items
            .into_iter()
            .filter_map(|(id, kind, path, location)| {
                Some((id, (EntryKind::parse(&kind)?, path, location)))
            })
            .collect();
        Ok(Some(RestoredTrash {
            files,
            documents,
            items,
        }))
    }

    /// Put the documents the restore pass found only in the trash there, in
    /// one transaction, before it moves or retires active documents.
    fn commit_trashed(&self, changes: &TrashChanges) -> Result<()> {
        if changes.trashed.is_empty() {
            return Ok(());
        }
        // When its entry went into the trash, as the item's folder shows.
        let deleted = |item: &str| {
            fs::symlink_metadata(self.root.join(TRASH).join(item))
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or_else(now, |time| time.as_secs() as i64)
        };
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        for (id, kind, path, location) in &changes.items {
            tx.execute(
                "INSERT OR IGNORE INTO trash(id,kind,path,location,deleted) VALUES(?,?,?,?,?)",
                params![id, kind.as_str(), path, location, deleted(id)],
            )?;
        }
        for trashed in &changes.trashed {
            // As for a delete, an active document starts a new incarnation.
            let updated = tx.execute(
                "UPDATE docs SET path=?,active=2,
                 incarnation=CASE WHEN active=1 THEN incarnation+1 ELSE incarnation END
                 WHERE id=? AND active IN (1,2)",
                params![trashed.path, trashed.id],
            )?;
            if updated != 1 {
                return Err(bad("A document identity changed during the restore."));
            }
            tx.execute(
                "INSERT INTO trashed_documents(doc,trash,path) VALUES(?,?,?)
                 ON CONFLICT(doc) DO UPDATE SET trash=excluded.trash,path=excluded.path",
                params![trashed.id, trashed.item, trashed.original],
            )?;
            tx.execute("DELETE FROM document_gaps WHERE doc=?", [&trashed.id])?;
            record_identity(&tx, &trashed.id, trashed.evidence.as_ref())?;
            self.reanchor_restored_media(&tx, &trashed.id, &trashed.from, &trashed.original)?;
        }
        tx.commit()?;
        drop(db);
        self.permissions.invalidate();
        Ok(())
    }

    /// A document the restore pass places in another folder than the one its
    /// media approvals name files from moved as a pass would move it: they
    /// are checked against the files they resolved to there, so they never
    /// lend the new folder another image with their spelling.
    fn reanchor_restored_media(
        &self,
        tx: &rusqlite::Transaction<'_>,
        id: &str,
        from: &str,
        to: &str,
    ) -> Result<()> {
        if Path::new(from).parent() == Path::new(to).parent() {
            return Ok(());
        }
        let document = tx.query_row(
            "SELECT permission,token FROM docs WHERE id=?",
            [id],
            |row| {
                Ok(Document {
                    id: id.to_owned(),
                    path: from.to_owned(),
                    permission: row.get(0)?,
                    token: row.get(1)?,
                })
            },
        )?;
        self.reanchor_moved_media(tx, &document, to)
    }

    /// Bring back the trashed documents the restore pass found outside the
    /// trash, once it has moved and retired active documents, as a restore
    /// does. An item the pass left with no document and nothing at its
    /// location leaves the trash, a folder's links and grants back at its
    /// path.
    fn commit_restored(&self, changes: &TrashChanges) -> Result<()> {
        if changes.restored.is_empty() && changes.left.is_empty() {
            return Ok(());
        }
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        for (id, path, evidence, from) in &changes.restored {
            vacate(&tx, path, id)?;
            let updated = tx.execute(
                "UPDATE docs SET active=1,path=? WHERE id=? AND active=2",
                params![path, id],
            )?;
            if updated != 1 {
                return Err(bad("A document identity changed during the restore."));
            }
            tx.execute("DELETE FROM trashed_documents WHERE doc=?", [id])?;
            record_identity(&tx, id, evidence.as_ref())?;
            self.reanchor_restored_media(&tx, id, from, path)?;
        }
        for item in &changes.left {
            let documents: i64 = tx.query_row(
                "SELECT count(*) FROM trashed_documents t JOIN docs d ON d.id=t.doc
                 WHERE t.trash=? AND d.active=2",
                [item],
                |row| row.get(0),
            )?;
            let entry = tx
                .query_row(
                    "SELECT kind,path,location FROM trash WHERE id=?",
                    [item],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()?;
            let Some((kind, original, location)) = entry else {
                continue;
            };
            if documents > 0 || self.trashed_seen(&location) != Seen::Absent {
                continue;
            }
            if EntryKind::parse(&kind) == Some(EntryKind::Folder) {
                rebase_rows(&tx, "folder_shares", &location, &original)?;
                rebase_rows(&tx, "mcp_folders", &location, &original)?;
                self.rebase_grants(&tx, &location, &original)?;
            }
            tx.execute("DELETE FROM trash WHERE id=?", [item])?;
        }
        tx.commit()?;
        drop(db);
        self.permissions.invalidate();
        Ok(())
    }

    /// A restored file's text as an import reads it, or None when it cannot
    /// be a document's: over the size limit or not UTF-8.
    fn restored_text(&self, path: &str, evidence: Option<&Identity>) -> Result<Option<String>> {
        use std::io::Read;
        use std::os::unix::fs::OpenOptionsExt;
        let unreadable = |reason: String| {
            ApiError(
                StatusCode::CONFLICT,
                format!(
                    "Could not read {path}: {reason}. Fix it, then run locdoc --restored again."
                ),
            )
        };
        let full = self
            .safe(path, below(path, TRASH).is_some())
            .map_err(|error| unreadable(error.1))?;
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(full)
            .map_err(|error| unreadable(error.to_string()))?;
        let metadata = file
            .metadata()
            .map_err(|error| unreadable(error.to_string()))?;
        if !metadata.is_file()
            || evidence.is_some_and(|evidence| Identity::of(&metadata).as_ref() != Some(evidence))
        {
            return Err(unreadable("it changed during the restore".into()));
        }
        let mut bytes = Vec::new();
        file.take((5 * MB + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| unreadable(error.to_string()))?;
        if bytes.len() > 5 * MB {
            return Ok(None);
        }
        Ok(String::from_utf8(bytes)
            .ok()
            .map(|raw| text::canonical(&raw)))
    }

    /// Document files a walk finds that no active document records, by path
    /// or by identity.
    fn unclaimed_files(&self) -> Result<Vec<String>> {
        let (files, _, _) = self.walk();
        let db = self.db.lock().unwrap();
        let paths: HashSet<String> = db
            .prepare("SELECT path FROM docs WHERE active=1")?
            .query_map([], |row| row.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        let identities: HashSet<String> = db
            .prepare(
                "SELECT f.identity FROM document_identities f
                 JOIN docs d ON d.id=f.doc WHERE d.active=1",
            )?
            .query_map([], |row| row.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        let mut unclaimed: Vec<String> = files
            .into_iter()
            .filter(|(path, evidence)| {
                !paths.contains(path)
                    && evidence
                        .as_ref()
                        .is_none_or(|Identity(identity)| !identities.contains(identity))
            })
            .map(|(path, _)| path)
            .collect();
        unclaimed.sort();
        Ok(unclaimed)
    }

    /// Apply a plan in one transaction. A busy room, a failed preparation or
    /// a file that changed since it was observed defers that document, and
    /// with it any move onto the path it keeps. Returns the documents that
    /// were found elsewhere or undecided and keep their row path for now.
    fn apply(
        &self,
        pass: Pass,
        plan: Plan<Identity>,
        tracked: &[Tracked<Identity>],
        reserved: &HashSet<String>,
        unlisted: &Unlisted,
        started: i64,
    ) -> Result<HashSet<String>> {
        let unsettled: HashSet<&str> = plan
            .missing
            .iter()
            .map(|missing| missing.id.as_str())
            .chain(plan.undecided.iter().map(String::as_str))
            .chain(plan.moves.iter().map(|change| change.id.as_str()))
            .collect();
        let observed: Vec<&Tracked<Identity>> = tracked
            .iter()
            .filter(|document| {
                matches!(document.seen, Seen::File(_)) && !unsettled.contains(document.id.as_str())
            })
            .collect();
        // A name seen without its own file opens a gap, kept until a pass
        // sees the document at its name again or finds its file elsewhere.
        let opened: Vec<String> = tracked
            .iter()
            .filter(|document| {
                document.gap.is_none()
                    && plan.missing.iter().any(|missing| missing.id == document.id)
            })
            .map(|document| document.id.clone())
            .collect();
        drop(unsettled);
        let Plan {
            mut moves,
            records,
            missing,
            undecided,
        } = plan;
        let mut retry = (!undecided.is_empty()).then_some(RETRY);
        let mut unplaced: HashSet<String> = undecided
            .into_iter()
            .chain(moves.iter().map(|change| change.id.clone()))
            .collect();
        // Until its row follows, a moved file is also where it was found.
        // Sockets recheck folder grants against that place now, not at the
        // next heartbeat.
        let mut elsewhere: HashMap<String, String> = moves
            .iter()
            .map(|change| (change.id.clone(), change.to.clone()))
            .collect();
        if self.reconciliation.found(elsewhere.clone()) {
            self.permissions.invalidate();
        }
        // An unlisted folder can only hide a file whose evidence a later walk
        // could find. Without evidence, waiting would keep a removed
        // document's links alive for whatever file next takes its name.
        let (waiting, mut retiring): (Vec<_>, Vec<_>) = missing.into_iter().partition(|missing| {
            missing.evidence.is_some() && unlisted.may_hide(&self.root, &missing.path)
        });
        if !waiting.is_empty() {
            sooner(&mut retry, INCOMPLETE_RETRY);
        }
        if pass != Pass::Settled && !retiring.is_empty() {
            sooner(&mut retry, RETRY);
            retiring.clear();
        }
        self.reconciliation.hold(
            waiting
                .into_iter()
                .filter_map(|missing| {
                    let folder = unlisted.hiding(&self.root, &missing.path)?.to_owned();
                    Some((missing.id, folder))
                })
                .collect(),
        );
        // Map before room, and never wait for a room: a busy one defers.
        let rooms: Vec<(String, Arc<Mutex<Room>>)> = {
            let cached = self.rooms.lock().unwrap();
            moves
                .iter()
                .map(|change| &change.id)
                .chain(retiring.iter().map(|missing| &missing.id))
                .filter_map(|id| Some((id.clone(), cached.get(id)?.clone())))
                .collect()
        };
        let mut live = HashMap::new();
        let mut busy = HashSet::new();
        for (id, room) in &rooms {
            match room.try_lock() {
                Ok(room) => {
                    live.insert(id.as_str(), room);
                }
                Err(_) => {
                    busy.insert(id.as_str());
                }
            }
        }
        let mut deferred = !busy.is_empty();
        moves.retain(|change| !busy.contains(change.id.as_str()));
        retiring.retain(|missing| !busy.contains(missing.id.as_str()));
        let mut failure = None;
        retiring.retain(|missing| {
            let Some(room) = live.get_mut(missing.id.as_str()) else {
                return true;
            };
            match self.preserve_for_retirement(&missing.id, room) {
                Ok(()) => true,
                Err(error) => {
                    failure.get_or_insert(error);
                    deferred = true;
                    false
                }
            }
        });
        // A followed move already happened; make it durable before committing
        // it. There is no filesystem step left to journal.
        let mut synced = HashSet::new();
        moves.retain(|change| {
            let durable = [&change.from, &change.to].into_iter().try_for_each(|path| {
                let Ok(full) = self.safe(path, false) else {
                    return Ok(());
                };
                let folder = full.parent().unwrap().to_path_buf();
                if folder.is_dir() && !synced.contains(&folder) {
                    disk::sync_directories(&folder, &self.root)?;
                    synced.insert(folder);
                }
                Ok::<_, ApiError>(())
            });
            if let Err(error) = &durable {
                tracing::warn!(document = change.id, "followed move pending: {error}");
                deferred = true;
            }
            durable.is_ok()
        });
        // Recheck evidence right before committing it.
        moves.retain(|change| {
            let current =
                self.observe(&change.to) == (Seen::File(Some(change.evidence.clone())), false);
            deferred |= !current;
            current
        });
        retiring.retain(|missing| {
            let current = self.inspect(&missing.path) == missing.seen;
            deferred |= !current;
            current
        });
        if deferred {
            sooner(&mut retry, RETRY);
        }
        if !self.root_identity.matches(&self.root) {
            self.reconciliation.after(RETRY);
            return Ok(unplaced);
        }
        self.observed_in_place(&observed)?;
        // A deferred document keeps its path, which blocks any move onto it.
        loop {
            let leaving: HashSet<&str> = moves
                .iter()
                .map(|change| change.id.as_str())
                .chain(retiring.iter().map(|missing| missing.id.as_str()))
                .collect();
            let kept: HashSet<&str> = tracked
                .iter()
                .filter(|document| !leaving.contains(document.id.as_str()))
                .map(|document| document.path.as_str())
                .collect();
            let mut targets: HashMap<&str, usize> = HashMap::new();
            for change in &moves {
                *targets.entry(change.to.as_str()).or_default() += 1;
            }
            let blocked: HashSet<String> = moves
                .iter()
                .filter(|change| {
                    kept.contains(change.to.as_str())
                        || reserved.contains(&change.to)
                        || targets[change.to.as_str()] > 1
                })
                .map(|change| change.id.clone())
                .collect();
            if blocked.is_empty() {
                break;
            }
            if moves
                .iter()
                .any(|change| blocked.contains(&change.id) && reserved.contains(&change.to))
            {
                sooner(&mut retry, RETRY);
            }
            moves.retain(|change| !blocked.contains(&change.id));
        }
        let records: Vec<_> = records
            .into_iter()
            .filter(|(id, _)| !retiring.iter().any(|missing| &missing.id == id))
            .collect();
        if !moves.is_empty() || !retiring.is_empty() || !records.is_empty() || !opened.is_empty() {
            // Media approvals of a document leaving its folder are checked
            // against the files they resolved to there.
            let leaving_folder = moves
                .iter()
                .filter(|change| Path::new(&change.from).parent() != Path::new(&change.to).parent())
                .map(|change| Ok((self.doc(&change.id)?, change.to.as_str())))
                .collect::<Result<Vec<_>>>()?;
            let mut db = self.db.lock().unwrap();
            let tx = db.transaction()?;
            for id in &opened {
                tx.execute(
                    "INSERT OR IGNORE INTO document_gaps(doc,since) VALUES(?,?)",
                    params![id, started],
                )?;
            }
            for missing in &retiring {
                retire(&tx, &missing.id)?;
            }
            // Placeholders let swaps and cycles exchange paths without
            // violating their uniqueness mid-transaction.
            for change in &moves {
                tx.execute(
                    "UPDATE docs SET path=? WHERE id=? AND active=1",
                    params![format!(".moving/{}", change.id), change.id],
                )?;
            }
            for change in &moves {
                // A row an older version retired may still hold a real path.
                tx.execute(
                    "UPDATE docs SET retired_path=COALESCE(retired_path,path),
                     path='.retired/'||id WHERE path=? AND active=0",
                    [&change.to],
                )?;
                let updated = tx.execute(
                    "UPDATE docs SET path=? WHERE id=? AND active=1",
                    params![change.to, change.id],
                )?;
                if updated != 1 {
                    return Err(bad("A document identity changed during discovery."));
                }
                tx.execute("DELETE FROM document_gaps WHERE doc=?", [&change.id])?;
            }
            for (document, destination) in &leaving_folder {
                self.reanchor_moved_media(&tx, document, destination)?;
            }
            for (id, evidence) in &records {
                record_identity(&tx, id, evidence.as_ref())?;
            }
            tx.commit()?;
            drop(db);
            for change in &moves {
                unplaced.remove(&change.id);
                elsewhere.remove(&change.id);
            }
            self.reconciliation.found(elsewhere);
            if !moves.is_empty() || !retiring.is_empty() {
                self.permissions.invalidate();
            }
        }
        // Cache operations acquire map -> room. Release every room before
        // closing retired ones; stale commands reject the inactive identity.
        drop(live);
        for missing in &retiring {
            self.close_document(&missing.id);
        }
        if let Some(delay) = retry {
            self.reconciliation.after(delay);
        }
        failure.map_or(Ok(unplaced), Err)
    }

    /// Keep a retiring room's final accepted text restorable, including edits
    /// still waiting for their projection, before its identity retires.
    fn preserve_for_retirement(&self, id: &str, room: &mut Room) -> Result<()> {
        // A failed comment/restore transaction may still be waiting in the
        // engine. Never evict that buffer merely because its file moved.
        let document = self.doc(id)?;
        room.ensure_committed(self, &document)?;
        let source = room_text(room);
        if room.engine.needs_projection()
            || room.engine.interrupted()
            || source != room.engine.source()
        {
            self.snapshot(&document, &source, true)?;
        }
        Ok(())
    }

    fn close_document(&self, id: &str) {
        let room = self.rooms.lock().unwrap().remove(id);
        if let Some(room) = room
            && let Ok(room) = room.try_lock()
        {
            let _ = room.tx.send(vec![126]);
        }
        // Busy peers observe the invalidated permission generation before
        // their next frame or heartbeat. Closing must never wait on their room.
    }

    pub(super) fn rename_document(&self, id: &str, input: &str) -> Result<()> {
        self.rename_document_checked(id, input, |_, _| Ok(()))
    }

    /// Recheck scoped callers after filesystem discovery and under the same
    /// namespace lock as folder opt-ins and the move itself.
    pub(super) fn rename_document_checked(
        &self,
        id: &str,
        input: &str,
        authorize: impl FnOnce(&Document, &str) -> Result<()>,
    ) -> Result<()> {
        let _files = self.document_files.lock().unwrap();
        self.finish_pending_path(&self.doc(id)?.path)?;
        let unplaced = self.reconcile(Pass::Discover)?;
        let d = self.doc(id)?;
        let path = relative_path(input, false)?;
        self.finish_pending_path(&path)?;
        authorize(&d, &path)?;
        if path == d.path {
            return Ok(());
        }
        if format(&path).is_none() {
            return Err(bad(FORMATS));
        }
        let dest = self.safe(&path, false)?;
        self.not_into_state(&dest)?;
        if !dest.parent().is_some_and(Path::is_dir) {
            return Err(bad("Choose an existing destination folder."));
        }
        if dest.exists() {
            return Err(bad("That path already exists."));
        }
        let source = self.safe(&d.path, false)?;
        let room = self.room(&d)?;
        let mut r = room.lock().unwrap();
        if !r.flush_to_disk(self, &d)? {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "A desktop application has this file open. Finish its save before renaming.".into(),
            ));
        }
        let metadata = fs::symlink_metadata(&source)?;
        // A deferred pass can leave another file at this path; move only ours.
        if !self.assigned(&d.path, Identity::of(&metadata).as_ref())? {
            return Err(changed_during_rename());
        }
        let movement = FileMove::new(id, d.path, path, &metadata);
        let previous = {
            let mut db = self.db.lock().unwrap();
            // Exercise path constraints before committing a filesystem intent.
            // The transaction rolls back; only commit_move publishes it.
            let tx = db.transaction()?;
            let previous = Self::move_identity(&tx, &movement)?;
            tx.rollback()?;
            previous
        };
        // A previous document whose file was found elsewhere follows it once
        // a pass can place it; its name is not free yet.
        if let Some(previous) = previous
            && (unplaced.contains(&previous) || !self.retire_missing_identity(&previous, &dest)?)
        {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "The previous destination is busy or changed. Retry after its save finishes."
                    .into(),
            ));
        }
        self.journal_file_move(&movement)?;
        match disk::rename_new(&source, &dest) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                // The original remains in place. An external app's destination
                // wins; abort our intent without touching it.
                self.drop_intent(&movement)?;
                return Err(bad("That path already exists."));
            }
            Err(error) => {
                // A failed rename normally changes neither name. Settle from
                // what is there rather than leave an intent blocking saves.
                return match self.settle_intent(&movement, false)? {
                    Outcome::Moved => Ok(()),
                    Outcome::Dropped => Err(error.into()),
                };
            }
        }
        if !movement.contains(&dest)? {
            // A desktop save replaced the source after its inode was journaled.
            self.restore_replaced(&movement, &source, &dest)?;
            // Match the replacement now so the document keeps saving to it.
            // A failed pass leaves that to the maintenance loop.
            if let Err(error) = self.reconcile(Pass::Discover) {
                tracing::debug!(document = id, "discovery after a changed rename: {error}");
            }
            return Err(changed_during_rename());
        }
        self.commit_move(&movement)?;
        drop(r);
        Ok(())
    }

    fn journal_file_move(&self, movement: &FileMove) -> Result<()> {
        self.db.lock().unwrap().execute(
            "INSERT INTO document_moves(doc,source,destination,device,inode,born)
                    VALUES(?,?,?,?,?,?)",
            params![
                movement.document,
                movement.source,
                movement.destination,
                movement.device,
                movement.inode,
                movement.born
            ],
        )?;
        Ok(())
    }

    fn move_identity(db: &Connection, movement: &FileMove) -> Result<Option<String>> {
        let previous = db
            .query_row(
                "SELECT id FROM docs WHERE path=? AND id!=?",
                params![movement.destination, movement.document],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(ref previous) = previous {
            retire(db, previous)?;
        }
        let updated = db.execute(
            "UPDATE docs SET path=? WHERE id=? AND active=1 AND path IN (?,?)",
            params![
                movement.destination,
                movement.document,
                movement.source,
                movement.destination
            ],
        )?;
        if updated != 1 {
            return Err(bad("The document identity changed during its rename."));
        }
        Ok(previous)
    }

    /// Settle a journaled rename from what its two names now hold. Every
    /// outcome removes the intent except an I/O error, which retries later;
    /// an intent must never keep its document from saving.
    fn settle_intent(&self, movement: &FileMove, redo: bool) -> Result<Outcome> {
        let current = self
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT path FROM docs WHERE id=? AND active=1",
                [&movement.document],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if current.as_deref() != Some(movement.source.as_str()) {
            // The intent no longer describes its document.
            return self.drop_intent(movement);
        }
        let source = self.journaled(&movement.source)?;
        let destination = self.journaled(&movement.destination)?;
        let holds = |path: &Option<PathBuf>| {
            path.as_deref()
                .map_or(Ok(false), |path| movement.contains(path))
        };
        let at_source = holds(&source)?;
        // Our file at its source under its only name is not at the
        // destination, even when the destination folder cannot be read.
        let only_at_source = at_source
            && source
                .as_deref()
                .and_then(|path| fs::symlink_metadata(path).ok())
                .is_some_and(|metadata| metadata.nlink() == 1);
        let at_destination = !only_at_source && holds(&destination)?;
        match (at_source, at_destination, source, destination) {
            (false, true, _, _) => self.commit_move(movement),
            (true, true, Some(source), _) => {
                // An interrupted legacy hard-link move. Both names refer to
                // exactly our inode, so removing the old alias is safe.
                fs::remove_file(source)?;
                self.commit_move(movement)
            }
            (true, false, Some(source), Some(destination)) if redo => {
                match disk::rename_new(&source, &destination) {
                    Ok(()) if movement.contains(&destination)? => self.commit_move(movement),
                    Ok(()) => self.restore_replaced(movement, &source, &destination),
                    // The original remains in place; an external destination wins.
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        self.drop_intent(movement)
                    }
                    // A failed rename normally leaves both names unchanged.
                    Err(_) => self.settle_intent(movement, false),
                }
            }
            // Still only at its source, or under neither name.
            _ => self.drop_intent(movement),
        }
    }

    /// A journaled path, or None once it no longer resolves safely inside the
    /// root. An unavailable root is an I/O error that retries.
    fn journaled(&self, path: &str) -> Result<Option<PathBuf>> {
        match self.safe(path, false) {
            Ok(path) => Ok(Some(path)),
            Err(error) if error.0 == StatusCode::SERVICE_UNAVAILABLE => Err(error),
            Err(_) => Ok(None),
        }
    }

    fn drop_intent(&self, movement: &FileMove) -> Result<Outcome> {
        self.db.lock().unwrap().execute(
            "DELETE FROM document_moves WHERE doc=?",
            [&movement.document],
        )?;
        // The document may no longer be at its row path; a pass places it.
        self.reconciliation.after(RETRY);
        Ok(Outcome::Dropped)
    }

    /// The source was replaced after its inode was journaled, so the rename
    /// carried another file. Return that file while the source name is free;
    /// the document stays at its path.
    fn restore_replaced(
        &self,
        movement: &FileMove,
        source: &Path,
        destination: &Path,
    ) -> Result<Outcome> {
        // A file created at the source meanwhile keeps that name.
        let _ = disk::rename_new(destination, source);
        for folder in [source.parent().unwrap(), destination.parent().unwrap()] {
            if folder.is_dir() {
                disk::sync_directories(folder, &self.root)?;
            }
        }
        self.drop_intent(movement)
    }

    /// The journaled inode is at the destination: commit the document there.
    fn commit_move(&self, movement: &FileMove) -> Result<Outcome> {
        let destination = self.safe(&movement.destination, false)?;
        disk::sync_directories(destination.parent().unwrap(), &self.root)?;
        // The old folder may since have been removed or replaced by a link;
        // then there is no entry left to sync, and nothing may block saves.
        if let Some(source) = self.journaled(&movement.source)?
            && source.parent().unwrap().is_dir()
        {
            disk::sync_directories(source.parent().unwrap(), &self.root)?;
        }
        let mut old = self.doc(&movement.document)?;
        old.path = movement.source.clone();
        let metadata = fs::symlink_metadata(&destination)?;
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        if Path::new(&movement.source).parent() != Path::new(&movement.destination).parent() {
            self.reanchor_moved_media(&tx, &old, &movement.destination)?;
        }
        let previous = Self::move_identity(&tx, movement)?;
        record_identity(&tx, &movement.document, Identity::of(&metadata).as_ref())?;
        tx.execute(
            "DELETE FROM document_gaps WHERE doc=?",
            [&movement.document],
        )?;
        tx.execute(
            "DELETE FROM document_moves WHERE doc=?",
            [&movement.document],
        )?;
        tx.commit()?;
        drop(db);
        self.permissions.invalidate();
        if let Some(previous) = previous {
            self.close_document(&previous);
        }
        Ok(Outcome::Moved)
    }

    fn pending_file_moves(&self, path: Option<&str>) -> Result<Vec<FileMove>> {
        let movements = self
            .db
            .lock()
            .unwrap()
            .prepare(
                "SELECT doc,source,destination,device,inode,born FROM document_moves
                WHERE ?1 IS NULL OR source=?1 OR destination=?1 ORDER BY doc",
            )?
            .query_map([path], |row| {
                Ok(FileMove {
                    document: row.get(0)?,
                    source: row.get(1)?,
                    destination: row.get(2)?,
                    device: row.get(3)?,
                    inode: row.get(4)?,
                    born: row.get(5)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(movements)
    }

    /// Settle any journaled move that can change what `path` names before
    /// it is read, indexed or reused. A folder move, delete or restore that
    /// cannot settle yet leaves the path unavailable, never a new document.
    pub(super) fn finish_pending_path(&self, path: &str) -> Result<()> {
        for movement in self.pending_file_moves(Some(path))? {
            self.settle_intent(&movement, true)?;
        }
        for movement in self.pending_entries()? {
            if movement.covers(path) && self.settle_entry(&movement, true).is_err() {
                return Err(pending_entry());
            }
        }
        Ok(())
    }

    pub(super) fn recover_file_operations(&self) -> Result<()> {
        let _files = self.document_files.lock().unwrap();
        self.settle_intents(true)
    }

    pub(super) fn retry_file_operations(&self) -> Result<()> {
        let Ok(_files) = self.document_files.try_lock() else {
            return Ok(());
        };
        self.settle_intents(false)
    }

    /// One unreadable folder must not stop recovery of every other document.
    /// Startup reports a rename that is still pending at error level; later
    /// passes retry quietly so a lasting I/O error cannot flood logs.
    fn settle_intents(&self, startup: bool) -> Result<()> {
        for movement in self.pending_file_moves(None)? {
            if let Err(error) = self.settle_intent(&movement, true) {
                if startup {
                    tracing::error!(
                        document = movement.document,
                        "Interrupted rename is still pending: {error}"
                    );
                } else {
                    tracing::debug!(
                        document = movement.document,
                        "Rename still pending: {error}"
                    );
                }
            }
        }
        for movement in self.pending_entries()? {
            if let Err(error) = self.settle_entry(&movement, true) {
                let action = movement.action.as_str();
                if startup {
                    tracing::error!(
                        path = movement.source,
                        "Interrupted {action} is still pending: {error}"
                    );
                } else {
                    tracing::debug!(path = movement.source, "{action} still pending: {error}");
                }
            }
        }
        Ok(())
    }

    /// Intentional path reuse by creation, a rename, a folder move or a
    /// restore. Preserve the final accepted room before revoking identity,
    /// with one lock order. A missing document an incomplete walk holds
    /// never retires here: a folder that walk could not list may hide its
    /// file, so the reuse is refused until a walk can list it.
    pub(super) fn retire_missing_identity(&self, id: &str, path: &Path) -> Result<bool> {
        let room = self.rooms.lock().unwrap().get(id).cloned();
        let mut live = if let Some(room) = &room {
            // A busy missing file must not delay unrelated documents' saves.
            let Ok(live) = room.try_lock() else {
                return Ok(false);
            };
            Some(live)
        } else {
            None
        };
        let missing = || {
            self.root_identity.matches(&self.root)
                && fs::metadata(path)
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        };
        if !missing() {
            return Ok(false);
        }
        if let Some(folder) = self.reconciliation.holder(id) {
            let name = |path: &Path| match path.strip_prefix(&self.root) {
                Ok(relative) if !relative.as_os_str().is_empty() => {
                    relative.to_string_lossy().into_owned()
                }
                _ => "the documents folder".into(),
            };
            let (path, folder) = (name(path), name(&folder));
            return Err(ApiError(
                StatusCode::CONFLICT,
                format!(
                    "{path} still belongs to a document whose file may be in {folder}, which Locdoc cannot read. Make {folder} readable for Locdoc, then try again."
                ),
            ));
        }
        if let Some(room) = live.as_mut() {
            self.preserve_for_retirement(id, room)?;
        }
        if !missing() {
            return Ok(false);
        }
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        retire(&tx, id)?;
        tx.commit()?;
        drop(db);
        self.permissions.invalidate();
        // Cache operations acquire map -> room. Drop the guard before removing
        // it from that map; stale commands reject the now-inactive identity.
        drop(live);
        self.close_document(id);
        Ok(true)
    }
}

/// Folder moves, deletes into the trash and restores. Each journals the
/// identity of the file or folder it moves and where it goes before the
/// filesystem changes, renames without replacing anything, syncs both
/// folders and then commits what the move means in one transaction.
/// Settling an interrupted move finishes it from where its entry is found.
impl Store {
    /// Rename or move a folder. Its documents keep their ids, links,
    /// comments and history; folder links, MCP folder grants and pinned
    /// media grants follow it. Open documents keep their rooms, which hold
    /// still while it moves, so accepted edits waiting for projection reach
    /// their files at the new paths. Returns the new path.
    pub(super) fn rename_folder(&self, from: &str, to: &str) -> Result<String> {
        let _files = self.document_files.lock().unwrap();
        let from = relative_path(from, false)?;
        let to = relative_path(to, false)?;
        if below(&to, &from).is_some_and(|rest| !rest.is_empty()) {
            return Err(bad(
                "A folder cannot move into itself or into one of its own folders.",
            ));
        }
        let unplaced = self.reconcile(Pass::Discover)?;
        let source = self.existing_folder(&from)?;
        self.outside_state(&source)?;
        if to == from {
            return Ok(to);
        }
        let destination = self.safe(&to, false)?;
        if !destination.parent().is_some_and(Path::is_dir) {
            return Err(bad("Choose an existing destination folder."));
        }
        if fs::symlink_metadata(&destination).is_ok() {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "That path already exists.".into(),
            ));
        }
        // A folder moved into the state folder could never move out again.
        if self.holds_state(&destination) {
            return Err(bad(
                "Locdoc keeps its own state in that folder. Choose another destination.",
            ));
        }
        let moving = self.documents_below(&from)?;
        self.settled_below(&from, &moving, &unplaced)?;
        self.settled_below(&to, &[], &unplaced)?;
        self.free_rows_below(&to, &unplaced)?;
        let ids: Vec<&str> = moving.iter().map(|document| document.id.as_str()).collect();
        let held = self.hold_rooms(&ids);
        let live: Vec<_> = held
            .rooms
            .iter()
            .map(|(_, room)| room.lock().unwrap())
            .collect();
        // Approvals recorded before file identities are identified while
        // the folder is still in place, so the commit can tell what moved.
        let rows: Vec<(&str, &str)> = moving
            .iter()
            .map(|document| (document.id.as_str(), document.path.as_str()))
            .collect();
        self.refresh_media_identities(&rows)?;
        let metadata = fs::symlink_metadata(&source)?;
        let movement = EntryMove::new(
            uuid::Uuid::new_v4().to_string(),
            Action::Rename,
            EntryKind::Folder,
            None,
            (from, to.clone()),
            &metadata,
        );
        self.rehearse(&movement)?;
        self.journal_entry(&movement)?;
        let closed = self.carry_out(&movement, &source, &destination)?;
        drop(live);
        for id in closed {
            self.close_document(&id);
        }
        Ok(to)
    }

    /// Move a document's file into the trash. It keeps its id, comments,
    /// history and links, which are suspended until it is restored. Edits
    /// accepted but not yet projected stay durable and reach the file once
    /// it is back. Returns the trash item.
    pub(super) fn trash_document(&self, id: &str) -> Result<String> {
        let _files = self.document_files.lock().unwrap();
        self.finish_pending_path(&self.doc(id)?.path)?;
        let unplaced = self.reconcile(Pass::Discover)?;
        let document = self.doc(id)?;
        if unplaced.contains(&document.id) {
            return Err(busy_entry());
        }
        self.settled_below(&document.path, &[], &unplaced)?;
        let source = self.safe(&document.path, false)?;
        let metadata = match fs::symlink_metadata(&source) {
            Ok(metadata) if metadata.is_file() => metadata,
            Err(error)
                if !matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                return Err(error.into());
            }
            _ => {
                return Err(ApiError(
                    StatusCode::NOT_FOUND,
                    "This document's file is no longer in the documents folder.".into(),
                ));
            }
        };
        // A deferred pass can leave another file at this path; move only ours.
        if !self.assigned(&document.path, Identity::of(&metadata).as_ref())? {
            return Err(busy_entry());
        }
        let trash = uuid::Uuid::new_v4().to_string();
        let name = Path::new(&document.path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let movement = EntryMove::new(
            trash.clone(),
            Action::Trash,
            EntryKind::Document,
            Some(document.id.clone()),
            (document.path.clone(), format!("{TRASH}/{trash}/{name}")),
            &metadata,
        );
        let held = self.hold_rooms(&[document.id.as_str()]);
        let mut live = Vec::new();
        for (_, room) in &held.rooms {
            let mut room = room.lock().unwrap();
            // Edits a failed commit left in memory become durable first.
            room.ensure_committed(self, &document)?;
            live.push(room);
        }
        let closed = self.trash_entry(&movement, &source)?;
        // Their sockets close as a retired document's do. A room one of them
        // still holds belongs to the incarnation the delete ended, so it
        // never accepts again, even after a restore.
        for room in &live {
            let _ = room.tx.send(vec![126]);
        }
        drop(live);
        for id in closed {
            self.close_document(&id);
        }
        Ok(trash)
    }

    /// Move a folder and everything in it into the trash. Its documents keep
    /// their ids, comments, history and links; those links, its folder links
    /// and its MCP folder grants are suspended until it is restored.
    /// Returns the trash item.
    pub(super) fn trash_folder(&self, input: &str) -> Result<String> {
        let _files = self.document_files.lock().unwrap();
        let path = relative_path(input, false)?;
        let unplaced = self.reconcile(Pass::Discover)?;
        let source = self.existing_folder(&path)?;
        self.outside_state(&source)?;
        let documents = self.documents_below(&path)?;
        self.settled_below(&path, &documents, &unplaced)?;
        let metadata = fs::symlink_metadata(&source)?;
        let trash = uuid::Uuid::new_v4().to_string();
        let name = Path::new(&path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let movement = EntryMove::new(
            trash.clone(),
            Action::Trash,
            EntryKind::Folder,
            None,
            (path, format!("{TRASH}/{trash}/{name}")),
            &metadata,
        );
        let ids: Vec<&str> = documents
            .iter()
            .map(|document| document.id.as_str())
            .collect();
        let held = self.hold_rooms(&ids);
        let mut live = Vec::new();
        for (id, room) in &held.rooms {
            let mut room = room.lock().unwrap();
            let document = documents.iter().find(|document| &document.id == id);
            room.ensure_committed(self, document.unwrap())?;
            live.push((id, room));
        }
        let closed = self.trash_entry(&movement, &source)?;
        // A document whose file left the folder first was not deleted.
        for (_, room) in live.iter().filter(|(id, _)| closed.contains(id)) {
            let _ = room.tx.send(vec![126]);
        }
        drop(live);
        for id in closed {
            self.close_document(&id);
        }
        Ok(trash)
    }

    /// Put a trash item back at its original path, its documents' links,
    /// folder links and MCP folder grants working again. Folders missing on
    /// the way are created; a path something else took meanwhile is a
    /// conflict. Returns the path and the documents restored.
    pub(super) fn restore_trash(&self, id: &str) -> Result<(String, Vec<String>)> {
        let _files = self.document_files.lock().unwrap();
        let unplaced = self.reconcile(Pass::Discover)?;
        let not_found = || {
            ApiError(
                StatusCode::NOT_FOUND,
                "This item is no longer in the trash.".into(),
            )
        };
        let (kind, original, location) = self
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT kind,path,location FROM trash WHERE id=?",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(not_found)?;
        let entry = EntryKind::parse(&kind).ok_or_else(not_found)?;
        if self
            .pending_entries()?
            .iter()
            .any(|movement| movement.id == id)
        {
            return Err(pending_entry());
        }
        let source = self.safe(&location, true)?;
        let metadata = match fs::symlink_metadata(&source) {
            Ok(metadata)
                if match entry {
                    EntryKind::Document => metadata.is_file(),
                    EntryKind::Folder => metadata.is_dir(),
                } =>
            {
                metadata
            }
            Err(error)
                if !matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                return Err(error.into());
            }
            _ => {
                // Something removed it from the trash; its documents retire
                // as missing ones do.
                self.settle_trash()?;
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "The deleted files are no longer in Locdoc's trash folder. Their last accepted text is in Removed document recovery.".into(),
                ));
            }
        };
        let destination = self.safe(&original, false)?;
        self.not_into_state(&destination)?;
        if fs::symlink_metadata(&destination).is_ok() {
            return Err(ApiError(
                StatusCode::CONFLICT,
                format!("{original} already exists. Rename or move it, then restore again."),
            ));
        }
        let documents: Vec<String> = self
            .db
            .lock()
            .unwrap()
            .prepare("SELECT doc FROM trashed_documents WHERE trash=? ORDER BY path")?
            .query_map([id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        self.settled_below(&original, &[], &unplaced)?;
        self.free_rows_below(&original, &unplaced)?;
        let created = self.create_parents(&destination, &original)?;
        let movement = EntryMove::new(
            id.to_owned(),
            Action::Restore,
            entry,
            (entry == EntryKind::Document)
                .then(|| documents.first().cloned())
                .flatten(),
            (location, original.clone()),
            &metadata,
        );
        let restored = self
            .rehearse(&movement)
            .and_then(|()| self.journal_entry(&movement))
            .and_then(|()| self.carry_out(&movement, &source, &destination));
        let closed = match restored {
            Ok(closed) => closed,
            Err(error) => {
                // Folders made for a restore that did not happen go again;
                // anything placed in them meanwhile keeps them.
                if destination.symlink_metadata().is_err() {
                    for folder in created {
                        let _ = fs::remove_dir(folder);
                    }
                }
                return Err(error);
            }
        };
        for id in closed {
            self.close_document(&id);
        }
        Ok((original, documents))
    }

    /// The shared steps of a delete: the item's own folder in the trash,
    /// durable before the journal, then the rename and its commit.
    fn trash_entry(&self, movement: &EntryMove, source: &Path) -> Result<Vec<String>> {
        self.rehearse(movement)?;
        let folder = self.safe(&format!("{TRASH}/{}", movement.id), true)?;
        fs::create_dir_all(&folder)?;
        let prepared =
            disk::sync_directories(&folder, &self.root).and_then(|()| self.journal_entry(movement));
        if let Err(error) = prepared {
            let _ = fs::remove_dir(&folder);
            return Err(error);
        }
        let name = Path::new(&movement.destination).file_name().unwrap();
        self.carry_out(movement, source, &folder.join(name))
    }

    /// Carry out a journaled move's filesystem step and commit it. A
    /// destination something else took leaves everything in place, and a
    /// source replaced before the rename goes back. Returns the documents
    /// whose rooms close.
    fn carry_out(
        &self,
        movement: &EntryMove,
        source: &Path,
        destination: &Path,
    ) -> Result<Vec<String>> {
        match disk::rename_new(source, destination) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                self.drop_entry(movement)?;
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "That path already exists.".into(),
                ));
            }
            Err(error) => {
                // A failed rename normally changes neither name. Settle from
                // what is there rather than leave an intent holding the files.
                return match self.settle_entry(movement, false)? {
                    Outcome::Moved => Ok(Vec::new()),
                    Outcome::Dropped => Err(error.into()),
                };
            }
        }
        if !movement.contains(destination)? {
            self.put_back_entry(movement, source, destination)?;
            return Err(ApiError(
                StatusCode::CONFLICT,
                "It changed while it was being moved. Try again.".into(),
            ));
        }
        self.commit_entry(movement)
    }

    fn pending_entries(&self) -> Result<Vec<EntryMove>> {
        let rows = self
            .db
            .lock()
            .unwrap()
            .prepare(
                "SELECT id,action,kind,document,source,destination,device,inode,born
                 FROM entry_moves ORDER BY rowid",
            )?
            .query_map([], |row| {
                let action: String = row.get(1)?;
                let kind: String = row.get(2)?;
                let (id, document, source, destination, device, inode, born) = (
                    row.get(0)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                );
                // A move a newer version journaled is left to that version.
                Ok(Action::parse(&action)
                    .zip(EntryKind::parse(&kind))
                    .map(|(action, entry)| EntryMove {
                        id,
                        action,
                        entry,
                        document,
                        source,
                        destination,
                        device,
                        inode,
                        born,
                    }))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows.into_iter().flatten().collect())
    }

    fn journal_entry(&self, movement: &EntryMove) -> Result<()> {
        self.db.lock().unwrap().execute(
            "INSERT INTO entry_moves(id,action,kind,document,source,destination,device,inode,born)
             VALUES(?,?,?,?,?,?,?,?,?)",
            params![
                movement.id,
                movement.action.as_str(),
                movement.entry.as_str(),
                movement.document,
                movement.source,
                movement.destination,
                movement.device,
                movement.inode,
                movement.born
            ],
        )?;
        Ok(())
    }

    /// A journaled path, hidden ones included, or None once it no longer
    /// resolves safely inside the root. An unavailable root retries.
    fn entry_path(&self, path: &str) -> Result<Option<PathBuf>> {
        match self.safe(path, true) {
            Ok(path) => Ok(Some(path)),
            Err(error) if error.0 == StatusCode::SERVICE_UNAVAILABLE => Err(error),
            Err(_) => Ok(None),
        }
    }

    /// Settle a journaled move from where its file or folder is now: at its
    /// destination it commits; only at its source, with the destination
    /// free, the move is carried out again; anywhere else the intent ends
    /// and passes place what it held from file evidence. Only an I/O error
    /// keeps the intent for a later pass.
    fn settle_entry(&self, movement: &EntryMove, redo: bool) -> Result<Outcome> {
        let source = self.entry_path(&movement.source)?;
        let destination = self.entry_path(&movement.destination)?;
        let holds = |path: &Option<PathBuf>| {
            path.as_deref()
                .map_or(Ok(false), |path| movement.contains(path))
        };
        let at_source = holds(&source)?;
        let at_destination = holds(&destination)?;
        match (at_source, at_destination, source, destination) {
            (false, true, _, _) => self.finish_entry(movement),
            (true, false, Some(source), Some(destination)) if redo => {
                self.prepare_destination(movement, &destination);
                match disk::rename_new(&source, &destination) {
                    Ok(()) if movement.contains(&destination)? => self.finish_entry(movement),
                    Ok(()) => self.put_back_entry(movement, &source, &destination),
                    // It stays where it is; whatever took the destination wins.
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        self.drop_entry(movement)
                    }
                    // A failed rename normally leaves both names unchanged.
                    Err(_) => self.settle_entry(movement, false),
                }
            }
            // Only a delete's rename puts anything at its destination, a new
            // folder in the trash. Something else there is what a desktop
            // save left at the source before that rename carried it, which
            // stopped before putting it back: return it while the source is
            // free, so its document keeps it.
            (false, false, Some(source), Some(destination))
                if movement.action == Action::Trash
                    && fs::symlink_metadata(&destination).is_ok() =>
            {
                if fs::symlink_metadata(&source).is_ok() {
                    tracing::warn!(
                        path = movement.destination,
                        "a file a delete carried stays in the trash folder"
                    );
                    return self.drop_entry(movement);
                }
                self.put_back_entry(movement, &source, &destination)
            }
            // Still only at its source, at both names, or under neither.
            _ => self.drop_entry(movement),
        }
    }

    /// A delete recreates its item's folder in the trash and a restore the
    /// folders its path needs; a rename never recreates a removed folder.
    /// A failure is left to the rename.
    fn prepare_destination(&self, movement: &EntryMove, destination: &Path) {
        if movement.action == Action::Rename {
            return;
        }
        if let Some(parent) = destination.parent().filter(|parent| !parent.is_dir())
            && fs::create_dir_all(parent).is_ok()
        {
            let _ = disk::sync_directories(parent, &self.root);
        }
    }

    fn finish_entry(&self, movement: &EntryMove) -> Result<Outcome> {
        for id in self.commit_entry(movement)? {
            self.close_document(&id);
        }
        Ok(Outcome::Moved)
    }

    fn drop_entry(&self, movement: &EntryMove) -> Result<Outcome> {
        self.db
            .lock()
            .unwrap()
            .execute("DELETE FROM entry_moves WHERE id=?", [&movement.id])?;
        if movement.action == Action::Trash
            && let Some(folder) = self.entry_path(&format!("{TRASH}/{}", movement.id))?
        {
            // The item's own folder, unless something reached it.
            let _ = fs::remove_dir(folder);
        }
        // What it held may not be at its row paths; a pass places it.
        self.reconciliation.after(RETRY);
        Ok(Outcome::Dropped)
    }

    /// The source was replaced after its identity was journaled, so the
    /// rename carried another file or folder. Return that while the source
    /// name is free; what the move held stays where it is.
    fn put_back_entry(
        &self,
        movement: &EntryMove,
        source: &Path,
        destination: &Path,
    ) -> Result<Outcome> {
        let _ = disk::rename_new(destination, source);
        for folder in [source.parent().unwrap(), destination.parent().unwrap()] {
            if folder.is_dir() {
                disk::sync_directories(folder, &self.root)?;
            }
        }
        self.drop_entry(movement)
    }

    /// The journaled entry is at its destination. Make both directory
    /// entries durable, then commit what the move means for documents,
    /// links and grants in one transaction. Returns the documents whose
    /// rooms close: trashed ones, and any whose files the move proved gone.
    fn commit_entry(&self, movement: &EntryMove) -> Result<Vec<String>> {
        let destination = self.entry_path(&movement.destination)?.ok_or_else(|| {
            ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "A moved file is no longer inside the documents folder.".into(),
            )
        })?;
        disk::sync_directories(destination.parent().unwrap(), &self.root)?;
        if let Some(source) = self.entry_path(&movement.source)?
            && source.parent().unwrap().is_dir()
        {
            disk::sync_directories(source.parent().unwrap(), &self.root)?;
        }
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        let closed = self.apply_entry(&tx, movement, true)?;
        tx.execute("DELETE FROM entry_moves WHERE id=?", [&movement.id])?;
        tx.commit()?;
        drop(db);
        self.permissions.invalidate();
        if movement.action == Action::Restore
            && let Some(folder) = self.entry_path(&format!("{TRASH}/{}", movement.id))?
        {
            // The item's folder in the trash is empty now.
            let _ = fs::remove_dir(folder);
        }
        Ok(closed)
    }

    /// Exercise the commit's constraints before the filesystem changes. The
    /// transaction rolls back; only commit_entry publishes a move.
    fn rehearse(&self, movement: &EntryMove) -> Result<()> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        self.apply_entry(&tx, movement, false)?;
        tx.rollback()?;
        Ok(())
    }

    /// What a move means in the database. While rehearsing, before anything
    /// moved, the steps that read the moved files are left to the commit.
    fn apply_entry(
        &self,
        tx: &rusqlite::Transaction<'_>,
        movement: &EntryMove,
        committing: bool,
    ) -> Result<Vec<String>> {
        match movement.action {
            Action::Rename => self.apply_rename(tx, movement, committing),
            Action::Trash => self.apply_trash(tx, movement, committing),
            Action::Restore => self.apply_restore(tx, movement, committing),
        }
    }

    fn apply_rename(
        &self,
        tx: &rusqlite::Transaction<'_>,
        movement: &EntryMove,
        committing: bool,
    ) -> Result<Vec<String>> {
        let (from, to) = (movement.source.as_str(), movement.destination.as_str());
        let mut closed = Vec::new();
        let moving = active_documents(tx)?
            .into_iter()
            .filter(|document| below(&document.path, from).is_some());
        for document in moving {
            let path = rebase(&document.path, from, to).unwrap();
            closed.extend(vacate(tx, &path, &document.id)?);
            let updated = tx.execute(
                "UPDATE docs SET path=? WHERE id=? AND active=1",
                params![path, document.id],
            )?;
            if updated != 1 {
                return Err(bad("A document identity changed during the folder move."));
            }
            tx.execute("DELETE FROM document_gaps WHERE doc=?", [&document.id])?;
            if committing {
                // Approvals are checked against the files they resolved to
                // in the old folder, as for a document moving alone.
                self.reanchor_moved_media(tx, &document, &path)?;
            }
        }
        rebase_rows(tx, "folder_shares", from, to)?;
        rebase_rows(tx, "mcp_folders", from, to)?;
        self.rebase_grants(tx, from, to)?;
        Ok(closed)
    }

    fn apply_trash(
        &self,
        tx: &rusqlite::Transaction<'_>,
        movement: &EntryMove,
        committing: bool,
    ) -> Result<Vec<String>> {
        let (original, location) = (movement.source.as_str(), movement.destination.as_str());
        // Each document with the path it had and its file's path in the trash.
        let documents: Vec<(Document, String, String)> = match movement.entry {
            EntryKind::Document => active_documents(tx)?
                .into_iter()
                .filter(|document| {
                    movement.document.as_deref() == Some(document.id.as_str())
                        && document.path == original
                })
                .map(|document| {
                    let path = document.path.clone();
                    (document, path, location.to_owned())
                })
                .collect(),
            EntryKind::Folder if committing => self.carried_documents(tx, original, location)?,
            // Rehearsing, before anything moved: the folder's rows.
            EntryKind::Folder => active_documents(tx)?
                .into_iter()
                .filter_map(|document| {
                    let trashed = rebase(&document.path, original, location)?;
                    let path = document.path.clone();
                    Some((document, path, trashed))
                })
                .collect(),
        };
        for (document, path, trashed) in &documents {
            // A new incarnation: no room loaded before the delete accepts
            // anything once it is back.
            let updated = tx.execute(
                "UPDATE docs SET active=2,path=?,incarnation=incarnation+1
                 WHERE id=? AND active=1",
                params![trashed, document.id],
            )?;
            if updated != 1 {
                return Err(bad("A document identity changed during the delete."));
            }
            tx.execute(
                "INSERT INTO trashed_documents(doc,trash,path) VALUES(?,?,?)
                 ON CONFLICT(doc) DO UPDATE SET trash=excluded.trash,path=excluded.path",
                params![document.id, movement.id, path],
            )?;
            tx.execute("DELETE FROM document_gaps WHERE doc=?", [&document.id])?;
        }
        let documents: Vec<Document> = documents
            .into_iter()
            .map(|(document, ..)| document)
            .collect();
        if movement.entry == EntryKind::Folder {
            // Hidden paths open nothing, so these stay suspended until the
            // restore brings them back.
            rebase_rows(tx, "folder_shares", original, location)?;
            rebase_rows(tx, "mcp_folders", original, location)?;
            self.rebase_grants(tx, original, location)?;
        }
        tx.execute(
            "INSERT OR IGNORE INTO trash(id,kind,path,location,deleted) VALUES(?,?,?,?,?)",
            params![
                movement.id,
                movement.entry.as_str(),
                original,
                location,
                now()
            ],
        )?;
        Ok(documents.into_iter().map(|document| document.id).collect())
    }

    /// The documents a folder delete carried into the trash, once the folder
    /// is there. The pass before the delete placed every document, but a
    /// desktop application may move or remove files until the rename, so the
    /// moved folder decides, as a pass would: a document whose own recorded
    /// file is inside goes wherever its row was, its media approvals
    /// reanchored as for any move when that file changed folders, and one
    /// recorded below the folder goes when its name still holds its own
    /// file or one no other document records. A document whose file left
    /// the folder first stays active for passes to place or retire. A name
    /// that cannot be read still goes with its folder. Returns each document
    /// with the path it had and where its file is in the trash.
    fn carried_documents(
        &self,
        tx: &rusqlite::Transaction<'_>,
        original: &str,
        location: &str,
    ) -> Result<Vec<(Document, String, String)>> {
        let recorded: HashMap<String, Identity> = tx
            .prepare(
                "SELECT f.doc,f.identity FROM document_identities f
                 JOIN docs d ON d.id=f.doc WHERE d.active=1",
            )?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, Identity(row.get(1)?)))
            })?
            .collect::<std::result::Result<_, _>>()?;
        // Evidence recorded for two documents identifies neither.
        let mut owners: HashMap<&Identity, usize> = HashMap::new();
        for identity in recorded.values() {
            *owners.entry(identity).or_default() += 1;
        }
        let inside = match self.entry_path(location)? {
            Some(folder) => carried_files(&folder),
            None => HashMap::new(),
        };
        let mut carried = Vec::new();
        for document in active_documents(tx)? {
            let own = recorded.get(&document.id);
            if let Some(relative) = own
                .filter(|identity| owners[identity] == 1)
                .and_then(|identity| inside.get(identity))
            {
                let path = format!("{original}/{relative}");
                // A file that changed folders before the delete carried it
                // moved as a pass would place it: its approvals never lend
                // the folder it reached another image with their spelling.
                if Path::new(&path).parent() != Path::new(&document.path).parent() {
                    self.reanchor_moved_media(tx, &document, &path)?;
                }
                carried.push((document, path, format!("{location}/{relative}")));
                continue;
            }
            let Some(trashed) = rebase(&document.path, original, location) else {
                continue;
            };
            let went = match self.entry_path(&trashed)? {
                Some(path) => match fs::symlink_metadata(path) {
                    Ok(metadata) => {
                        metadata.is_file()
                            && Identity::of(&metadata).is_none_or(|identity| {
                                own == Some(&identity) || !owners.contains_key(&identity)
                            })
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                        ) =>
                    {
                        false
                    }
                    Err(_) => true,
                },
                None => true,
            };
            if went {
                let path = document.path.clone();
                carried.push((document, path, trashed));
            }
        }
        Ok(carried)
    }

    fn apply_restore(
        &self,
        tx: &rusqlite::Transaction<'_>,
        movement: &EntryMove,
        committing: bool,
    ) -> Result<Vec<String>> {
        let (location, original) = (movement.source.as_str(), movement.destination.as_str());
        let documents = tx
            .prepare(
                "SELECT t.doc,t.path FROM trashed_documents t JOIN docs d ON d.id=t.doc
                 WHERE t.trash=? AND d.active=2",
            )?
            .query_map([&movement.id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut closed = Vec::new();
        for (id, path) in &documents {
            closed.extend(vacate(tx, path, id)?);
            let updated = tx.execute(
                "UPDATE docs SET active=1,path=? WHERE id=? AND active=2",
                params![path, id],
            )?;
            if updated != 1 {
                return Err(bad("A document identity changed during the restore."));
            }
        }
        // A file replaced while it was in the trash is the one that is back.
        if committing
            && movement.entry == EntryKind::Document
            && let Some((id, path)) = documents.first()
        {
            let metadata = fs::symlink_metadata(self.safe(path, false)?)?;
            record_identity(tx, id, Identity::of(&metadata).as_ref())?;
        }
        if movement.entry == EntryKind::Folder {
            rebase_rows(tx, "folder_shares", location, original)?;
            rebase_rows(tx, "mcp_folders", location, original)?;
            self.rebase_grants(tx, location, original)?;
        }
        tx.execute(
            "DELETE FROM trashed_documents WHERE trash=?",
            [&movement.id],
        )?;
        tx.execute("DELETE FROM trash WHERE id=?", [&movement.id])?;
        Ok(closed)
    }

    /// Pinned media grants name files by absolute path. Files below a
    /// moved folder moved with it, so their grants follow.
    fn rebase_grants(&self, tx: &Connection, from: &str, to: &str) -> Result<()> {
        let from = self.root.join(from).to_string_lossy().into_owned();
        let to = self.root.join(to).to_string_lossy().into_owned();
        let grants = tx
            .prepare("SELECT doc,path,identity FROM grants")?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for (document, path, identity) in grants {
            let Some(moved) = rebase(&path, &from, &to) else {
                continue;
            };
            tx.execute(
                "DELETE FROM grants WHERE doc=? AND path=?",
                params![document, path],
            )?;
            // The file moved with its folder: the grant keeps its identity,
            // so it can still follow that file later.
            tx.execute(
                "INSERT INTO grants(doc,path,identity) VALUES(?,?,?)
                 ON CONFLICT(doc,path) DO UPDATE SET identity=COALESCE(identity,excluded.identity)",
                params![document, moved, identity],
            )?;
        }
        Ok(())
    }

    /// A trashed document whose file a desktop application removed from the
    /// trash retires as any missing document does: its links end and its
    /// text stays in Removed document recovery. An item with nothing left
    /// to bring back leaves the trash. Items a pending move involves wait.
    fn settle_trash(&self) -> Result<()> {
        let pending: HashSet<String> = self
            .pending_entries()?
            .into_iter()
            .map(|movement| movement.id)
            .collect();
        let (trashed, items) = {
            let db = self.db.lock().unwrap();
            let trashed = db
                .prepare(
                    "SELECT t.doc,d.path,t.trash,t.path FROM trashed_documents t
                     JOIN docs d ON d.id=t.doc WHERE d.active=2",
                )?
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let items = db
                .prepare("SELECT id,location FROM trash")?
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            (trashed, items)
        };
        let absent = |path: &str| self.trashed_seen(path) == Seen::Absent;
        // Seen absent twice, as a missing document must be.
        let gone: Vec<&(String, String, String, String)> = trashed
            .iter()
            .filter(|(_, path, item, _)| !pending.contains(item) && absent(path))
            .filter(|(_, path, ..)| absent(path))
            .collect();
        let kept: HashSet<&str> = trashed
            .iter()
            .filter(|document| !gone.iter().any(|gone| gone.0 == document.0))
            .map(|(_, _, item, _)| item.as_str())
            .collect();
        let emptied: Vec<&str> = items
            .iter()
            .filter(|(id, location)| {
                !pending.contains(id) && !kept.contains(id.as_str()) && absent(location)
            })
            .map(|(id, _)| id.as_str())
            .collect();
        if (gone.is_empty() && emptied.is_empty()) || !self.root_identity.matches(&self.root) {
            return Ok(());
        }
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        for (id, _, _, original) in &gone {
            retire_trashed(&tx, id, original)?;
        }
        for id in &emptied {
            tx.execute("DELETE FROM trash WHERE id=?", [id])?;
        }
        tx.commit()?;
        drop(db);
        if !gone.is_empty() {
            self.permissions.invalidate();
            for (id, ..) in gone {
                self.close_document(id);
            }
        }
        Ok(())
    }

    /// What a path in the trash shows. Inaccessibility is no evidence.
    fn trashed_seen(&self, path: &str) -> Seen<Identity> {
        let Ok(full) = self.safe(path, true) else {
            return Seen::Unknown;
        };
        match fs::symlink_metadata(full) {
            Ok(metadata) => Seen::File(Identity::of(&metadata)),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                Seen::Absent
            }
            Err(_) => Seen::Unknown,
        }
    }

    fn existing_folder(&self, path: &str) -> Result<PathBuf> {
        let full = self.safe(path, false)?;
        match fs::symlink_metadata(&full) {
            Ok(metadata) if metadata.is_dir() => Ok(full),
            Ok(_) => Err(bad("Choose a folder.")),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                Err(ApiError(StatusCode::NOT_FOUND, "Folder not found.".into()))
            }
            Err(error) => Err(error.into()),
        }
    }

    /// A state folder configured inside the documents folder is listed like
    /// any other, but it holds the database, the owner key and recovery
    /// archives the running server uses. A folder action never moves it,
    /// a folder holding it or a folder inside it.
    fn outside_state(&self, folder: &Path) -> Result<()> {
        if self.holds_state(folder) {
            return Err(bad(
                "Locdoc keeps its own state in this folder, so it never moves or deletes it.",
            ));
        }
        Ok(())
    }

    /// Whether `path` is the state folder, holds it or is inside it, for a
    /// state folder configured inside the documents folder, as
    /// `media::publishable` decides. A documents folder kept inside the
    /// state folder holds none of the state's own files.
    fn holds_state(&self, path: &Path) -> bool {
        self.data != self.root
            && self.data.starts_with(&self.root)
            && (self.data.starts_with(path) || path.starts_with(&self.data))
    }

    /// Active documents recorded at `folder` or below it.
    fn documents_below(&self, folder: &str) -> Result<Vec<Document>> {
        Ok(active_documents(&self.db.lock().unwrap())?
            .into_iter()
            .filter(|document| below(&document.path, folder).is_some())
            .collect())
    }

    /// A path moves only once passes have placed everything it holds or
    /// could hold, and no other journaled move involves it. A file found
    /// inside before its row could follow would leave unrecorded.
    fn settled_below(
        &self,
        path: &str,
        documents: &[Document],
        unplaced: &HashSet<String>,
    ) -> Result<()> {
        let found_inside = unplaced.iter().any(|id| {
            self.found_elsewhere(id)
                .is_some_and(|found| below(&found, path).is_some())
        });
        if found_inside
            || documents
                .iter()
                .any(|document| unplaced.contains(&document.id))
        {
            return Err(busy_entry());
        }
        let renaming = self.pending_file_moves(None)?.iter().any(|movement| {
            overlap(&movement.source, path) || overlap(&movement.destination, path)
        });
        if renaming
            || self
                .pending_entries()?
                .iter()
                .any(|movement| movement.covers(path))
        {
            return Err(pending_entry());
        }
        Ok(())
    }

    /// Rows of documents whose files are gone may still name paths at or
    /// below `folder`, which does not exist. They retire as path reuse
    /// retires a missing document, keeping their final accepted text.
    fn free_rows_below(&self, folder: &str, unplaced: &HashSet<String>) -> Result<()> {
        for document in self.documents_below(folder)? {
            let full = self.safe(&document.path, false)?;
            if unplaced.contains(&document.id)
                || !self.retire_missing_identity(&document.id, &full)?
            {
                return Err(busy_entry());
            }
        }
        Ok(())
    }

    /// Keep every room of `ids` from loading and return the open ones in one
    /// order, to lock while their files move. Nothing that holds a room
    /// waits for document_files or for another room's load.
    fn hold_rooms(&self, ids: &[&str]) -> Held {
        let mut ids = ids.to_vec();
        ids.sort_unstable();
        ids.dedup();
        let loads = ids.iter().map(|id| self.room_loads.acquire(id)).collect();
        let cached = self.rooms.lock().unwrap();
        let rooms = ids
            .iter()
            .filter_map(|id| Some(((*id).to_owned(), cached.get(*id)?.clone())))
            .collect();
        Held {
            _loads: loads,
            rooms,
        }
    }

    /// Create the folders a restored path needs. Returns those it created,
    /// deepest first, to remove again if the restore does not happen.
    fn create_parents(&self, destination: &Path, original: &str) -> Result<Vec<PathBuf>> {
        let in_the_way = || {
            ApiError(
                StatusCode::CONFLICT,
                format!("A file is in the way of {original}. Move it, then restore again."),
            )
        };
        let parent = destination.parent().unwrap();
        let mut created = Vec::new();
        let mut folder = parent;
        while folder != self.root && fs::symlink_metadata(folder).is_err() {
            created.push(folder.to_path_buf());
            folder = folder.parent().unwrap();
        }
        if created.is_empty() {
            return if parent.is_dir() {
                Ok(created)
            } else {
                Err(in_the_way())
            };
        }
        if fs::create_dir_all(parent).is_err() {
            for folder in &created {
                let _ = fs::remove_dir(folder);
            }
            return Err(in_the_way());
        }
        disk::sync_directories(parent, &self.root)?;
        Ok(created)
    }
}

/// The rooms of documents whose files move: none of them loads meanwhile,
/// and the open ones are locked in this order.
struct Held {
    _loads: Vec<work::LoadGuard>,
    rooms: Vec<(String, Arc<Mutex<Room>>)>,
}

/// Document files with a single name inside `folder`, by the evidence each
/// carries, with their paths relative to it. Like a walk it never follows
/// links or enters dot folders, and a file with other names shows whose file
/// it is but not where it moved.
fn carried_files(folder: &Path) -> HashMap<Identity, String> {
    let mut files = HashMap::new();
    let mut folders = vec![folder.to_path_buf()];
    while let Some(current) = folders.pop() {
        let Ok(children) = fs::read_dir(&current) else {
            continue;
        };
        for child in children.flatten() {
            if child
                .file_name()
                .to_str()
                .is_none_or(|name| name.starts_with('.'))
            {
                continue;
            }
            let path = child.path();
            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_dir() => folders.push(path),
                Ok(metadata) if metadata.is_file() && metadata.nlink() == 1 => {
                    if let Some(relative) = path.strip_prefix(folder).ok().and_then(Path::to_str)
                        && format(relative).is_some()
                        && let Some(identity) = Identity::of(&metadata)
                    {
                        files.insert(identity, relative.to_owned());
                    }
                }
                _ => {}
            }
        }
    }
    files
}

fn active_documents(db: &Connection) -> Result<Vec<Document>> {
    Ok(db
        .prepare("SELECT id,path,permission,token FROM docs WHERE active=1")?
        .query_map([], |row| {
            Ok(Document {
                id: row.get(0)?,
                path: row.get(1)?,
                permission: row.get(2)?,
                token: row.get(3)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

/// Make `path` free for the document `arriving` there. A row an older
/// version retired may still hold it; an active one belongs to a document
/// whose file the arrival proves gone, which retires and is returned.
fn vacate(tx: &Connection, path: &str, arriving: &str) -> Result<Option<String>> {
    tx.execute(
        "UPDATE docs SET retired_path=COALESCE(retired_path,path),
         path='.retired/'||id WHERE path=? AND active=0",
        [path],
    )?;
    let previous = tx
        .query_row(
            "SELECT id FROM docs WHERE path=? AND active=1 AND id!=?",
            params![path, arriving],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(previous) = &previous {
        retire(tx, previous)?;
    }
    Ok(previous)
}

/// Move folder links or MCP folder grants recorded at `from` or below it
/// along with their folder. A row the arriving one replaces recorded a
/// folder no longer there.
fn rebase_rows(tx: &Connection, table: &str, from: &str, to: &str) -> Result<()> {
    let paths = tx
        .prepare(&format!("SELECT path FROM {table}"))?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for path in paths {
        let Some(moved) = rebase(&path, from, to) else {
            continue;
        };
        tx.execute(&format!("DELETE FROM {table} WHERE path=?"), [&moved])?;
        tx.execute(
            &format!("UPDATE {table} SET path=? WHERE path=?"),
            params![moved, path],
        )?;
    }
    Ok(())
}

fn changed_during_rename() -> ApiError {
    ApiError(
        StatusCode::CONFLICT,
        "The file changed during the rename. Try again.".into(),
    )
}

/// Lets tests change the tree, or fail an operation, at each walk step.
fn walk_step(_path: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    tests::WALK_STEP.with_borrow_mut(|step| step.as_mut().map_or(Ok(()), |step| step(_path)))?;
    Ok(())
}

#[cfg(test)]
#[path = "namespace_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "namespace_entry_tests.rs"]
mod entry_tests;

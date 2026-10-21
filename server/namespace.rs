//! The only boundary that decides which file is which document, and the only
//! one that changes filenames. One pass settles journaled Locdoc renames,
//! observes the documents tree, classifies every document from evidence and
//! applies all path and identity changes in one transaction. A recorded file
//! identity outranks a path: a pathname alone never moves a document's links,
//! history or text onto another document's file.
use super::documents::{format, relative_path, retire};
use super::*;
use std::hash::Hash;
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
    /// retry. Asking again for them cannot complete the listing sooner.
    held: HashSet<String>,
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
        let held = self.0.lock().unwrap().held.contains(document);
        if !held {
            self.after(RETRY);
        }
    }
    /// A listing found a file no pass has matched yet. While an incomplete
    /// walk holds missing documents only its own retry can settle them, and
    /// every pass meanwhile walks the tree, so listings do not ask.
    fn unlisted(&self) {
        let held = !self.0.lock().unwrap().held.is_empty();
        if !held {
            self.after(RETRY);
        }
    }
    fn hold(&self, documents: HashSet<String>) {
        self.0.lock().unwrap().held = documents;
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pass {
    /// Follow moves and record new evidence. Editors briefly remove or swap
    /// files while saving, so missing documents wait for a settled pass.
    Discover,
    /// Also retire documents that a complete observation could not find.
    Settled,
}

/// Active documents as the database records them.
struct Namespace {
    tracked: Vec<Tracked<Identity>>,
    /// Documents whose rename is still pending, with their evidence.
    pending: Vec<(String, Option<Identity>)>,
    /// Paths a pending rename still owns. Nothing moves onto them.
    reserved: HashSet<String>,
}

fn sooner(retry: &mut Option<Duration>, delay: Duration) {
    *retry = Some(retry.map_or(delay, |retry| retry.min(delay)));
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
        if format(&path).is_none() || !full.is_file() {
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
            if discover {
                self.reconcile(Pass::Discover)?;
                evidence = observe()?;
            }
            if !discover || !self.assigned(&path, evidence.as_ref())? {
                // A busy room or a move in progress; a later pass decides. A
                // second name for a document's file stays unlisted.
                if discover {
                    self.reconciliation.after(RETRY);
                } else {
                    self.reconciliation.unlisted();
                }
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

    /// Whether the file at an indexed path carries its document's recorded
    /// evidence, or a file at an unindexed path carries no document's.
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
                 WHERE f.identity=? AND d.active=1)",
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

    /// One pass under document_files. A busy room or an undecidable file
    /// defers only that document and asks the maintenance loop to retry.
    /// Returns the documents left unplaced, as `discover_file_moves_locked`.
    fn reconcile(&self, pass: Pass) -> Result<HashSet<String>> {
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
        let (mut files, mut linked, complete) = self.walk();
        for document in &mut tracked {
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
        files.retain(|path, _| !linked.contains(path));
        let held: Vec<(&str, &Identity)> = pending
            .iter()
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
        if pass == Pass::Settled
            && complete
            && plan
                .missing
                .iter()
                .any(|missing| missing.evidence.is_some())
        {
            // A file moved between folders during the walk is in neither
            // listing. Retire only what a second complete walk cannot find.
            let (again, again_linked, still_complete) = self.walk();
            let present: HashSet<&Identity> = again
                .iter()
                .filter(|(path, _)| !again_linked.contains(*path))
                .filter_map(|(_, evidence)| evidence.as_ref())
                .collect();
            plan.missing.retain(|missing| {
                let gone = missing
                    .evidence
                    .as_ref()
                    .is_none_or(|evidence| still_complete && !present.contains(evidence));
                if !gone {
                    plan.undecided.push(missing.id.clone());
                }
                gone
            });
        }
        self.apply(pass, plan, &tracked, &reserved, complete, started)
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
        let mut namespace = Namespace {
            tracked: Vec::new(),
            pending: Vec::new(),
            reserved: HashSet::new(),
        };
        for (id, path, identity, destination, gap) in rows {
            let recorded = identity.map(Identity);
            match destination {
                Some(destination) => {
                    namespace.reserved.extend([path, destination]);
                    namespace.pending.push((id, recorded));
                }
                None => namespace.tracked.push(Tracked {
                    id,
                    path,
                    recorded,
                    seen: Seen::Unknown,
                    gap,
                }),
            }
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
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => (Seen::Unknown, false),
            _ => (Seen::Absent, false),
        }
    }

    /// Walk the tree once, never following symlinks or entering dot folders.
    /// An entry that vanishes is skipped; any other error makes the
    /// observation incomplete rather than failing the pass. Also returns the
    /// files that other names link to.
    fn walk(&self) -> (HashMap<String, Option<Identity>>, HashSet<String>, bool) {
        let mut files = HashMap::new();
        let mut linked = HashSet::new();
        let mut complete = true;
        let mut folders = vec![self.root.clone()];
        while let Some(folder) = folders.pop() {
            let children = match walk_step(&folder).and_then(|()| fs::read_dir(&folder)) {
                Ok(children) => children,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    complete = false;
                    continue;
                }
            };
            for child in children {
                let Ok(child) = child else {
                    complete = false;
                    continue;
                };
                // Document paths are UTF-8 and never hidden.
                let name = child.file_name();
                if name.to_str().is_none_or(|name| name.starts_with('.')) {
                    continue;
                }
                let path = child.path();
                match walk_step(&path).and_then(|()| fs::symlink_metadata(&path)) {
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
                    Err(_) => complete = false,
                }
            }
        }
        (files, linked, complete)
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
        complete: bool,
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
        let (waiting, mut retiring): (Vec<_>, Vec<_>) = missing
            .into_iter()
            .partition(|missing| !complete && missing.evidence.is_some());
        if !waiting.is_empty() {
            sooner(&mut retry, INCOMPLETE_RETRY);
        }
        if pass != Pass::Settled && !retiring.is_empty() {
            sooner(&mut retry, RETRY);
            retiring.clear();
        }
        self.reconciliation
            .hold(waiting.into_iter().map(|missing| missing.id).collect());
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
            return Err(bad("Document names must end with .md or .fountain."));
        }
        let dest = self.safe(&path, false)?;
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

    pub(super) fn finish_pending_path(&self, path: &str) -> Result<()> {
        for movement in self.pending_file_moves(Some(path))? {
            self.settle_intent(&movement, true)?;
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
        Ok(())
    }

    /// Intentional path reuse by creation or rename. Preserve the final
    /// accepted room before revoking identity, with one lock order.
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

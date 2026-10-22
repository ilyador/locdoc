//! The document engine owns durability, publication, projection and receipts.
//! No accepted text or save receipt escapes before its durable boundary.
use super::*;
use disk::DiskFile;

/// Private transaction buffers and projection state. Production callers can
/// submit commands or inspect status; only this module can mutate bookkeeping.
pub(super) struct DocumentEngine {
    state: save::SaveState,
    pending_updates: Arc<Mutex<Vec<Vec<u8>>>>,
    pending_media: HashSet<String>,
    pending_metadata: HashMap<String, Value>,
    published_projection: Option<u8>,
    journal: save::Journal,
    usage: Option<usize>,
    validation: validation::Validated,
    /// The document's incarnation when this room loaded. A delete into the
    /// trash starts a new one, so a room a socket or request still holds
    /// never accepts beside the fresh room a restore loads.
    incarnation: i64,
}
impl DocumentEngine {
    pub(super) fn conflicted(&self) -> bool {
        self.state.conflicted()
    }
    pub(super) fn needs_projection(&self) -> bool {
        self.state.needs_projection()
    }
    pub(super) fn waiting(&self) -> bool {
        self.state.waiting()
    }
    pub(super) fn interrupted(&self) -> bool {
        self.state.interrupted()
    }
    pub(super) fn source(&self) -> &str {
        self.state.source()
    }
    /// The line endings its file uses, as text::render takes them.
    pub(super) fn ending(&self) -> &str {
        self.state.ending()
    }
    pub(super) fn migrated(&self) -> bool {
        self.state.migrated()
    }
}

// Fault tests deliberately construct intermediate states. The production API
// never exposes mutable save-state access, receipts, or journal buffers.
#[cfg(test)]
impl std::ops::Deref for DocumentEngine {
    type Target = save::SaveState;
    fn deref(&self) -> &Self::Target {
        &self.state
    }
}
#[cfg(test)]
impl std::ops::DerefMut for DocumentEngine {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.state
    }
}

/// The custom collaboration message that tells a view to request once more
/// the media it could not load. Its payload is empty.
pub(super) const MEDIA_APPROVED: u8 = 119;

struct StoredRoom {
    state: Option<Vec<u8>>,
    baseline: Option<Vec<u8>>,
    intent: i64,
    target: Option<Vec<u8>>,
    target_state: Option<Vec<u8>>,
    before_hash: Option<String>,
    before: Option<Vec<u8>>,
    ending: String,
    migrated: bool,
    browser_generation: i64,
    protected_generation: i64,
    incarnation: i64,
}

impl Store {
    /// Relative owner approvals must not resolve to a different private file
    /// after a move. An approval stays relative only when the file it approved
    /// moved with the document, as when a folder moves with its images: its
    /// spelling names that file from the new folder and no longer from the
    /// old one. A file still at its old path stayed behind, even when a hard
    /// link or symlink reaches it from the new folder. It is pinned to that
    /// file at its exact old path, with its identity, so the grant follows the
    /// file if it later moves where the document names it, or ends once the
    /// file has left it. An approval recorded without a file identity keeps
    /// its old target. Called in the move's transaction; source bytes stay
    /// intact.
    pub(super) fn reanchor_moved_media(
        &self,
        tx: &rusqlite::Transaction<'_>,
        document: &Document,
        destination: &str,
    ) -> Result<()> {
        let references = tx
            .prepare("SELECT reference,identity FROM trusted_references WHERE doc=?")?
            .query_map([&document.id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let moved = Document {
            path: destination.into(),
            ..document.clone()
        };
        for (reference, approved) in references {
            let approves = |path: &Path| {
                fs::metadata(path)
                    .ok()
                    .and_then(|metadata| namespace::Identity::of(&metadata))
                    .is_some_and(|identity| Some(identity.as_str()) == approved.as_deref())
            };
            let before = self.media_path(document, &reference).ok().or_else(|| {
                approved.as_ref()?;
                self.left_folder_media(&document.path, &reference)
            });
            let stayed = before.as_deref().is_some_and(approves);
            if !stayed
                && self
                    .media_path(&moved, &reference)
                    .is_ok_and(|path| approves(&path))
            {
                continue;
            }
            if let Some(path) = before
                && (approved.is_none() || stayed)
            {
                // The file the old spelling named stays approved where it is.
                let pinned = approved.clone().or_else(|| {
                    let metadata = fs::metadata(&path).ok()?;
                    Some(namespace::Identity::of(&metadata)?.as_str().to_owned())
                });
                tx.execute(
                    "INSERT INTO grants(doc,path,identity) VALUES(?,?,?)
                     ON CONFLICT(doc,path) DO UPDATE SET identity=COALESCE(excluded.identity,identity)",
                    params![document.id, path.to_string_lossy(), pinned],
                )?;
            }
            tx.execute(
                "DELETE FROM trusted_references WHERE doc=? AND reference=?",
                params![document.id, reference],
            )?;
        }
        Ok(())
    }

    /// Where a reference that leaves its document's folder with `../` named a
    /// file before that folder moved away with the document. A document path
    /// never contains a link, so each step left a folder by its name.
    fn left_folder_media(&self, document: &str, reference: &str) -> Option<PathBuf> {
        let mut folder = Path::new(document).parent()?.to_path_buf();
        let mut rest = reference;
        while let Some(tail) = rest.strip_prefix("../") {
            if !folder.pop() {
                return None;
            }
            rest = tail;
        }
        if rest == reference {
            return None;
        }
        self.resolve_media(&folder, rest).ok()
    }

    /// While a document stays in its folder, a trusted reference approves
    /// whatever its spelling resolves to there, including an image replaced
    /// by an atomic save. Record those files, so a later move can tell
    /// whether they moved with it. A reference that resolves to nothing
    /// keeps the file it last named. `documents` are (id, row path) pairs.
    pub(super) fn refresh_media_identities(&self, documents: &[(&str, &str)]) -> Result<()> {
        if documents.is_empty() || !self.root_identity.matches(&self.root) {
            return Ok(());
        }
        let folders: HashMap<&str, &str> = documents.iter().copied().collect();
        let rows = self
            .db
            .lock()
            .unwrap()
            .prepare("SELECT doc,reference,identity FROM trusted_references")?
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let changed: Vec<(String, String, namespace::Identity)> = rows
            .into_iter()
            .filter_map(|(doc, reference, recorded)| {
                let current = self.media_identity(folders.get(doc.as_str())?, &reference)?;
                (recorded.as_deref() != Some(current.as_str())).then_some((doc, reference, current))
            })
            .collect();
        if !changed.is_empty() {
            let mut db = self.db.lock().unwrap();
            let tx = db.transaction()?;
            for (doc, reference, identity) in &changed {
                tx.execute(
                    "UPDATE trusted_references SET identity=? WHERE doc=? AND reference=?",
                    params![identity.as_str(), doc, reference],
                )?;
            }
            tx.commit()?;
        }
        self.follow_grants(&folders)
    }

    /// A grant pins the exact path an image stayed at when its document moved
    /// away. While a file is at that path, record it: an image replaced there
    /// in place stays approved, as before. Once the pinned file has left the
    /// path and is where an approved reference of the document now names it,
    /// as when its folder followed the document, the approval follows it and
    /// is relative again, like a trusted reference whose file moved with its
    /// document. A second name of a file still at its pinned path is never
    /// followed. `folders` maps documents seen at their row path to it.
    fn follow_grants(&self, folders: &HashMap<&str, &str>) -> Result<()> {
        let (grants, active) = {
            let db = self.db.lock().unwrap();
            let grants = db
                .prepare("SELECT doc,path,identity FROM grants")?
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let active = db
                .prepare(
                    "SELECT doc,reference FROM active_media
                     WHERE doc IN (SELECT doc FROM grants WHERE identity IS NOT NULL)",
                )?
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            (grants, active)
        };
        let mut recorded = Vec::new();
        let mut followed = Vec::new();
        for (doc, pinned, approved) in grants {
            let Some(&document) = folders.get(doc.as_str()) else {
                continue;
            };
            let current = Self::pinned_identity(&pinned);
            if current.is_some()
                && current.as_ref().map(namespace::Identity::as_str) == approved.as_deref()
            {
                continue;
            }
            let moved = approved.as_deref().and_then(|identity| {
                active
                    .iter()
                    .filter(|(owner, _)| *owner == doc)
                    .map(|(_, reference)| reference)
                    .find(|reference| {
                        self.media_identity(document, reference)
                            .is_some_and(|found| found.as_str() == identity)
                    })
            });
            match (moved, current) {
                (Some(reference), _) => {
                    followed.push((doc, pinned, reference.clone(), approved.unwrap()))
                }
                (None, Some(current)) => recorded.push((doc, pinned, current)),
                (None, None) => {}
            }
        }
        if recorded.is_empty() && followed.is_empty() {
            return Ok(());
        }
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        for (doc, pinned, identity) in &recorded {
            tx.execute(
                "UPDATE grants SET identity=? WHERE doc=? AND path=?",
                params![identity.as_str(), doc, pinned],
            )?;
        }
        for (doc, pinned, reference, identity) in &followed {
            tx.execute(
                "INSERT INTO trusted_references(doc,reference,identity) VALUES(?,?,?)
                 ON CONFLICT(doc,reference) DO UPDATE SET identity=excluded.identity",
                params![doc, reference, identity],
            )?;
            tx.execute(
                "DELETE FROM grants WHERE doc=? AND path=?",
                params![doc, pinned],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// The same refresh for one approved image the owner's editor loads, as
    /// long as the document's own file is at its row path.
    pub(super) fn refresh_served_media(
        &self,
        document: &Document,
        reference: &str,
        file: &fs::Metadata,
    ) {
        let Some(current) = namespace::Identity::of(file) else {
            return;
        };
        const RECORDED: &str = "SELECT t.identity,f.identity FROM trusted_references t
            LEFT JOIN document_identities f ON f.doc=t.doc WHERE t.doc=? AND t.reference=?";
        let recorded = self
            .db
            .lock()
            .unwrap()
            .query_row(RECORDED, params![document.id, reference], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            })
            .optional();
        let Ok(Some((approved, Some(own)))) = recorded else {
            return;
        };
        if approved.as_deref() == Some(current.as_str())
            || self.found_elsewhere(&document.id).is_some()
        {
            return;
        }
        let in_place = self
            .safe(&document.path, false)
            .ok()
            .and_then(|path| fs::symlink_metadata(path).ok())
            .and_then(|metadata| namespace::Identity::of(&metadata))
            .is_some_and(|identity| identity.as_str() == own);
        if !in_place {
            return;
        }
        if let Err(error) = self.db.lock().unwrap().execute(
            "UPDATE trusted_references SET identity=? WHERE doc=? AND reference=?",
            params![current.as_str(), document.id, reference],
        ) {
            tracing::debug!(document = document.id, "media identity pending: {error}");
        }
    }

    fn check_identity(db: &Connection, id: &str, incarnation: i64) -> Result<()> {
        let identity = db
            .query_row(
                "SELECT active,EXISTS(SELECT 1 FROM document_moves WHERE doc=docs.id),incarnation
                 FROM docs WHERE id=?",
                [id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, bool>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?;
        match identity {
            Some((1, false, current)) if current == incarnation => Ok(()),
            Some((1, true, current)) if current == incarnation => Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "A file move is being recovered. Your draft is kept here; try again shortly."
                    .into(),
            )),
            // Its accepted state waits, unchanged, for a restore; a room
            // loaded before the delete stays closed after it.
            Some((1 | 2, _, _)) => Err(ApiError(
                StatusCode::NOT_FOUND,
                "This document was moved to the trash. Your draft is kept here.".into(),
            )),
            _ => Err(ApiError(
                StatusCode::NOT_FOUND,
                "This document was removed. Your draft is kept for recovery.".into(),
            )),
        }
    }

    pub(super) fn room(&self, d: &Document) -> Result<Arc<Mutex<Room>>> {
        self.seed_active_media(d)?;
        let cached = self.rooms.lock().unwrap().get(&d.id).cloned();
        if let Some(r) = cached {
            self.commit_pending(d, &mut r.lock().unwrap())?;
            return Ok(r);
        }
        let _loading = self.room_loads.acquire(&d.id);
        let cached = self.rooms.lock().unwrap().get(&d.id).cloned();
        if let Some(r) = cached {
            self.commit_pending(d, &mut r.lock().unwrap())?;
            return Ok(r);
        }
        {
            let mut rooms = self.rooms.lock().unwrap();
            if rooms.len() >= 64 {
                rooms.retain(|_, r| {
                    Arc::strong_count(r) > 1
                        || match r.try_lock() {
                            Ok(r) => r.engine.state.needs_projection(),
                            Err(_) => true,
                        }
                });
            }
            if rooms.len() >= 128 {
                return Err(ApiError(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Too many active documents. Try again shortly.".into(),
                ));
            }
        }
        const STORED: &str = "SELECT state,disk_state,write_intent,line_ending,
            line_ending_migrated,browser_generation,protected_generation,
            write_target,write_before_hash,write_before,write_state,incarnation
            FROM docs WHERE id=?";
        let StoredRoom {
            state: saved,
            baseline,
            intent: recovering,
            target,
            target_state,
            before_hash,
            before,
            ending: mut line_ending,
            migrated: mut line_ending_migrated,
            browser_generation,
            protected_generation,
            incarnation,
        } = self.db.lock().unwrap().query_row(STORED, [&d.id], |row| {
            Ok(StoredRoom {
                state: row.get(0)?,
                baseline: row.get(1)?,
                intent: row.get(2)?,
                ending: row.get(3)?,
                migrated: row.get(4)?,
                browser_generation: row.get(5)?,
                protected_generation: row.get(6)?,
                target: row.get(7)?,
                before_hash: row.get(8)?,
                before: row.get(9)?,
                target_state: row.get(10)?,
                incarnation: row.get(11)?,
            })
        })?;
        if !(0..=2).contains(&recovering) || (recovering == 2 && target.is_none()) {
            return Err(bad(
                "Invalid saved projection phase. Export recovery data before repairing this document.",
            ));
        }
        if let Some(state) = target_state.as_deref() {
            let frozen = Doc::with_options(Options {
                offset_kind: OffsetKind::Utf16,
                ..Options::default()
            });
            frozen
                .transact_mut()
                .apply_update(
                    security::decode_update(state)
                        .map_err(|_| bad("Invalid frozen projection state."))?,
                )
                .map_err(|_| bad("Invalid frozen projection state."))?;
            let source = security::validate_document(&frozen)?;
            if target
                .as_ref()
                .is_some_and(|target| text::canonical(&String::from_utf8_lossy(target)) != source)
            {
                return Err(bad(
                    "Frozen projection bytes and state do not match. Export recovery data before repairing.",
                ));
            }
        }
        if before.as_ref().is_some_and(|bytes| bytes.len() > 5 * MB) {
            return Err(bad("Invalid saved write preimage."));
        }
        let updates: Vec<Vec<u8>> = {
            let db = self.db.lock().unwrap();
            let mut q = db.prepare("SELECT content FROM doc_updates WHERE doc=? ORDER BY seq")?;
            q.query_map([&d.id], |row| row.get(0))?
                .collect::<std::result::Result<_, _>>()?
        };
        let doc = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        if let Some(bytes) = &saved {
            doc.transact_mut()
                .apply_update(
                    security::decode_update(bytes).map_err(|_| bad("Invalid saved state."))?,
                )
                .map_err(|_| bad("Invalid saved state."))?;
        } else {
            let mut file = DiskFile::open_read(&self.safe(&d.path, false)?)?
                .ok_or_else(|| ApiError(StatusCode::CONFLICT, "A desktop application is saving this file. Try opening it again when finished.".into()))?;
            // Only the file a pass matched to this document seeds its state.
            if self.unmatched_file(&d.id, &file.metadata()?)? {
                return Err(ApiError(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "This file is still being matched to its document. Try again shortly.".into(),
                ));
            }
            let raw = file.read()?;
            line_ending = text::ending(&raw, &line_ending);
            let disk = text::canonical(&raw);
            apply_text(&doc, "", &disk);
            // No view of the document can be open before its first load, so
            // nobody waits for media this approves.
            self.grant_new_references(d, "", &disk)?;
        }
        for update in &updates {
            doc.transact_mut()
                .apply_update(
                    security::decode_update(update).map_err(|_| bad("Invalid saved update."))?,
                )
                .map_err(|_| bad("Invalid saved update."))?;
        }
        let original = doc
            .get_or_insert_text("content")
            .get_string(&doc.transact());
        if original.contains('\r') {
            line_ending = text::ending(&original, &line_ending);
            line_ending_migrated = true;
        }
        let had_baseline = baseline.is_some();
        let disk_state: Arc<[u8]> = baseline
            .or_else(|| saved.clone())
            .unwrap_or_else(|| {
                doc.transact()
                    .encode_state_as_update_v1(&StateVector::default())
            })
            .into();
        let persisted_disk = if had_baseline {
            disk_state.clone()
        } else {
            Arc::from([])
        };
        let disk_doc = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        disk_doc
            .transact_mut()
            .apply_update(
                security::decode_update(&disk_state).map_err(|_| bad("Invalid disk baseline."))?,
            )
            .map_err(|_| bad("Invalid disk baseline."))?;
        let before_normalizing = disk_doc.transact().state_vector();
        let migrated_baseline = text::normalize(&disk_doc);
        if migrated_baseline {
            line_ending_migrated = true;
            let delta = disk_doc
                .transact()
                .encode_state_as_update_v1(&before_normalizing);
            doc.transact_mut()
                .apply_update(
                    security::decode_update(&delta)
                        .map_err(|_| bad("Invalid line-ending migration."))?,
                )
                .map_err(|_| bad("Invalid line-ending migration."))?;
        }
        // Canonicalize live-only edits too, without resurrecting separators a
        // pending browser edit had deleted from the old disk baseline.
        let after = doc
            .get_or_insert_text("content")
            .get_string(&doc.transact());
        apply_text(&doc, &after, &text::canonical(&original));
        let disk_state: Arc<[u8]> = if migrated_baseline {
            disk_doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default())
                .into()
        } else {
            disk_state
        };
        let disk = disk_doc
            .get_or_insert_text("content")
            .get_string(&disk_doc.transact());
        security::validate_document(&doc)?;
        security::validate_document(&disk_doc)?;
        let (tx, _) = broadcast::channel(256);
        let pending_updates = Arc::new(Mutex::new(Vec::new()));
        let pending = pending_updates.clone();
        let validation = validation::Validated::new(&doc)?;
        let validation_updates = validation.updates();
        doc.observe_update_v1("durable-outbox", move |_, event| {
            pending.lock().unwrap().push(event.update.clone());
            validation_updates.push(&event.update);
        })
        .map_err(|_| bad("Cannot observe document updates."))?;
        let write_target = (recovering != 0).then(|| {
            target
                .unwrap_or_else(|| {
                    text::render(&text::canonical(&original), &line_ending).into_bytes()
                })
                .into()
        });
        let r = Arc::new(Mutex::new(Room {
            awareness: Awareness::new(doc),
            tx,
            engine: DocumentEngine {
                validation,
                state: save::SaveState::loaded(save::Loaded {
                    source: disk,
                    baseline: disk_state,
                    persisted_baseline: persisted_disk,
                    ending: line_ending,
                    migrated: line_ending_migrated,
                    target: write_target,
                    target_state: target_state.map(Arc::from),
                    conflicted: recovering == 2,
                    before_hash,
                    before: before.map(Arc::from),
                    generation: browser_generation,
                    protected: protected_generation,
                }),
                journal: save::Journal::loaded(
                    original.contains('\r') || migrated_baseline || saved.is_none(),
                    updates.len(),
                    updates.iter().map(Vec::len).sum(),
                ),
                pending_updates,
                usage: None,
                pending_media: HashSet::new(),
                pending_metadata: HashMap::new(),
                published_projection: None,
                incarnation,
            },
        }));
        self.commit_pending(d, &mut r.lock().unwrap())?;
        let mut rooms = self.rooms.lock().unwrap();
        if rooms.len() >= 128 {
            return Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "Too many active documents. Try again shortly.".into(),
            ));
        }
        rooms.insert(d.id.clone(), r.clone());
        Ok(r)
    }
    /// What durable state says this document's file last held, is being
    /// written or will hold once accepted edits are projected, each canonical
    /// as an import reads a file. Only the owner's restore pass compares files
    /// by content. State that cannot be decoded tells nothing.
    pub(super) fn known_contents(&self, id: &str) -> Result<Vec<String>> {
        const STORED: &str = "SELECT state,disk_state,write_target FROM docs WHERE id=?";
        let [state, baseline, target]: [Option<Vec<u8>>; 3] =
            self.db.lock().unwrap().query_row(STORED, [id], |row| {
                Ok([row.get(0)?, row.get(1)?, row.get(2)?])
            })?;
        let updates: Vec<Vec<u8>> = {
            let db = self.db.lock().unwrap();
            let mut q = db.prepare("SELECT content FROM doc_updates WHERE doc=? ORDER BY seq")?;
            q.query_map([id], |row| row.get(0))?
                .collect::<std::result::Result<_, _>>()?
        };
        let decoded = |parts: &[&[u8]]| {
            let doc = Doc::with_options(Options {
                offset_kind: OffsetKind::Utf16,
                ..Options::default()
            });
            for part in parts {
                let update = security::decode_update(part).ok()?;
                doc.transact_mut().apply_update(update).ok()?;
            }
            security::validate_document(&doc)
                .ok()
                .map(|source| text::canonical(&source))
        };
        let mut contents = Vec::new();
        // A room's disk baseline falls back to its saved state the same way.
        if let Some(disk) = baseline.as_deref().or(state.as_deref()) {
            contents.extend(decoded(&[disk]));
        }
        if let Some(target) = target.and_then(|bytes| String::from_utf8(bytes).ok()) {
            contents.push(text::canonical(&target));
        }
        if let Some(state) = state.as_deref() {
            let parts: Vec<&[u8]> = std::iter::once(state)
                .chain(updates.iter().map(Vec::as_slice))
                .collect();
            contents.extend(decoded(&parts));
        }
        contents.sort();
        contents.dedup();
        Ok(contents)
    }
    /// For the owner's restore pass only, before the folder is accepted. The
    /// database backup can hold accepted edits still waiting for their
    /// projection, which may have reached the file before the documents
    /// folder was copied. Importing that file against the older baseline
    /// would apply those edits a second time. Unless the file still holds the
    /// last projected text, it wins as any file changed between the backup
    /// steps does: the accepted state becomes its baseline and the accepted
    /// text stays in version history. An interrupted write keeps its own
    /// recovery.
    pub(super) fn rebase_restored(&self, d: &Document) -> Result<()> {
        const STORED: &str = "SELECT state,disk_state,write_intent FROM docs WHERE id=?";
        let (state, baseline, intent): (Option<Vec<u8>>, Option<Vec<u8>>, i64) =
            self.db.lock().unwrap().query_row(STORED, [&d.id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?;
        let Some(state) = state.filter(|_| intent == 0) else {
            return Ok(());
        };
        let updates: Vec<Vec<u8>> = {
            let db = self.db.lock().unwrap();
            let mut q = db.prepare("SELECT content FROM doc_updates WHERE doc=? ORDER BY seq")?;
            q.query_map([&d.id], |row| row.get(0))?
                .collect::<std::result::Result<_, _>>()?
        };
        let decoded = |parts: &[&[u8]]| {
            let doc = Doc::with_options(Options {
                offset_kind: OffsetKind::Utf16,
                ..Options::default()
            });
            for part in parts {
                doc.transact_mut()
                    .apply_update(security::decode_update(part).ok()?)
                    .ok()?;
            }
            let source = text::canonical(&security::validate_document(&doc).ok()?);
            Some((doc, source))
        };
        let parts: Vec<&[u8]> = std::iter::once(state.as_slice())
            .chain(updates.iter().map(Vec::as_slice))
            .collect();
        // Undecodable state needs owner recovery whatever the file holds.
        let (Some((accepted, source)), Some((_, projected))) = (
            decoded(&parts),
            decoded(&[baseline.as_deref().unwrap_or(&state)]),
        ) else {
            return Ok(());
        };
        if source == projected {
            return Ok(());
        }
        let mut file = DiskFile::open_read(&self.safe(&d.path, false)?)?.ok_or_else(|| {
            ApiError(
                StatusCode::CONFLICT,
                "The file is busy or cannot be read.".into(),
            )
        })?;
        // Only the file the pass placed for this document is compared.
        if self.unmatched_file(&d.id, &file.metadata()?)? {
            return Ok(());
        }
        // An import refuses such a file anyway.
        let Ok(raw) = file.read() else {
            return Ok(());
        };
        let restored = text::canonical(&raw);
        if restored == projected {
            return Ok(());
        }
        if restored != source {
            self.snapshot(d, &source, true)?;
        }
        self.db.lock().unwrap().execute(
            "UPDATE docs SET disk_state=? WHERE id=?",
            params![
                accepted
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default()),
                d.id
            ],
        )?;
        Ok(())
    }
    fn archive_observed(&self, d: &Document, bytes: &[u8]) -> Result<()> {
        use std::io::Write;
        let folder = self.data.join("recovery");
        fs::create_dir_all(&folder)?;
        let digest = hex::encode(Sha256::digest(bytes));
        let path = folder.join(format!("{}-{digest}.bin", d.id));
        if fs::read(&path).is_ok_and(|existing| existing == bytes) {
            return Ok(());
        }
        let temporary = folder.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
        let result: Result<()> = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            fs::rename(&temporary, &path)?;
            fs::File::open(&folder)?.sync_all()?;
            fs::File::open(&self.data)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result?;
        Ok(())
    }
    /// Documents whose durable state still has edits to project, or one of
    /// them.
    fn unprojected(&self, id: Option<&str>) -> Result<Vec<Document>> {
        let db = self.db.lock().unwrap();
        let mut q = db.prepare("SELECT id,path,permission,token FROM docs WHERE active=1 AND (?1 IS NULL OR id=?1) AND state IS NOT NULL AND (write_intent!=0 OR disk_state IS NULL OR state!=disk_state OR EXISTS(SELECT 1 FROM doc_updates WHERE doc=docs.id))")?;
        Ok(q.query_map([id], |r| {
            Ok(Document {
                id: r.get(0)?,
                path: r.get(1)?,
                permission: r.get(2)?,
                token: r.get(3)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?)
    }
    pub(super) fn recover_pending(&self) -> Result<()> {
        for d in self.unprojected(None)? {
            let result = (|| -> Result<bool> {
                let room = self.room(&d)?;
                self.project_now(&d, &mut room.lock().unwrap())
            })();
            match result {
                Ok(true) => {
                    self.rooms.lock().unwrap().remove(&d.id);
                }
                Ok(false) => {}
                Err(error) => tracing::error!("document {} needs owner recovery: {error}", d.id),
            }
        }
        Ok(())
    }
    /// Documents back from the trash may hold accepted edits that were
    /// still waiting for projection when they left. Project them now rather
    /// than when someone next opens them. Their rooms stay open: a socket
    /// may already have joined one.
    pub(super) fn recover_restored(&self, ids: &[String]) {
        for id in ids {
            let result = self.unprojected(Some(id)).and_then(|documents| {
                for d in documents {
                    let room = self.room(&d)?;
                    room.lock().unwrap().reconcile(self, &d)?;
                }
                Ok(())
            });
            if let Err(error) = result {
                tracing::warn!(document = id, "restored edits wait for projection: {error}");
            }
        }
    }
    pub(super) fn snapshot(&self, d: &Document, content: &str, force: bool) -> Result<()> {
        let db = self.db.lock().unwrap();
        let latest: Option<(i64, String)> = db
            .query_row(
                "SELECT created,content FROM revisions WHERE doc=? AND kind=? ORDER BY rowid DESC LIMIT 1",
                params![d.id, if force { "recovery" } else { "autosave" }],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if latest
            .as_ref()
            .is_some_and(|(time, body)| body == content || (!force && now() - time < 30))
        {
            return Ok(());
        }
        db.execute(
            "INSERT INTO revisions(id,doc,content,created,kind) VALUES(?,?,?,?,?)",
            params![
                uuid::Uuid::new_v4().to_string(),
                d.id,
                content,
                now(),
                if force { "recovery" } else { "autosave" }
            ],
        )?;
        const RETAIN_VERSIONS: &str = "DELETE FROM revisions WHERE doc=? AND kind=?
            AND id NOT IN(SELECT id FROM revisions WHERE doc=? AND kind=?
                ORDER BY rowid DESC LIMIT ?)";
        let kind = if force { "recovery" } else { "autosave" };
        db.execute(
            RETAIN_VERSIONS,
            params![d.id, kind, d.id, kind, if force { 20 } else { 50 }],
        )?;
        Ok(())
    }
    fn project_scheduled(&self, d: &Document, r: &mut Room) -> Result<bool> {
        if self
            .safe(&d.path, false)
            .ok()
            .is_some_and(|path| !r.engine.state.observed_file(disk::Stamp::read(&path)))
        {
            r.engine.state.desktop_changed();
        }
        let large = r
            .awareness
            .doc()
            .get_or_insert_text("content")
            .len(&r.awareness.doc().transact())
            >= 128 * 1024;
        if r.engine.state.projection_delayed(large) {
            self.commit_pending(d, r)?;
            return Ok(!r.engine.state.needs_projection());
        }
        self.project_now(d, r)
    }
    fn project_now(&self, d: &Document, r: &mut Room) -> Result<bool> {
        let result = self.persist_now(d, r);
        let large = r
            .awareness
            .doc()
            .get_or_insert_text("content")
            .len(&r.awareness.doc().transact())
            >= 128 * 1024;
        r.engine.state.projection_result(&result, large);
        result
    }
    fn persist_now(&self, d: &Document, r: &mut Room) -> Result<bool> {
        // A client may have queued an update just before an owner rename.
        let current = self.doc(&d.id)?;
        let d = &current;
        if now() - r.engine.state.snapshot_at >= 30 {
            self.snapshot(d, r.engine.state.source(), false)?;
            r.engine.state.snapshot_at = now();
        }
        let was_synced = !r.engine.state.needs_projection()
            && r.engine.pending_updates.lock().unwrap().is_empty();
        r.engine.state.request();
        // Accepted updates are durable before examining the filesystem. An
        // interrupted projection retains its intent even when new edits arrive.
        self.commit_pending(d, r)?;
        if r.engine.state.conflicted() {
            return Ok(false);
        }
        let path = match self.safe(&d.path, false) {
            Ok(path) => path,
            Err(error) if error.0 == StatusCode::SERVICE_UNAVAILABLE => {
                r.waiting();
                return Ok(false);
            }
            Err(error) => return Err(error),
        };
        let writer = if !was_synced
            && (r.engine.state.interrupted() || room_text(r) != r.engine.state.source())
        {
            DiskFile::open(&path)?
        } else {
            None
        };
        let Some(mut file) = (match writer {
            Some(file) => Some(file),
            // A read lease excludes desktop writers, but permits importing a
            // completed save while an unrelated reader still has the file open.
            None => DiskFile::open_read(&path)?,
        }) else {
            r.waiting();
            return Ok(false);
        };
        // Neither import nor overwrite a file no pass has matched to this
        // document. Accepted text waits in the room until a pass decides.
        if self.unmatched_file(&d.id, &file.metadata()?)? {
            r.waiting();
            return Ok(false);
        }
        let observed = file.read_bytes();
        r.engine.state.observe_file(file.stamp());
        let observed = observed?;
        let old_projection = text::render(r.engine.state.source(), r.engine.state.ending());
        let before = r.engine.state.before().unwrap_or(old_projection.as_bytes());
        let baseline_intact = r
            .engine
            .state
            .before_hash()
            .is_none_or(|expected| hex::encode(Sha256::digest(before)) == expected);
        let recoverable = r.engine.state.target().is_some_and(|target| {
            observed == target || (baseline_intact && text::interrupted(before, target, &observed))
        });
        if r.engine
            .state
            .target()
            .is_some_and(|target| observed != target)
            && !recoverable
        {
            // Files and SQLite cannot commit atomically. A completed desktop
            // replacement after an interrupted write has an unknown causal
            // base. Preserve every version and require an explicit owner
            // choice instead of guessing a diff which can duplicate/delete it.
            self.archive_observed(d, &observed)?;
            self.snapshot(d, &room_text(r), true)?;
            if let Ok(raw) = std::str::from_utf8(&observed) {
                self.snapshot(d, &text::canonical(raw), true)?;
            }
            r.engine.state.conflict();
            self.commit_pending(d, r)?;
            return Ok(false);
        }
        let raw_disk = match String::from_utf8(observed.clone()) {
            Ok(source) => source,
            Err(_) if recoverable => String::from_utf8_lossy(&observed).into_owned(),
            Err(_) => {
                return Err(bad(
                    "The desktop file is not valid UTF-8. Your accepted edits remain in local storage.",
                ));
            }
        };
        if r.engine
            .state
            .target()
            .is_some_and(|target| observed != target)
        {
            self.archive_observed(d, &observed)?;
            self.snapshot(d, &text::canonical(&raw_disk), true)?;
        }
        if !recoverable {
            r.engine.state.observe_ending(&raw_disk);
        }
        let disk = text::canonical(&raw_disk);
        if was_synced && disk == r.engine.state.source() {
            // A read of an unchanged, already fsynced document must not create
            // another full baseline and SQLite fsync. Source-identical edits
            // still take the normal path because their CRDT journal is pending.
            if !file.is_current(&path) || !file.intact() {
                r.waiting();
                return Ok(false);
            }
            self.commit_pending(d, r)?; // persist an external line-ending change
            r.engine.state.complete();
            return Ok(true);
        }
        if !r.engine.state.interrupted() && disk != r.engine.state.source() {
            if r.engine.state.unprotected() {
                self.snapshot(d, &room_text(r), true)?;
                r.engine.state.protect();
            }
            let approved =
                self.grant_desktop_references(d, r.engine.state.source(), &room_text(r), &disk)?;
            let baseline = Doc::with_options(Options {
                offset_kind: OffsetKind::Utf16,
                ..Options::default()
            });
            baseline
                .transact_mut()
                .apply_update(
                    security::decode_update(r.engine.state.baseline())
                        .map_err(|_| bad("Invalid disk baseline."))?,
                )
                .map_err(|_| bad("Invalid disk baseline."))?;
            let baseline_vector = baseline.transact().state_vector();
            apply_text(&baseline, r.engine.state.source(), &disk);
            let desktop_update = baseline
                .transact()
                .encode_state_as_update_v1(&baseline_vector);
            r.awareness
                .doc()
                .transact_mut()
                .apply_update(
                    security::decode_update(&desktop_update)
                        .map_err(|_| bad("Invalid desktop update."))?,
                )
                .map_err(|_| bad("Invalid desktop update."))?;
            r.engine.state.imported(
                disk.clone(),
                baseline
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default()),
            );
            // Source and causal baseline must survive before peers see imports.
            self.commit_pending(d, r)?;
            if approved {
                r.media_approved();
            }
        }
        let source = room_text(r);
        self.settle_uploads(d, &source)?;
        if source != disk && !file.writable() {
            self.commit_pending(d, r)?;
            r.waiting();
            return Ok(false);
        }
        if !file.is_current(&path) || !file.excludes_writers() {
            r.waiting();
            return Ok(false);
        }
        let projection = if source != disk {
            text::projection(
                r.awareness.doc(),
                r.engine.state.baseline(),
                r.engine.state.source(),
                &source,
                r.engine.state.ending(),
            )?
        } else {
            raw_disk
        };
        if source != disk {
            // Freeze before touching bytes. Cancellation before file.write
            // restores the previous phase, including any older recovery intent.
            let frozen = r
                .awareness
                .doc()
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            let attempt = r.engine.state.prepare_observed_write(
                projection.as_bytes().to_vec(),
                frozen,
                &observed,
            );
            if let Err(error) = self.commit_pending(d, r) {
                r.engine.state.cancel_unwritten(attempt);
                return Err(error);
            }
            if !file.is_current(&path) || !file.excludes_writers() {
                r.engine.state.cancel_unwritten(attempt);
                // Keep the lease until cancellation is durable. If SQLite
                // fails, the restored phase remains pending for the commit
                // barrier to retry; a crash still retains the durable intent.
                self.commit_pending(d, r)?;
                r.waiting();
                return Ok(false);
            }
            // From this call onward any failure may have changed file bytes;
            // preserve the durable intent for actual interrupted-write recovery.
            let written = file.write(&projection);
            r.engine.state.observe_file(file.stamp());
            written?;
        }
        if !file.is_current(&path) {
            r.engine.state.external_save();
            self.commit_pending(d, r)?;
            r.waiting();
            return Ok(false);
        }
        let state = r
            .awareness
            .doc()
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        r.engine.state.observe_ending(&projection);
        r.engine.state.projected(source, state);
        self.commit_pending(d, r)?;
        r.engine.state.complete();
        let usage = self.usage(d, r.engine.state.source());
        if r.engine.usage != Some(usage) {
            r.engine.usage = Some(usage);
            let _ =
                r.tx.send(Message::Custom(123, usage.to_string().into_bytes()).encode_v1());
        }
        for (_, receipt) in r.engine.state.receipts.drain() {
            let _ =
                r.tx.send(Message::Custom(127, receipt.into_bytes()).encode_v1());
        }
        // All readers, including a new read-only visitor, now observe the same
        // fsynced projection state. Receipts remain ordered per writing socket.
        r.publish_projection();
        Ok(true)
    }
    fn commit_pending(&self, d: &Document, r: &mut Room) -> Result<()> {
        self.commit_command(d, r, &[])
    }
    fn commit_command(&self, d: &Document, r: &mut Room, rows: &[Value]) -> Result<()> {
        // The command owns metadata until the SAME transaction as its source
        // succeeds. A failed write is retried whole, never as an orphan delta.
        for row in rows {
            let id = row["id"]
                .as_str()
                .ok_or_else(|| bad("Invalid comment metadata."))?;
            r.engine.pending_metadata.insert(id.to_owned(), row.clone());
        }
        let mut pending = r.engine.pending_updates.lock().unwrap();
        let checkpoint = r.engine.journal.checkpoint(&pending);
        let state = checkpoint.then(|| {
            r.awareness
                .doc()
                .transact()
                .encode_state_as_update_v1(&StateVector::default())
        });
        if pending.is_empty()
            && !checkpoint
            && !r.engine.state.needs_commit()
            && r.engine.pending_metadata.is_empty()
            && r.engine.pending_media.is_empty()
        {
            // Retirement and command admission use the same room lock. Even
            // a no-op sync/checkpoint must not revive an inactive identity.
            Self::check_identity(&self.db.lock().unwrap(), &d.id, r.engine.incarnation)?;
            return Ok(());
        }
        let current_references = r
            .engine
            .validation
            .references_as(r.awareness.doc(), documents::has_media(&d.path))?;
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        Self::check_identity(&tx, &d.id, r.engine.incarnation)?;
        if let Some(state) = &state {
            tx.execute("UPDATE docs SET state=? WHERE id=?", params![state, d.id])?;
            tx.execute("DELETE FROM doc_updates WHERE doc=?", [&d.id])?;
        } else {
            for update in pending.iter() {
                tx.execute(
                    "INSERT INTO doc_updates(doc,content) VALUES(?,?)",
                    params![d.id, update],
                )?;
            }
        }
        if r.engine.state.baseline_changed() {
            tx.execute(
                "UPDATE docs SET disk_state=? WHERE id=?",
                params![r.engine.state.baseline(), d.id],
            )?;
        }
        if r.engine.state.target_changed() {
            tx.execute(
                "UPDATE docs SET write_target=?,write_before=?,write_state=? WHERE id=?",
                params![
                    r.engine.state.target(),
                    r.engine.state.before(),
                    r.engine.state.target_state(),
                    d.id
                ],
            )?;
        }
        const SAVE_METADATA: &str = "UPDATE docs SET write_intent=?,write_before_hash=?,
            line_ending=?,line_ending_migrated=?,browser_generation=?,protected_generation=?
            WHERE id=?";
        tx.execute(
            SAVE_METADATA,
            params![
                r.engine.state.intent_code(),
                r.engine.state.before_hash(),
                r.engine.state.ending(),
                r.engine.state.migrated(),
                r.engine.state.generation(),
                r.engine.state.protected(),
                d.id
            ],
        )?;
        const SAVE_COMMENT: &str = "INSERT INTO comments(id,doc,guest,data) VALUES(?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET guest=excluded.guest,data=excluded.data";
        for c in r.engine.pending_metadata.values() {
            tx.execute(
                SAVE_COMMENT,
                params![
                    c["id"].as_str(),
                    d.id,
                    c["guest"].as_str().unwrap_or(""),
                    c.to_string()
                ],
            )?;
        }
        self.commit_media_references(&tx, d, &current_references, &r.engine.pending_media)?;
        tx.commit()?;
        r.engine.pending_metadata.clear();
        r.engine.pending_media.clear();
        r.engine.journal.committed(checkpoint, &pending);
        r.engine.state.committed();
        for delta in pending.drain(..) {
            let _ =
                r.tx.send(Message::Sync(SyncMessage::Update(delta)).encode_v1());
        }
        drop(pending);
        r.publish_projection();
        Ok(())
    }
    pub(super) fn settle_uploads(&self, d: &Document, content: &str) -> Result<()> {
        let paths: HashSet<_> = Self::media_references(d, content)
            .iter()
            .filter_map(|reference| self.media_path(d, reference).ok())
            .filter_map(|path| {
                path.strip_prefix(&self.root)
                    .ok()
                    .map(|p| p.to_string_lossy().into_owned())
            })
            .collect();
        let db = self.db.lock().unwrap();
        for path in paths {
            db.execute(
                "UPDATE assets SET pending_until=0 WHERE doc=? AND path=? AND pending_until!=0",
                params![d.id, path],
            )?;
        }
        Ok(())
    }
}
impl Room {
    pub(super) fn conflicted(&self) -> bool {
        self.engine.conflicted()
    }
    #[cfg(test)]
    pub(super) fn freeze_projection(&mut self, bytes: Vec<u8>) {
        let state = self
            .awareness
            .doc()
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        self.engine.state.prepare_write(bytes, state);
    }
    #[cfg(test)]
    pub(super) fn freeze_observed_projection(&mut self, bytes: Vec<u8>, before: &[u8]) {
        let state = self
            .awareness
            .doc()
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        self.engine
            .state
            .prepare_observed_write(bytes, state, before);
    }
    pub(super) fn pending_comment_metadata(&self) -> Vec<Value> {
        self.engine.pending_metadata.values().cloned().collect()
    }
    pub(super) fn references(
        &mut self,
        store: &Store,
        document: &Document,
    ) -> Result<HashSet<String>> {
        self.ensure_committed(store, document)?;
        self.engine
            .validation
            .references_as(self.awareness.doc(), documents::has_media(&document.path))
    }
    /// The owner's approval of current media references for link visitors,
    /// as a desktop edit adding them would approve them: trusted from the
    /// document's folder and active while the source names them. Each must
    /// be a current reference whose file `media::publishable` accepts.
    /// Returns the approved references and the refused ones with why.
    #[allow(clippy::type_complexity)]
    pub(super) fn share_media(
        &mut self,
        store: &Store,
        document: &Document,
        requested: &[String],
    ) -> Result<(Vec<String>, Vec<(String, &'static str)>)> {
        let references = self.references(store, document)?;
        let mut seen = HashSet::new();
        let mut approved = Vec::new();
        let mut refused = Vec::new();
        for reference in requested {
            if !seen.insert(reference) {
                continue;
            }
            if !references.contains(reference) {
                refused.push((reference.clone(), "unreferenced"));
                continue;
            }
            match media::publishable(store, document, reference) {
                Ok(identity) => approved.push((reference.clone(), identity)),
                Err(reason) => refused.push((reference.clone(), reason)),
            }
        }
        if !approved.is_empty() {
            let mut db = store.db.lock().unwrap();
            let tx = db.transaction()?;
            Store::check_identity(&tx, &document.id, self.engine.incarnation)?;
            for (reference, identity) in &approved {
                tx.execute(
                    "INSERT OR IGNORE INTO active_media(doc,reference) VALUES(?,?)",
                    params![document.id, reference],
                )?;
                tx.execute(
                    "INSERT INTO trusted_references(doc,reference,identity) VALUES(?,?,?)
                     ON CONFLICT(doc,reference) DO UPDATE SET identity=COALESCE(excluded.identity,identity)",
                    params![
                        document.id,
                        reference,
                        identity.as_ref().map(namespace::Identity::as_str)
                    ],
                )?;
            }
            tx.commit()?;
            self.media_approved();
        }
        Ok((
            approved
                .into_iter()
                .map(|(reference, _)| reference)
                .collect(),
            refused,
        ))
    }
    /// Tells every open view of the document, link visitors' included, that
    /// an approval it has just committed may let it serve media they could
    /// not load, so each requests that media once more. The signal names
    /// nothing a visitor could not already see.
    fn media_approved(&self) {
        let _ = self
            .tx
            .send(Message::Custom(MEDIA_APPROVED, Vec::new()).encode_v1());
    }
    pub(super) fn detach(&mut self, peer: &Peer) {
        self.engine.state.receipts.remove(&peer.id);
        if let Some(client) = peer.presence.client() {
            self.awareness.remove_state(client);
            if let Ok(update) = self.awareness.update_with_clients([client]) {
                let _ = self.tx.send(Message::Awareness(update).encode_v1());
            }
        }
    }
    pub(super) fn restore(
        &mut self,
        store: &Store,
        document: &Document,
        content: &str,
    ) -> Result<()> {
        self.restore_checked(store, document, content, None)
    }
    pub(super) fn restore_if_current(
        &mut self,
        store: &Store,
        document: &Document,
        content: &str,
        expected_revision: &str,
    ) -> Result<()> {
        self.restore_checked(store, document, content, Some(expected_revision))
    }
    fn restore_checked(
        &mut self,
        store: &Store,
        document: &Document,
        content: &str,
        expected_revision: Option<&str>,
    ) -> Result<()> {
        if !self.flush_to_disk(store, document)? {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Finish the desktop save before restoring a version.".into(),
            ));
        }
        // The flush can import a completed desktop save. Preconditions belong
        // here, after that import, rather than in an HTTP/MCP adapter before it.
        if expected_revision.is_some_and(|expected| hash(&room_text(self)) != expected) {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Document changed. Read it again before restoring.".into(),
            ));
        }
        store.snapshot(document, self.engine.state.source(), true)?;
        let content = text::canonical(content);
        // Restoring a version re-activates media it already authorized, but it
        // must not newly approve a file the document never had access to: the
        // restored source may come from a connector that controls it. An edit
        // cannot publish an unapproved local file, and neither can a restore.
        let approved = store.authorized_references(document, &content)?;
        self.edit_media(store, document, approved, |room| {
            apply_text(room.awareness.doc(), &room_text(room), &content);
            Vec::new()
        })?;
        Ok(())
    }
    pub(super) fn visit_filesystem(
        &mut self,
        store: &Store,
        document: &Document,
        changed: bool,
    ) -> Result<()> {
        if changed
            && !self
                .engine
                .state
                .observed_file(disk::Stamp::read(&store.root.join(&document.path)))
        {
            self.engine.state.desktop_changed();
        }
        if self.engine.state.needs_projection() && self.engine.state.projection_due() {
            self.reconcile(store, document)?;
        }
        Ok(())
    }
    #[cfg(test)]
    pub(super) fn journal_len(&self) -> usize {
        self.engine.journal.len()
    }
    /// One acceptance boundary for browser operations, comments and restores.
    /// Callers must complete validation before making their source mutation.
    fn accept(
        &mut self,
        store: &Store,
        document: &Document,
        rows: &[Value],
        media: HashSet<String>,
    ) -> Result<()> {
        if !self.engine.pending_updates.lock().unwrap().is_empty() {
            self.engine.state.edited();
        }
        self.engine.pending_media.extend(media);
        store.commit_command(document, self, rows)
    }

    #[cfg(test)]
    pub(super) fn accept_test_command(
        &mut self,
        store: &Store,
        document: &Document,
        rows: &[Value],
    ) -> Result<()> {
        self.accept(store, document, rows, HashSet::new())
    }

    pub(super) fn ensure_committed(&mut self, store: &Store, document: &Document) -> Result<()> {
        store.commit_pending(document, self)
    }

    /// Commands construct all fallible syntax/permission checks first. Their
    /// final source edits and metadata are retained together on storage errors.
    pub(super) fn edit(
        &mut self,
        store: &Store,
        document: &Document,
        command: impl FnOnce(&Room) -> Vec<Value>,
    ) -> Result<Vec<Value>> {
        self.edit_media(store, document, HashSet::new(), command)
    }

    /// `edit`, additionally marking `media` references as approved for this
    /// command so they stay authorized for link visitors. Callers pass only
    /// references the document may already serve; an edit never approves a new
    /// local file on its own.
    pub(super) fn edit_media(
        &mut self,
        store: &Store,
        document: &Document,
        media: HashSet<String>,
        command: impl FnOnce(&Room) -> Vec<Value>,
    ) -> Result<Vec<Value>> {
        self.ensure_committed(store, document)?;
        if self.conflicted() {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "This document needs owner recovery. Your draft is kept here.".into(),
            ));
        }
        let rows = command(self);
        self.accept(store, document, &rows, media)?;
        self.reconcile(store, document)?;
        Ok(rows)
    }

    /// Readers can use a durable accepted source while a file projection is
    /// blocked. An imported candidate must commit before it becomes readable.
    pub(super) fn reconcile(&mut self, store: &Store, document: &Document) -> Result<bool> {
        match store.project_scheduled(document, self) {
            Ok(projected) => Ok(projected),
            Err(error) => {
                self.waiting();
                tracing::warn!("document projection pending: {error}");
                self.ensure_committed(store, document)?;
                Ok(false)
            }
        }
    }

    pub(super) fn flush_to_disk(&mut self, store: &Store, document: &Document) -> Result<bool> {
        store.project_now(document, self)
    }

    fn projection_code(&self) -> u8 {
        if self.conflicted() {
            3
        } else if self.engine.state.waiting() {
            1
        } else if self.engine.state.needs_projection() {
            2
        } else {
            0
        }
    }
    pub(super) fn projection_status(&self) -> Vec<u8> {
        Message::Custom(121, vec![b'0' + self.projection_code()]).encode_v1()
    }
    fn publish_projection(&mut self) {
        let status = self.projection_code();
        if self.engine.published_projection == Some(status) {
            return;
        }
        self.engine.published_projection = Some(status);
        let _ = self.tx.send(self.projection_status());
    }
    fn waiting(&mut self) {
        if !self.engine.state.waiting() {
            self.engine.state.block();
            self.publish_projection();
        }
    }
}

pub(super) fn process_frame(
    s: &Store,
    d: &Document,
    room: &Arc<Mutex<Room>>,
    bytes: &[u8],
    edit: bool,
    owner: bool,
    peer: &mut Peer,
) -> Result<Vec<Vec<u8>>> {
    let mut message = security::decode_frame(bytes)?;
    let mutation = matches!(
        &message,
        Message::Sync(SyncMessage::SyncStep2(_) | SyncMessage::Update(_))
    );
    if mutation && !edit {
        return Ok(vec![]);
    }
    if let Message::Awareness(ref update) = message
        && (update.clients.len() > peers::AWARENESS_CLIENT_LIMIT
            || update
                .clients
                .values()
                .any(|u| u.json.len() > 2048 || !valid_presence(&u.json)))
    {
        return Err(bad("Too many or invalid presence updates."));
    }
    let mut r = room.lock().unwrap();
    let presence = if let Message::Awareness(ref mut update) = message {
        peer.presence.accept(update, &r.awareness)?;
        if update.clients.is_empty() {
            return Ok(vec![]);
        }
        Some(message.encode_v1())
    } else {
        None
    };
    // A previous SQLite failure may have left accepted deltas queued in the
    // authoritative room. No bootstrap, receipt or sync response may expose
    // them until its durable outbox has committed successfully.
    r.ensure_committed(s, d)?;
    if mutation && r.conflicted() {
        return Ok(vec![]);
    }
    if let Message::Custom(124, ref payload) = message {
        if r.conflicted() {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "This document needs owner recovery. Your draft is kept here.".into(),
            ));
        }
        if !edit || payload.len() != 36 || uuid::Uuid::try_parse_ascii(payload).is_err() {
            return Err(denied());
        }
        let receipt =
            String::from_utf8(payload.clone()).map_err(|_| bad("Invalid save checkpoint."))?;
        if peer.awaiting_sync {
            // This checkpoint includes operations we could not yet validate.
            // It must not enter the disk receipt queue until a complete reply.
            peer.held_receipt = Some(receipt);
            return Ok(vec![Message::Custom(122, payload.clone()).encode_v1()]);
        }
        if !r.engine.state.needs_projection() {
            return Ok(vec![Message::Custom(127, payload.clone()).encode_v1()]);
        }
        if !r.engine.state.receipts.contains_key(&peer.id) && r.engine.state.receipts.len() >= 128 {
            return Err(bad("Too many pending save checkpoints."));
        }
        r.engine.state.receipts.insert(peer.id, receipt);
        return Ok(vec![Message::Custom(122, payload.clone()).encode_v1()]);
    }
    if mutation
        && peer.awaiting_sync
        && !matches!(&message, Message::Sync(SyncMessage::SyncStep2(_)))
    {
        // A Step1 response covers every local operation preceding it on this
        // ordered connection. Do not accept later incremental fragments or
        // acknowledge their checkpoints while that response is outstanding.
        return Ok(vec![]);
    }
    let mut approved_media = HashSet::new();
    if let Message::Sync(SyncMessage::SyncStep2(ref update) | SyncMessage::Update(ref update)) =
        message
    {
        let checked = {
            let Room {
                engine, awareness, ..
            } = &mut *r;
            engine
                .validation
                .check_as(awareness.doc(), update, documents::has_media(&d.path))?
        };
        let validation::Check::Valid { before, after } = checked else {
            // A reconnect may deliver a delta before its causal predecessors.
            // The speculative replica is discarded; authoritative state stays
            // clean while the peer supplies a complete synchronization reply.
            peer.awaiting_sync = true;
            return Ok(vec![
                Message::Sync(SyncMessage::SyncStep1(
                    r.awareness.doc().transact().state_vector(),
                ))
                .encode_v1(),
            ]);
        };
        let media_check: Result<()> = (|| {
            if !owner {
                approved_media =
                    s.validate_reference_sets(d, &before, &after, &mut peer.media_paths)?;
            }
            if before != after {
                let usage = s.reference_usage(d, &after);
                if usage > DOC_LIMIT && usage > s.reference_usage(d, &before) {
                    return Err(bad("Document exceeds its 50 MB attachment limit."));
                }
            }
            Ok(())
        })();
        if let Err(error) = media_check {
            r.engine.validation.reject();
            return Err(error);
        }
    }
    let mut receipt_response = None;
    let response = match DefaultProtocol.handle_message(&mut r.awareness, message) {
        Ok(response) => response,
        Err(_) => {
            r.engine.validation.reject();
            return Err(bad("Invalid sync update."));
        }
    };
    if mutation {
        r.accept(s, d, &[], approved_media)?;
        if peer.awaiting_sync {
            peer.awaiting_sync = false;
            if let Some(receipt) = peer.held_receipt.take() {
                if r.engine.state.needs_projection() {
                    r.engine.state.receipts.insert(peer.id, receipt);
                } else {
                    receipt_response = Some(Message::Custom(127, receipt.into_bytes()).encode_v1());
                }
            }
        }
        // Projection is coalesced by the coordinator. Broadcast immediately
        // after SQLite durability; save receipts wait for its next fsynced pass.
    }
    if let Some(presence) = presence {
        let _ = r.tx.send(presence);
    }
    let mut responses = response
        .and_then(|response| peer.presence.outgoing(response.encode_v1()))
        .map(|frame| vec![frame])
        .unwrap_or_default();
    responses.extend(receipt_response);
    Ok(responses)
}

#[cfg(test)]
impl Store {
    pub(super) fn persist(&self, d: &Document, r: &mut Room) -> Result<bool> {
        r.flush_to_disk(self, d)
    }
    pub(super) fn store_room(&self, d: &Document, r: &mut Room) -> Result<()> {
        r.ensure_committed(self, d)
    }
    pub(super) fn commit_room(&self, d: &Document, r: &mut Room, rows: &[Value]) -> Result<()> {
        self.commit_command(d, r, rows)
    }
}

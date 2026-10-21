//! Boundaries shared by HTTP authorization and collaborative document updates.
//! The wire format can represent much more than Locdoc's plain source text.
use super::{ApiError, App, Result, bad, denied};
use axum::{
    extract::FromRequestParts,
    http::{HeaderMap, header, request::Parts},
};
use yrs::{Any, Doc, GetString, Map, OffsetKind, Out, ReadTxn, Text, Transact};

/// Owner-only handlers must opt into this extractor rather than copying checks.
pub(super) struct Owner;
impl FromRequestParts<App> for Owner {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &App) -> Result<Self> {
        if state.owner(&parts.headers) {
            Ok(Self)
        } else {
            Err(denied())
        }
    }
}

fn origin(value: &str) -> Option<url::Url> {
    let parsed = url::Url::parse(value).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    Some(parsed)
}

/// Browsers may use the configured public origin or the actual local HTTP
/// listener. Host/forwarded headers never authorize another public origin.
/// Requests without Origin remain usable by local scripts and API clients.
pub(super) fn origin_allowed(public_url: &str, bind: &str, headers: &HeaderMap) -> bool {
    let Some(value) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(value) = value.to_str() else {
        return false;
    };
    let Some(request_origin) = origin(value) else {
        return false;
    };
    if origin(public_url).is_some_and(|public| public.origin() == request_origin.origin()) {
        return true;
    }
    let Some(listener) = origin(&format!("http://{bind}")) else {
        return false;
    };
    let loopback = match request_origin.host() {
        Some(url::Host::Domain(name)) => name == "localhost",
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    let local_host_matches = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .and_then(|host| origin(&format!("http://{host}")))
        .is_some_and(|host| host.origin() == request_origin.origin());
    loopback
        && local_host_matches
        && request_origin.scheme() == "http"
        && request_origin.port_or_known_default() == listener.port_or_known_default()
}

/// An allocation-free pass over the narrow Yjs V1 schema Locdoc accepts.
/// Counts in hostile wire data must not become allocation sizes before the
/// decoder discovers that their entries were never supplied.
struct Wire<'a>(&'a [u8]);
pub(super) enum TextMark {
    Split(u64, u32),
    Surrogate(u64, u32),
}
impl<'a> Wire<'a> {
    fn byte(&mut self) -> Result<u8> {
        let (byte, rest) = self.0.split_first().ok_or_else(invalid_frame)?;
        self.0 = rest;
        Ok(*byte)
    }
    fn var(&mut self) -> Result<u64> {
        let mut value = 0u64;
        for shift in (0..70).step_by(7) {
            let byte = self.byte()?;
            if shift == 63 && byte > 1 {
                return Err(invalid_frame());
            }
            value |= u64::from(byte & 127) << shift;
            if byte & 128 == 0 {
                return Ok(value);
            }
        }
        Err(invalid_frame())
    }
    fn number(&mut self) -> Result<u32> {
        u32::try_from(self.var()?).map_err(|_| invalid_frame())
    }
    fn count(&mut self, minimum_entry_bytes: usize) -> Result<usize> {
        let value = usize::try_from(self.var()?).map_err(|_| invalid_frame())?;
        if value > self.0.len() / minimum_entry_bytes {
            return Err(invalid_frame());
        }
        Ok(value)
    }
    fn buffer(&mut self) -> Result<&'a [u8]> {
        let len = usize::try_from(self.var()?).map_err(|_| invalid_frame())?;
        let (value, rest) = self.0.split_at_checked(len).ok_or_else(invalid_frame)?;
        self.0 = rest;
        Ok(value)
    }
    fn string(&mut self) -> Result<&'a str> {
        std::str::from_utf8(self.buffer()?).map_err(|_| invalid_frame())
    }
    fn id(&mut self) -> Result<()> {
        self.client()?;
        self.number()?;
        Ok(())
    }
    fn client(&mut self) -> Result<u64> {
        let client = self.var()?;
        if client >= 1u64 << 53 {
            return Err(invalid_frame());
        }
        Ok(client)
    }
    fn end(self) -> Result<()> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err(invalid_frame())
        }
    }
    fn text_update(mut self, mut mark: impl FnMut(TextMark)) -> Result<()> {
        let clients = self.count(3)?;
        for _ in 0..clients {
            let blocks = self.count(1)?;
            if blocks == 0 {
                return Err(invalid_frame());
            }
            let client = self.client()?;
            let mut clock = self.number()?;
            for _ in 0..blocks {
                mark(TextMark::Split(client, clock));
                let info = self.byte()?;
                let len = match info {
                    0 | 10 => self.number()?, // collected or skipped source history
                    _ => {
                        if info & 32 != 0 {
                            return Err(invalid_frame());
                        }
                        if info & 128 != 0 {
                            let client = self.client()?;
                            let clock = self.number()?.checked_add(1).ok_or_else(invalid_frame)?;
                            mark(TextMark::Split(client, clock));
                        }
                        if info & 64 != 0 {
                            let client = self.client()?;
                            let clock = self.number()?;
                            mark(TextMark::Split(client, clock));
                        }
                        if info & 192 == 0 && (self.var()? != 1 || self.string()? != "content") {
                            return Err(invalid_frame());
                        }
                        match info & 31 {
                            1 => self.number()?, // deleted source characters
                            4 => {
                                let mut len = 0u32;
                                for c in self.string()?.chars() {
                                    if c.len_utf16() == 2 {
                                        mark(TextMark::Surrogate(
                                            client,
                                            clock
                                                .checked_add(len)
                                                .and_then(|n| n.checked_add(1))
                                                .ok_or_else(invalid_frame)?,
                                        ));
                                    }
                                    len = len
                                        .checked_add(c.len_utf16() as u32)
                                        .ok_or_else(invalid_frame)?;
                                }
                                len
                            }
                            _ => return Err(invalid_frame()),
                        }
                    }
                };
                // Every struct owns at least one clock. Yrs accepts a zero
                // length GC block on decode/apply, then underflows len - 1
                // while encoding it later. The same invariant covers every
                // supported struct rather than singling out one wire tag.
                if len == 0 {
                    return Err(invalid_frame());
                }
                clock = clock.checked_add(len).ok_or_else(invalid_frame)?;
                mark(TextMark::Split(client, clock));
            }
        }
        let clients = self.count(2)?;
        for _ in 0..clients {
            let client = self.client()?;
            let ranges = self.count(2)?;
            if ranges == 0 {
                return Err(invalid_frame());
            }
            for _ in 0..ranges {
                let clock = self.number()?;
                let len = self.number()?;
                if len == 0 {
                    return Err(invalid_frame());
                }
                let end = clock.checked_add(len).ok_or_else(invalid_frame)?;
                mark(TextMark::Split(client, clock));
                mark(TextMark::Split(client, end));
            }
        }
        self.end()
    }
}
fn invalid_frame() -> ApiError {
    bad("Invalid or unsupported synchronization frame.")
}

pub(super) fn validate_text_update(bytes: &[u8]) -> Result<()> {
    Wire(bytes).text_update(|_| {})
}

/// SQLite and recovery state are not assumed trustworthy. Run the same bounded
/// plain-text/client-ID preflight as network frames before Yrs constructs IDs
/// or allocates from encoded counts.
pub(super) fn decode_update(bytes: &[u8]) -> Result<yrs::Update> {
    use yrs::updates::decoder::Decode;
    validate_text_update(bytes)?;
    yrs::Update::decode_v1(bytes).map_err(|_| bad("Invalid document synchronization state."))
}

pub(super) fn text_marks(bytes: &[u8], mark: impl FnMut(TextMark)) -> Result<()> {
    Wire(bytes).text_update(mark)
}

pub(super) fn decode_frame(bytes: &[u8]) -> Result<yrs::sync::Message> {
    use yrs::updates::decoder::Decode;
    let mut wire = Wire(bytes);
    match wire.number()? {
        0 => {
            let kind = wire.number()?;
            let mut payload = Wire(wire.buffer()?);
            match kind {
                0 => {
                    let clients = payload.count(2)?;
                    for _ in 0..clients {
                        payload.id()?;
                    }
                    payload.end()?;
                }
                1 | 2 => payload.text_update(|_| {})?,
                _ => return Err(invalid_frame()),
            }
        }
        1 => {
            let mut payload = Wire(wire.buffer()?);
            let clients = payload.count(3)?;
            if clients > super::peers::AWARENESS_CLIENT_LIMIT {
                return Err(invalid_frame());
            }
            for _ in 0..clients {
                payload.id()?;
                if payload.string()?.len() > 2048 {
                    return Err(invalid_frame());
                }
            }
            payload.end()?;
        }
        2 => {
            if wire.number()? == 0 {
                wire.string()?;
            }
        }
        3 => {}
        tag if tag <= u8::MAX as u32 => {
            wire.buffer()?;
        }
        _ => return Err(invalid_frame()),
    }
    wire.end()?;
    yrs::sync::Message::decode_v1(bytes).map_err(|_| invalid_frame())
}

/// Returns source only when the entire live shared state has the schema the
/// editor understands. Reject unresolved dependencies: inspecting only visible
/// text would otherwise authorize data that materializes on a later update.
pub(super) fn validate_document(doc: &Doc) -> Result<String> {
    let text = doc.get_or_insert_text("content");
    let txn = doc.transact();
    if txn.store().pending_update().is_some()
        || txn.store().pending_ds().is_some()
        || txn.subdocs().next().is_some()
        || txn
            .root_refs()
            .any(|(name, value)| name != "content" || !matches!(value, Out::YText(_)))
        || txn.get_map("content").is_some_and(|map| map.len(&txn) != 0)
    {
        return Err(bad("Only plain document text is supported."));
    }
    let mut source = String::new();
    for chunk in text.diff(&txn, |_| ()) {
        if chunk.attributes.is_some_and(|attrs| !attrs.is_empty()) {
            return Err(bad("Rich-text attributes are not supported."));
        }
        match chunk.insert {
            Out::Any(Any::String(value)) => source.push_str(&value),
            _ => return Err(bad("Embedded collaboration objects are not supported.")),
        }
    }
    let source_len = match doc.offset_kind() {
        OffsetKind::Bytes => source.len(),
        OffsetKind::Utf16 => source.encode_utf16().count(),
    };
    // A JSON/string embed also appears as Any::String in a delta, but it is
    // absent from get_string and occupies one CRDT position (even if empty).
    if source != text.get_string(&txn) || source_len != text.len(&txn) as usize {
        return Err(bad("Embedded collaboration objects are not supported."));
    }
    Ok(source)
}

// Storage retained for undo/history is charged independently of current
// embedding limits. Removing a reference must not make another upload free.
const RETAINED_DOCUMENT_BYTES: i64 = 200 * super::MB as i64;
const RETAINED_WORKSPACE_BYTES: i64 = 10_000 * super::MB as i64;
const FREE_SPACE_FLOOR: u128 = 128 * super::MB as u128;

impl super::Store {
    fn reconcile_missing_uploads(&self, tx: &rusqlite::Transaction<'_>) -> Result<()> {
        let expired = tx
            .prepare("SELECT path FROM assets WHERE pending_until<=?")?
            .query_map([super::now()], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for relative in expired {
            if !std::path::Path::new(&relative).starts_with(".assets") {
                continue;
            }
            let path = match self.safe(&relative, true) {
                Ok(path) => path,
                // Preserve reservations when a symlink, unavailable root or
                // unreadable folder prevents proving that a file is gone.
                Err(_) => continue,
            };
            if std::fs::symlink_metadata(path)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            {
                tx.execute(
                    "DELETE FROM assets WHERE path=? AND pending_until<=?",
                    super::params![relative, super::now()],
                )?;
            }
        }
        Ok(())
    }
    pub(super) fn validate_reference_sets(
        &self,
        doc: &super::Document,
        previous: &std::collections::HashSet<String>,
        current: &std::collections::HashSet<String>,
        media_paths: &mut std::collections::HashSet<std::path::PathBuf>,
    ) -> Result<std::collections::HashSet<String>> {
        let mut approved = std::collections::HashSet::new();
        for reference in previous {
            if let Ok(path) = self.media_path(doc, reference)
                && self.active_attachment_allowed(doc, &path)
            {
                media_paths.insert(path);
            }
        }
        for reference in current.difference(previous) {
            let path = self.media_path(doc, reference).map_err(|_| denied())?;
            if media_paths.contains(&path) {
                approved.insert(reference.clone());
                continue;
            }
            let relative = path
                .strip_prefix(&self.root)
                .map_err(|_| denied())?
                .to_string_lossy();
            let pending = self
                .db
                .lock()
                .unwrap()
                .query_row(
                    "SELECT 1 FROM assets WHERE doc=? AND path=? AND pending_until>?",
                    super::params![doc.id, relative, super::now()],
                    |_| Ok(()),
                )
                .is_ok();
            if !pending {
                return Err(denied());
            }
            media_paths.insert(path);
            approved.insert(reference.clone());
        }
        Ok(approved)
    }

    pub(super) fn active_attachment_allowed(
        &self,
        doc: &super::Document,
        path: &std::path::Path,
    ) -> bool {
        if !self.attachment_allowed(doc, path) {
            return false;
        }
        let references = self
            .db
            .lock()
            .unwrap()
            .prepare("SELECT reference FROM active_media WHERE doc=?")
            .and_then(|mut query| {
                query
                    .query_map([&doc.id], |row| row.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()
            })
            .unwrap_or_default();
        references.iter().any(|reference| {
            self.media_path(doc, reference)
                .is_ok_and(|candidate| candidate == path)
        })
    }

    pub(super) fn seed_active_media(&self, doc: &super::Document) -> Result<()> {
        let initialized: bool = self.db.lock().unwrap().query_row(
            "SELECT media_initialized FROM docs WHERE id=?",
            [&doc.id],
            |row| row.get(0),
        )?;
        if initialized {
            return Ok(());
        }
        let Some(mut file) = super::DiskFile::open_read(&self.safe(&doc.path, false)?)? else {
            return Ok(());
        };
        // References in a file not matched to this document are not its
        // approvals, for example another document's after a swap.
        if self.unmatched_file(&doc.id, &file.metadata()?)? {
            return Ok(());
        }
        let Ok(source) = file.read() else {
            return Ok(());
        };
        let approved = Self::references(&source)
            .into_iter()
            .filter(|reference| {
                self.media_path(doc, reference)
                    .is_ok_and(|path| self.attachment_allowed(doc, &path))
            })
            .collect::<Vec<_>>();
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        for reference in approved {
            tx.execute(
                "INSERT OR IGNORE INTO active_media(doc,reference) VALUES(?,?)",
                super::params![doc.id, reference],
            )?;
        }
        tx.execute("UPDATE docs SET media_initialized=1 WHERE id=?", [&doc.id])?;
        tx.commit()?;
        Ok(())
    }

    /// Called inside the source transaction. Retained owner/history grants may
    /// remain forever, but current sharing authorization shrinks with source.
    pub(super) fn commit_active_media(
        &self,
        tx: &rusqlite::Transaction<'_>,
        doc: &super::Document,
        content: &str,
        approved: &std::collections::HashSet<String>,
    ) -> Result<()> {
        self.commit_media_references(tx, doc, &Self::references(content), approved)
    }

    pub(super) fn commit_media_references(
        &self,
        tx: &rusqlite::Transaction<'_>,
        doc: &super::Document,
        current: &std::collections::HashSet<String>,
        approved: &std::collections::HashSet<String>,
    ) -> Result<()> {
        // If migration could not lease the desktop file, the first accepted
        // source commit seals its conservative empty authorization. A later
        // browser projection must never be reinterpreted as a migration grant.
        tx.execute(
            "UPDATE docs SET media_initialized=1 WHERE id=? AND media_initialized=0",
            [&doc.id],
        )?;
        let previous = tx
            .prepare("SELECT reference FROM active_media WHERE doc=?")?
            .query_map([&doc.id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for reference in previous {
            if !current.contains(&reference) {
                tx.execute(
                    "DELETE FROM active_media WHERE doc=? AND reference=?",
                    super::params![doc.id, reference],
                )?;
            }
        }
        let uploaded = tx
            .prepare("SELECT path FROM assets WHERE doc=? AND pending_until>?")?
            .query_map(super::params![doc.id, super::now()], |row| {
                row.get::<_, String>(0)
            })?
            .filter_map(|row| {
                row.ok()
                    .and_then(|path| std::fs::canonicalize(self.root.join(path)).ok())
            })
            .collect::<std::collections::HashSet<_>>();
        for reference in current {
            if approved.contains(reference)
                || self
                    .media_path(doc, reference)
                    .is_ok_and(|path| uploaded.contains(&path))
            {
                tx.execute(
                    "INSERT OR IGNORE INTO active_media(doc,reference) VALUES(?,?)",
                    super::params![doc.id, reference],
                )?;
            }
        }
        Ok(())
    }

    pub(super) fn write_upload(
        &self,
        doc: &super::Document,
        relative: &str,
        bytes: &[u8],
    ) -> Result<()> {
        use std::{ffi::CString, io::Write, os::unix::ffi::OsStrExt};
        let destination = self.safe(relative, true)?;
        let root = CString::new(self.root.as_os_str().as_bytes())
            .map_err(|_| bad("Invalid documents folder."))?;
        let mut space = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        if unsafe { libc::statvfs(root.as_ptr(), space.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let space = unsafe { space.assume_init() };
        let free = u128::from(space.f_bavail) * u128::from(space.f_frsize);
        if free < FREE_SPACE_FLOOR + bytes.len() as u128 {
            return Err(bad("Not enough free disk space to upload safely."));
        }
        {
            let mut db = self.db.lock().unwrap();
            let tx = db.transaction()?;
            let totals = || {
                tx.query_row(
                "SELECT COALESCE(SUM(CASE WHEN doc=? THEN bytes ELSE 0 END),0),COALESCE(SUM(bytes),0),COALESCE(SUM(CASE WHEN pending_until>? THEN bytes ELSE 0 END),0) FROM assets",
                super::params![doc.id, super::now()], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)))
            };
            let (mut retained, mut total, mut pending) = totals()?;
            let size = i64::try_from(bytes.len()).map_err(|_| bad("Attachment is too large."))?;
            if retained.saturating_add(size) > RETAINED_DOCUMENT_BYTES
                || total.saturating_add(size) > RETAINED_WORKSPACE_BYTES
            {
                // Only inspect retained files when their budget would block
                // an upload. Missing expired records no longer charge owners
                // after manual cleanup; pending writers stay reserved.
                self.reconcile_missing_uploads(&tx)?;
                (retained, total, pending) = totals()?;
            }
            // Pending rows cover concurrent file writers. Conservatively keep
            // this headroom for their ten-minute insertion window, so racing
            // uploads cannot all spend the same last free filesystem bytes.
            if pending < 0 || free < FREE_SPACE_FLOOR + bytes.len() as u128 + pending as u128 {
                return Err(bad("Not enough free disk space to upload safely."));
            }
            if retained < 0 || total < 0 || retained.saturating_add(size) > RETAINED_DOCUMENT_BYTES
            {
                return Err(bad(
                    "This document has reached its 200 MB retained attachment limit.",
                ));
            }
            if total.saturating_add(size) > RETAINED_WORKSPACE_BYTES {
                return Err(bad(
                    "This workspace has reached its 10 GB retained attachment limit.",
                ));
            }
            // Reserve before releasing the transaction: uploads to different
            // documents share the same durable budget, including in-flight data.
            tx.execute(
                "INSERT INTO assets(doc,path,bytes,pending_until) VALUES(?,?,?,?)",
                super::params![doc.id, relative, size, super::now() + 600],
            )?;
            let depth = std::path::Path::new(&doc.path)
                .parent()
                .map_or(0, |path| path.components().count());
            let reference = format!("{}{relative}", "../".repeat(depth));
            tx.execute(
                "INSERT OR IGNORE INTO active_media(doc,reference) VALUES(?,?)",
                super::params![doc.id, reference],
            )?;
            tx.commit()?;
        }
        let mut created = false;
        let result: Result<()> = (|| {
            let parent = destination
                .parent()
                .ok_or_else(|| bad("Invalid attachment path."))?;
            std::fs::create_dir_all(parent)?;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)?;
            created = true;
            file.write_all(bytes)?;
            file.sync_all()?;
            super::disk::sync_directories(parent, &self.root)?;
            Ok(())
        })();
        if result.is_err() {
            if created {
                let _ = std::fs::remove_file(destination);
            }
            let depth = std::path::Path::new(&doc.path)
                .parent()
                .map_or(0, |path| path.components().count());
            self.db.lock().unwrap().execute(
                "DELETE FROM active_media WHERE doc=? AND reference=?",
                super::params![doc.id, format!("{}{relative}", "../".repeat(depth))],
            )?;
            self.db.lock().unwrap().execute(
                "DELETE FROM assets WHERE doc=? AND path=?",
                super::params![doc.id, relative],
            )?;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{ArrayPrelim, StateVector, Update, types::Attrs, updates::decoder::Decode};

    #[test]
    fn missing_causal_updates_resynchronize_without_acknowledging_unaccepted_checkpoints() {
        use super::super::{Peer, process_frame, room_text};
        use yrs::sync::{Message, SyncMessage};
        use yrs::updates::encoder::Encode;
        let (_dir, store, document) = upload_store();
        let room = store.room(&document).unwrap();
        store.persist(&document, &mut room.lock().unwrap()).unwrap();
        let initial = room_text(&room.lock().unwrap());
        let state = room
            .lock()
            .unwrap()
            .awareness
            .doc()
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let client = Doc::with_options(yrs::Options {
            offset_kind: OffsetKind::Utf16,
            ..yrs::Options::default()
        });
        client
            .transact_mut()
            .apply_update(Update::decode_v1(&state).unwrap())
            .unwrap();
        let text = client.get_or_insert_text("content");
        let end = text.len(&client.transact());
        text.insert(&mut client.transact_mut(), end, " first");
        let after_first = client.transact().state_vector();
        let end = text.len(&client.transact());
        text.insert(&mut client.transact_mut(), end, " second");
        let second_only = client.transact().encode_state_as_update_v1(&after_first);
        let mut peer = Peer::default();
        let responses = process_frame(
            &store,
            &document,
            &room,
            &Message::Sync(SyncMessage::Update(second_only)).encode_v1(),
            true,
            true,
            &mut peer,
        )
        .unwrap();
        let Message::Sync(SyncMessage::SyncStep1(vector)) =
            Message::decode_v1(&responses[0]).unwrap()
        else {
            panic!("Expected a causal resynchronization request");
        };
        assert!(peer.awaiting_sync);
        assert_eq!(room_text(&room.lock().unwrap()), initial);
        let receipt = uuid::Uuid::new_v4().to_string();
        let replies = process_frame(
            &store,
            &document,
            &room,
            &Message::Custom(124, receipt.as_bytes().to_vec()).encode_v1(),
            true,
            true,
            &mut peer,
        )
        .unwrap();
        assert!(matches!(
            Message::decode_v1(&replies[0]).unwrap(),
            Message::Custom(122, _)
        ));
        assert!(room.lock().unwrap().engine.receipts.is_empty());
        store.persist(&document, &mut room.lock().unwrap()).unwrap();
        assert_eq!(peer.held_receipt.as_deref(), Some(receipt.as_str()));
        // Even a causally complete independent incremental update cannot release
        // a checkpoint covering the discarded second operation.
        let independent = Doc::new();
        independent
            .transact_mut()
            .apply_update(Update::decode_v1(&state).unwrap())
            .unwrap();
        let before = independent.transact().state_vector();
        independent.get_or_insert_text("content").insert(
            &mut independent.transact_mut(),
            0,
            "independent ",
        );
        let update = independent.transact().encode_state_as_update_v1(&before);
        client
            .transact_mut()
            .apply_update(Update::decode_v1(&update).unwrap())
            .unwrap();
        let replies = process_frame(
            &store,
            &document,
            &room,
            &Message::Sync(SyncMessage::Update(update)).encode_v1(),
            true,
            true,
            &mut peer,
        )
        .unwrap();
        assert!(replies.is_empty());
        assert_eq!(room_text(&room.lock().unwrap()), initial);
        let full_reply = client.transact().encode_state_as_update_v1(&vector);
        process_frame(
            &store,
            &document,
            &room,
            &Message::Sync(SyncMessage::SyncStep2(full_reply)).encode_v1(),
            true,
            true,
            &mut peer,
        )
        .unwrap();
        assert!(!peer.awaiting_sync);
        assert!(peer.held_receipt.is_none());
        assert_eq!(
            room.lock().unwrap().engine.receipts.get(&peer.id),
            Some(&receipt)
        );
        let accepted = room_text(&room.lock().unwrap());
        assert!(accepted.contains(" first second"));
        assert!(accepted.contains("independent "));
        assert!(store.persist(&document, &mut room.lock().unwrap()).unwrap());
        assert!(room.lock().unwrap().engine.receipts.is_empty());
        assert_eq!(
            std::fs::read_to_string(store.root.join(&document.path)).unwrap(),
            accepted
        );
    }
    #[test]
    fn delete_only_updates_with_missing_predecessors_request_a_causal_reply() {
        use super::super::{Peer, process_frame, room_text};
        use yrs::sync::{Message, SyncMessage};
        use yrs::updates::encoder::Encode;
        let (_dir, store, document) = upload_store();
        let room = store.room(&document).unwrap();
        store.persist(&document, &mut room.lock().unwrap()).unwrap();
        let initial = room_text(&room.lock().unwrap());
        let client = Doc::new();
        let state = room
            .lock()
            .unwrap()
            .awareness
            .doc()
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        client
            .transact_mut()
            .apply_update(Update::decode_v1(&state).unwrap())
            .unwrap();
        let text = client.get_or_insert_text("content");
        let end = text.len(&client.transact());
        text.insert(&mut client.transact_mut(), end, "temporary");
        let inserted = client.transact().state_vector();
        text.remove_range(&mut client.transact_mut(), end, 9);
        let deletion = client.transact().encode_state_as_update_v1(&inserted);
        let mut peer = Peer::default();
        let replies = process_frame(
            &store,
            &document,
            &room,
            &Message::Sync(SyncMessage::Update(deletion)).encode_v1(),
            true,
            true,
            &mut peer,
        )
        .unwrap();
        let Message::Sync(SyncMessage::SyncStep1(vector)) =
            Message::decode_v1(&replies[0]).unwrap()
        else {
            panic!("Expected dependencies for pending deletion");
        };
        assert!(peer.awaiting_sync);
        assert_eq!(room_text(&room.lock().unwrap()), initial);
        {
            let room = room.lock().unwrap();
            let txn = room.awareness.doc().transact();
            assert!(txn.store().pending_update().is_none());
            assert!(txn.store().pending_ds().is_none());
        }
        let update = client.transact().encode_state_as_update_v1(&vector);
        process_frame(
            &store,
            &document,
            &room,
            &Message::Sync(SyncMessage::SyncStep2(update)).encode_v1(),
            true,
            true,
            &mut peer,
        )
        .unwrap();
        assert!(!peer.awaiting_sync);
        assert_eq!(room_text(&room.lock().unwrap()), initial);
    }
    #[test]
    fn wire_preflight_rejects_allocation_counts_before_decoding_and_accepts_source_history() {
        for frame in [
            vec![1, 5, 255, 255, 255, 255, 15], // huge awareness client count
            vec![0, 0, 5, 255, 255, 255, 255, 15], // huge state vector
            vec![0, 2, 5, 255, 255, 255, 255, 15], // huge update client count
            vec![0, 2, 6, 1, 255, 255, 255, 255, 15], // huge per-client block count
        ] {
            assert!(decode_frame(&frame).is_err());
        }
        let doc = Doc::new();
        let text = doc.get_or_insert_text("content");
        text.insert(&mut doc.transact_mut(), 0, "abcdef");
        text.remove_range(&mut doc.transact_mut(), 1, 2);
        text.insert(&mut doc.transact_mut(), 1, "🌍");
        let update = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let frame = yrs::sync::Message::Sync(yrs::sync::SyncMessage::Update(update));
        assert!(decode_frame(&yrs::updates::encoder::Encode::encode_v1(&frame)).is_ok());
    }
    #[test]
    fn historical_trust_cannot_reactivate_a_removed_attachment_through_owner_source_changes() {
        let (_dir, store, doc) = upload_store();
        std::fs::write(store.root.join("image.png"), b"image").unwrap();
        let image = "![image](image.png)";
        store.grant_new_references(&doc, "", image).unwrap();
        let path = store.media_path(&doc, "image.png").unwrap();
        assert!(store.active_attachment_allowed(&doc, &path));
        {
            let mut db = store.db.lock().unwrap();
            let tx = db.transaction().unwrap();
            store
                .commit_active_media(&tx, &doc, "removed", &std::collections::HashSet::new())
                .unwrap();
            tx.commit().unwrap();
        }
        assert!(
            store.attachment_allowed(&doc, &path),
            "Owner history keeps access to the retained file"
        );
        assert!(!store.active_attachment_allowed(&doc, &path));
        {
            let mut db = store.db.lock().unwrap();
            let tx = db.transaction().unwrap();
            store
                .commit_active_media(&tx, &doc, image, &std::collections::HashSet::new())
                .unwrap();
            tx.commit().unwrap();
        }
        assert!(
            !store.active_attachment_allowed(&doc, &path),
            "Owner closing markup or undoing source does not reactivate historical trust"
        );
    }
    fn upload_store() -> (tempfile::TempDir, App, super::super::Document) {
        let dir = tempfile::tempdir().unwrap();
        let store = super::super::Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost".into(),
        )
        .unwrap();
        let doc = store.create_document("upload.md").unwrap();
        (dir, store, doc)
    }
    #[test]
    fn historical_media_is_not_a_new_guest_grant_but_current_session_undo_is_allowed() {
        let (_dir, store, doc) = upload_store();
        std::fs::write(store.root.join("shown.png"), b"image").unwrap();
        let image = "![image](shown.png)";
        store.grant_new_references(&doc, "", image).unwrap();
        let mut connection = std::collections::HashSet::new();
        store
            .validate_reference_sets(
                &doc,
                &super::super::Store::references(image),
                &super::super::Store::references("removed"),
                &mut connection,
            )
            .unwrap();
        store
            .validate_reference_sets(
                &doc,
                &super::super::Store::references("removed"),
                &super::super::Store::references(image),
                &mut connection,
            )
            .unwrap();
        assert!(
            store
                .validate_reference_sets(
                    &doc,
                    &super::super::Store::references("removed"),
                    &super::super::Store::references(image),
                    &mut std::collections::HashSet::new()
                )
                .is_err()
        );
        store
            .write_upload(&doc, ".assets/new.png", b"uploaded")
            .unwrap();
        store
            .validate_reference_sets(
                &doc,
                &super::super::Store::references("removed"),
                &super::super::Store::references("![new](.assets/new.png)"),
                &mut connection,
            )
            .unwrap();
    }
    #[test]
    fn removed_embeddings_do_not_free_retained_storage_and_global_storage_is_bounded() {
        let (_dir, store, doc) = upload_store();
        std::fs::create_dir_all(store.root.join(".assets")).unwrap();
        std::fs::write(store.root.join(".assets/old.png"), b"retained history").unwrap();
        store
            .db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO assets(doc,path,bytes,pending_until) VALUES(?,?,?,0)",
                super::super::params![doc.id, ".assets/old.png", RETAINED_DOCUMENT_BYTES],
            )
            .unwrap();
        assert!(store.write_upload(&doc, ".assets/new.png", b"new").is_err());
        assert!(!store.root.join(".assets/new.png").exists());
        store
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE assets SET doc='another-document',bytes=?",
                [RETAINED_WORKSPACE_BYTES],
            )
            .unwrap();
        assert!(store.write_upload(&doc, ".assets/new.png", b"new").is_err());
    }
    #[test]
    fn owner_deleted_uploads_release_document_and_workspace_retained_capacity() {
        let (_dir, store, doc) = upload_store();
        for (owner, size) in [
            (doc.id.as_str(), RETAINED_DOCUMENT_BYTES),
            ("another-document", RETAINED_WORKSPACE_BYTES),
        ] {
            store
                .db
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO assets(doc,path,bytes,pending_until) VALUES(?,?,?,0)",
                    super::super::params![owner, ".assets/deleted.png", size],
                )
                .unwrap();
            store
                .write_upload(&doc, ".assets/recovered.png", b"saved")
                .unwrap();
            std::fs::remove_file(store.root.join(".assets/recovered.png")).unwrap();
            store
                .db
                .lock()
                .unwrap()
                .execute("UPDATE assets SET pending_until=0", [])
                .unwrap();
        }
        let remaining: i64 = store
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM assets WHERE path='.assets/deleted.png'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0);
    }
    #[test]
    fn missing_inflight_uploads_and_symlinks_do_not_release_retained_capacity() {
        let (_dir, store, doc) = upload_store();
        store
            .db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO assets(doc,path,bytes,pending_until) VALUES(?,?,?,?)",
                super::super::params![
                    doc.id,
                    ".assets/missing.png",
                    RETAINED_DOCUMENT_BYTES,
                    super::super::now() + 600
                ],
            )
            .unwrap();
        assert!(store.write_upload(&doc, ".assets/new.png", b"new").is_err());
        std::fs::create_dir_all(store.root.join(".assets")).unwrap();
        std::os::unix::fs::symlink("absent.png", store.root.join(".assets/missing.png")).unwrap();
        store
            .db
            .lock()
            .unwrap()
            .execute("UPDATE assets SET pending_until=0", [])
            .unwrap();
        assert!(store.write_upload(&doc, ".assets/new.png", b"new").is_err());
        assert!(!store.root.join(".assets/new.png").exists());
    }
    #[test]
    fn reclaimed_upload_record_does_not_authorize_a_later_file_at_the_same_path() {
        let (_dir, store, doc) = upload_store();
        store
            .write_upload(&doc, ".assets/deleted.png", b"old")
            .unwrap();
        let path = store.media_path(&doc, ".assets/deleted.png").unwrap();
        assert!(store.active_attachment_allowed(&doc, &path));
        std::fs::remove_file(&path).unwrap();
        store
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE assets SET bytes=?,pending_until=0",
                [RETAINED_DOCUMENT_BYTES],
            )
            .unwrap();
        store.write_upload(&doc, ".assets/new.png", b"new").unwrap();
        std::fs::write(&path, b"a different local file").unwrap();
        assert!(!store.active_attachment_allowed(&doc, &path));
    }
    #[test]
    fn failed_upload_releases_its_reservation_without_deleting_an_existing_file() {
        let (_dir, store, doc) = upload_store();
        let relative = ".assets/existing.png";
        std::fs::create_dir(store.root.join(".assets")).unwrap();
        std::fs::write(store.root.join(relative), b"keep this file").unwrap();
        assert!(store.write_upload(&doc, relative, b"replacement").is_err());
        assert_eq!(
            std::fs::read(store.root.join(relative)).unwrap(),
            b"keep this file"
        );
        let count: i64 = store
            .db
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM assets", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        store
            .write_upload(&doc, ".assets/saved.png", b"saved")
            .unwrap();
        assert_eq!(
            std::fs::read(store.root.join(".assets/saved.png")).unwrap(),
            b"saved"
        );
    }
    #[test]
    fn concurrent_uploads_cannot_spend_the_same_retained_allowance() {
        let (_dir, store, doc) = upload_store();
        std::fs::create_dir_all(store.root.join(".assets")).unwrap();
        std::fs::write(store.root.join(".assets/old.png"), b"retained history").unwrap();
        store
            .db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO assets(doc,path,bytes,pending_until) VALUES(?,?,?,0)",
                super::super::params![doc.id, ".assets/old.png", RETAINED_DOCUMENT_BYTES - 1],
            )
            .unwrap();
        let attempts = (0..2)
            .map(|index| {
                let store = store.clone();
                let doc = doc.clone();
                std::thread::spawn(move || {
                    store
                        .write_upload(&doc, &format!(".assets/race-{index}.png"), b"x")
                        .is_ok()
                })
            })
            .collect::<Vec<_>>();
        let accepted = attempts
            .into_iter()
            .map(|attempt| attempt.join().unwrap())
            .filter(|accepted| *accepted)
            .count();
        assert_eq!(accepted, 1);
        let retained: i64 = store
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT SUM(bytes) FROM assets WHERE doc=?",
                [&doc.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, RETAINED_DOCUMENT_BYTES);
    }
    fn headers(value: &str, host: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, value.parse().unwrap());
        headers.insert(header::HOST, host.parse().unwrap());
        headers
    }
    #[test]
    fn origins_compare_the_scheme_host_and_port_without_trusting_forwarded_headers() {
        let public = "https://notes.example.test";
        let bind = "127.0.0.1:3477";
        assert!(origin_allowed(public, bind, &HeaderMap::new()));
        assert!(origin_allowed(
            public,
            bind,
            &headers(public, "notes.example.test")
        ));
        for value in [
            "http://notes.example.test",
            "https://notes.example.test:444",
            "null",
            "https://user@notes.example.test",
            "https://notes.example.test/path",
            "https://notes.example.test?bad=1",
        ] {
            assert!(
                !origin_allowed(public, bind, &headers(value, "notes.example.test")),
                "rejected origin {value}"
            );
        }
        for host in ["localhost:3477", "127.0.0.1:3477", "[::1]:3477"] {
            assert!(origin_allowed(
                public,
                bind,
                &headers(&format!("http://{host}"), host)
            ));
        }
        assert!(!origin_allowed(
            public,
            bind,
            &headers("https://localhost:3477", "localhost:3477")
        ));
        assert!(!origin_allowed(
            public,
            bind,
            &headers("http://localhost:9999", "localhost:9999")
        ));
        assert!(!origin_allowed(
            public,
            bind,
            &headers("http://localhost:3477", "notes.example.test")
        ));
        assert!(!origin_allowed(
            public,
            bind,
            &headers("http://attacker.example:3477", "attacker.example:3477")
        ));
        let mut invalid = HeaderMap::new();
        invalid.insert(
            header::ORIGIN,
            axum::http::HeaderValue::from_bytes(&[0xff]).unwrap(),
        );
        assert!(!origin_allowed(public, bind, &invalid));
    }
    #[test]
    fn document_schema_accepts_only_the_single_plain_source_root() {
        let doc = Doc::new();
        let text = doc.get_or_insert_text("content");
        text.insert(&mut doc.transact_mut(), 0, "Hello 🌍\n**source**");
        assert_eq!(validate_document(&doc).unwrap(), "Hello 🌍\n**source**");
        doc.get_or_insert_text("hidden")
            .insert(&mut doc.transact_mut(), 0, "invisible");
        assert!(validate_document(&doc).is_err());
    }
    #[test]
    fn document_schema_rejects_embeds_attributes_and_map_content() {
        let doc = Doc::new();
        let text = doc.get_or_insert_text("content");
        text.insert_embed(&mut doc.transact_mut(), 0, ArrayPrelim::default());
        assert!(validate_document(&doc).is_err());
        for value in ["a", "", "several characters"] {
            let doc = Doc::new();
            let text = doc.get_or_insert_text("content");
            text.insert_embed(&mut doc.transact_mut(), 0, value);
            assert!(validate_document(&doc).is_err());
        }
        let doc = Doc::new();
        let text = doc.get_or_insert_text("content");
        text.insert_with_attributes(
            &mut doc.transact_mut(),
            0,
            "text",
            Attrs::from([("bold".into(), true.into())]),
        );
        assert!(validate_document(&doc).is_err());
        let doc = Doc::new();
        doc.get_or_insert_text("content");
        doc.get_or_insert_map("content")
            .insert(&mut doc.transact_mut(), "hidden", "value");
        assert!(validate_document(&doc).is_err());
    }
    #[test]
    fn document_schema_rejects_unresolved_updates_before_they_can_materialize() {
        let peer = Doc::new();
        let text = peer.get_or_insert_text("content");
        text.insert(&mut peer.transact_mut(), 0, "first");
        let vector = peer.transact().state_vector();
        text.insert_embed(&mut peer.transact_mut(), 5, true);
        let update = peer.transact().encode_state_as_update_v1(&vector);
        let doc = Doc::new();
        doc.transact_mut()
            .apply_update(Update::decode_v1(&update).unwrap())
            .unwrap();
        assert!(validate_document(&doc).is_err());
    }
    #[test]
    fn malformed_utf8_is_a_decode_error_for_document_and_viewer_presence_frames() {
        let doc = Doc::new();
        let text = doc.get_or_insert_text("content");
        text.insert(&mut doc.transact_mut(), 0, "a");
        let mut update = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        // The one-character inserted string is immediately before the empty delete set.
        let index = update.len() - 2;
        assert_eq!(update[index], b'a');
        update[index] = 0xff;
        assert!(Update::decode_v1(&update).is_err());
        // Awareness: one client, id=1, clock=1, one byte of invalid JSON text.
        let frame = [1, 5, 1, 1, 1, 1, 0xff];
        assert!(yrs::sync::Message::decode_v1(&frame).is_err());
    }
    #[test]
    fn preflight_refuses_empty_structs_and_survives_bounded_wire_mutations() {
        use yrs::{OffsetKind, Options};
        let root = b"content";
        let mut malformed = vec![
            vec![1, 1, 1, 0, 0, 0, 0],  // GC
            vec![1, 1, 1, 0, 10, 0, 0], // Skip
            vec![1, 0, 1, 0, 0],        // empty struct group
            vec![0, 1, 1, 0],           // empty delete group
            vec![0, 1, 1, 1, 0, 0],     // zero delete interval
        ];
        for info in [1, 4] {
            let mut update = vec![1, 1, 1, 0, info, 1, 7];
            update.extend(root);
            update.extend([0, 0]);
            malformed.push(update);
        }
        for update in &malformed {
            assert!(
                decode_update(update).is_err(),
                "Zero-length inner structures must be refused before Yrs"
            );
        }
        assert!(
            decode_update(&[0, 0]).is_ok(),
            "An empty outer synchronization update is valid"
        );
        let peer = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        peer.get_or_insert_text("content")
            .insert(&mut peer.transact_mut(), 0, "Small 😀 source");
        let initial = peer
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let before = peer.transact().state_vector();
        peer.get_or_insert_text("content")
            .insert(&mut peer.transact_mut(), 2, "new");
        let insertion = peer.transact().encode_state_as_update_v1(&before);
        let before = peer.transact().state_vector();
        peer.get_or_insert_text("content")
            .remove_range(&mut peer.transact_mut(), 0, 2);
        let deletion = peer.transact().encode_state_as_update_v1(&before);
        let seeds = [initial.clone(), insertion, deletion];
        let mut cases = malformed;
        for seed in &seeds {
            for index in 0..seed.len() {
                for byte in [0, 1, 4, 10, 31, 32, 64, 127, 128, 255] {
                    let mut mutation = seed.clone();
                    mutation[index] = byte;
                    cases.push(mutation);
                }
            }
            for end in 0..seed.len() {
                cases.push(seed[..end].to_vec());
            }
        }
        for clock in [0, 1, u32::MAX - 1, u32::MAX] {
            // A compact hostile GC range exercises checked clock arithmetic.
            let mut update = vec![1, 1, 1];
            fn var(out: &mut Vec<u8>, mut value: u32) {
                while value >= 128 {
                    out.push(value as u8 | 128);
                    value >>= 7;
                }
                out.push(value as u8);
            }
            var(&mut update, clock);
            update.push(0);
            var(&mut update, 1);
            update.push(0);
            cases.push(update);
        }
        for (index, update) in cases.iter().enumerate() {
            if validate_text_update(update).is_err() {
                continue;
            }
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                for existing in [false, true] {
                    let doc = Doc::with_options(Options {
                        offset_kind: OffsetKind::Utf16,
                        ..Options::default()
                    });
                    if existing {
                        doc.transact_mut()
                            .apply_update(decode_update(&initial).unwrap())
                            .unwrap();
                    }
                    let Ok(decoded) = decode_update(update) else {
                        continue;
                    };
                    if doc.transact_mut().apply_update(decoded).is_err() {
                        continue;
                    }
                    let _ = doc
                        .get_or_insert_text("content")
                        .get_string(&doc.transact());
                    let _ = doc
                        .transact()
                        .encode_state_as_update_v1(&StateVector::default());
                }
            }));
            assert!(
                outcome.is_ok(),
                "Preflight admitted a panicking bounded mutation at case {index}: {update:?}"
            );
        }
    }
}

//! Incremental validation replica for the narrow plain-source protocol.
//!
//! The wire guard proves that an update contains only strings, tombstones and
//! references into the already validated `content` root. We apply it to a
//! reusable speculative replica, never the authoritative room. Rejected or
//! causally incomplete candidates discard this replica; accepted edits need
//! neither a full-state clone nor a full Markdown parse.
use super::{Doc, HashSet, MB, Options, ReadTxn, Result, StateVector, Store, Transact, bad};
use ropey::Rope;
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use yrs::{Any, Observable, OffsetKind, Out, types::Delta};

const HISTORY_LIMIT: usize = 20 * MB;
const SOURCE_LIMIT: usize = 5 * MB;

#[derive(Clone)]
pub(super) struct Updates(Arc<Mutex<Option<Vec<Vec<u8>>>>>);
impl Updates {
    pub(super) fn push(&self, update: &[u8]) {
        let mut state = self.0.lock().unwrap();
        let Some(queue) = state.as_mut() else { return };
        if queue.len() == 256
            || queue
                .iter()
                .map(Vec::len)
                .sum::<usize>()
                .saturating_add(update.len())
                > 2 * MB
        {
            // An inactive validation replica need not retain an unbounded
            // second copy of desktop/comment updates. Rebuild lazily instead.
            *state = None;
        } else {
            queue.push(update.to_vec());
        }
    }
}

pub(super) struct Validated {
    candidate: Option<Candidate>,
    updates: Updates,
}
pub(super) enum Check {
    MissingDependencies,
    Valid {
        before: HashSet<String>,
        after: HashSet<String>,
    },
}
struct Candidate {
    doc: Doc,
    source: Arc<Mutex<Source>>,
    history_budget: usize,
    surrogate_boundaries: BTreeSet<(u64, u32)>,
}
impl Candidate {
    fn new(doc: &Doc) -> Result<Self> {
        let content = super::security::validate_document(doc)?;
        let state = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        // The inductive proof includes retained/deleted history: a hidden old
        // rich parent must not become an insertion target on a later update.
        super::security::validate_text_update(&state)?;
        let mut surrogate_boundaries = BTreeSet::new();
        super::security::text_marks(&state, |mark| {
            if let super::security::TextMark::Surrogate(client, clock) = mark {
                surrogate_boundaries.insert((client, clock));
            }
        })?;
        let replica = Doc::with_options(Options {
            // Yrs CRDT clocks and encoded updates always use UTF-16. This
            // private read-only replica never performs position-based edits;
            // byte offsets make its TextEvent retained/deleted lengths O(1)
            // instead of rescanning every retained string for UTF-16 length.
            offset_kind: OffsetKind::Bytes,
            ..Options::default()
        });
        replica
            .transact_mut()
            .apply_update(
                super::security::decode_update(&state).map_err(|_| bad("Invalid source state."))?,
            )
            .map_err(|_| bad("Invalid source state."))?;
        let source = Arc::new(Mutex::new(Source::new(&content)));
        let observed = source.clone();
        replica
            .get_or_insert_text("content")
            .observe("source-index", move |txn, event| {
                observed.lock().unwrap().apply(event.delta(txn));
            });
        Ok(Self {
            doc: replica,
            source,
            history_budget: state.len(),
            surrogate_boundaries,
        })
    }
    fn apply(&mut self, bytes: &[u8]) -> Result<()> {
        let mut added = BTreeSet::new();
        super::security::text_marks(bytes, |mark| {
            if let super::security::TextMark::Surrogate(client, clock) = mark {
                added.insert((client, clock));
            }
        })?;
        let mut invalid = false;
        super::security::text_marks(bytes, |mark| {
            if let super::security::TextMark::Split(client, clock) = mark {
                invalid |= self.surrogate_boundaries.contains(&(client, clock))
                    || added.contains(&(client, clock));
            }
        })?;
        let vector = self.doc.transact().state_vector();
        for &(client, clock) in &added {
            if clock == vector.get(&yrs::ClientID::new(client)) {
                invalid = true;
            }
        }
        if invalid {
            return Err(bad("Synchronization cannot split a Unicode character."));
        }
        self.doc
            .transact_mut()
            .apply_update(
                super::security::decode_update(bytes).map_err(|_| bad("Invalid update."))?,
            )
            .map_err(|_| bad("Invalid update."))?;
        self.surrogate_boundaries.extend(
            added
                .into_iter()
                .filter(|(client, clock)| *clock > vector.get(&yrs::ClientID::new(*client))),
        );
        // A delete can split an older string into additional encoded items.
        // Charge generously for that overhead, and measure the exact encoded
        // state only when this conservative maintenance budget is exhausted.
        self.history_budget = self
            .history_budget
            .saturating_add(bytes.len().saturating_mul(64).saturating_add(256));
        Ok(())
    }
}
impl Validated {
    pub(super) fn new(doc: &Doc) -> Result<Self> {
        Ok(Self {
            candidate: Some(Candidate::new(doc)?),
            updates: Updates(Arc::new(Mutex::new(Some(Vec::new())))),
        })
    }
    pub(super) fn updates(&self) -> Updates {
        self.updates.clone()
    }
    fn refresh(&mut self, doc: &Doc) -> Result<()> {
        let pending = self.updates.0.lock().unwrap().replace(Vec::new());
        match (&mut self.candidate, pending) {
            (Some(candidate), Some(updates)) => {
                for update in updates {
                    if let Err(error) = candidate.apply(&update) {
                        self.candidate = None;
                        return Err(error);
                    }
                }
            }
            _ => self.candidate = Some(Candidate::new(doc)?),
        }
        Ok(())
    }
    pub(super) fn references(&mut self, doc: &Doc) -> Result<HashSet<String>> {
        self.refresh(doc)?;
        Ok(self
            .candidate
            .as_ref()
            .unwrap()
            .source
            .lock()
            .unwrap()
            .references()
            .clone())
    }
    pub(super) fn check(&mut self, doc: &Doc, update: &[u8]) -> Result<Check> {
        // Keep the inductive plain-root proof inside this API too: a future
        // caller must not accidentally bypass it by decoding Yrs directly.
        super::security::validate_text_update(update)?;
        self.refresh(doc)?;
        let result = self.check_candidate(update);
        if !matches!(&result, Ok(Check::Valid { .. })) {
            self.candidate = None;
        }
        result
    }
    fn check_candidate(&mut self, update: &[u8]) -> Result<Check> {
        let candidate = self.candidate.as_mut().unwrap();
        let before = candidate.source.lock().unwrap().references().clone();
        candidate.apply(update)?;
        {
            let txn = candidate.doc.transact();
            if txn.store().pending_update().is_some() || txn.store().pending_ds().is_some() {
                return Ok(Check::MissingDependencies);
            }
        }
        let mut source = candidate.source.lock().unwrap();
        let text = candidate.doc.get_or_insert_text("content");
        let root: &yrs::branch::Branch = text.as_ref();
        if source.invalid
            || root.len() as usize != source.text.len_utf16_cu()
            || root.content_len() as usize != source.text.len_bytes()
        {
            return Err(bad(
                "Document updates must contain only plain LF text. Reload to keep editing.",
            ));
        }
        if source.text.len_bytes() > SOURCE_LIMIT {
            return Err(bad("Document exceeds 5 MB."));
        }
        if candidate.history_budget > HISTORY_LIMIT {
            candidate.history_budget = candidate
                .doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default())
                .len();
            if candidate.history_budget > HISTORY_LIMIT {
                return Err(bad("Document collaboration history is too large."));
            }
        }
        Ok(Check::Valid {
            before,
            after: source.references().clone(),
        })
    }
    /// A rejected media/quota check happened after the text-only candidate.
    pub(super) fn reject(&mut self) {
        self.candidate = None;
    }
}

/// Three small ropes provide indexed source, Markdown hazard counts and
/// non-whitespace counts. The latter two use one ASCII byte per source scalar;
/// their newline aggregates answer range-count queries in logarithmic time.
/// `breaks` similarly contains one byte per source line, with newlines marking
/// blank lines. This avoids rescanning a one-megabyte line after each insertion.
struct Source {
    text: Rope,
    hazards: Rope,
    ink: Rope,
    breaks: Rope,
    refs: HashSet<String>,
    dirty: bool,
    invalid: bool,
    #[cfg(test)]
    parses: usize,
}
fn hazard(c: char) -> bool {
    matches!(
        c,
        '!' | '[' | ']' | '(' | ')' | '\\' | '<' | '>' | '`' | '~' | '$' | ':' | '\r'
    )
}
fn marks(text: &str, predicate: fn(char) -> bool) -> String {
    text.chars()
        .map(|c| if predicate(c) { '\n' } else { '.' })
        .collect()
}
fn nonwhite(c: char) -> bool {
    // CommonMark blank lines contain ASCII spaces/tabs only. Treating NBSP or
    // Unicode paragraph separators as blank could hide a multiline link.
    !matches!(c, ' ' | '\t' | '\n')
}
fn count(index: &Rope, from: usize, to: usize) -> usize {
    index.byte_to_line(to) - index.byte_to_line(from)
}
impl Source {
    fn new(text: &str) -> Self {
        let mut source = Self {
            text: Rope::from_str(text),
            hazards: Rope::from_str(&marks(text, hazard)),
            ink: Rope::from_str(&marks(text, nonwhite)),
            breaks: Rope::new(),
            refs: Store::references(text),
            dirty: false,
            invalid: text.contains('\r'),
            #[cfg(test)]
            parses: 1,
        };
        source.breaks = Rope::from_str(
            &(0..source.text.len_lines())
                .map(|line| source.blank_mark(line))
                .collect::<String>(),
        );
        source
    }
    fn blank_mark(&self, line: usize) -> char {
        let start = self.text.line_to_char(line);
        let end = if line + 1 == self.text.len_lines() {
            self.text.len_chars()
        } else {
            self.text.line_to_char(line + 1)
        };
        if count(&self.ink, start, end) == 0 {
            '\n'
        } else {
            '.'
        }
    }
    fn plain_paragraph(&self, at: usize) -> bool {
        let line = self.text.char_to_line(at);
        let before = self.breaks.byte_to_line(line);
        let from_line = self.breaks.line_to_byte(before);
        let to_line = if before + 1 < self.breaks.len_lines() {
            self.breaks.line_to_byte(before + 1).saturating_sub(1)
        } else {
            self.text.len_lines()
        };
        let from = self
            .text
            .line_to_char(from_line.min(self.text.len_lines() - 1));
        let to = if to_line >= self.text.len_lines() {
            self.text.len_chars()
        } else {
            self.text.line_to_char(to_line)
        };
        count(&self.hazards, from, to) == 0
    }
    fn plain_prefix(&self, at: usize) -> bool {
        let start = self.text.line_to_char(self.text.char_to_line(at));
        let ordinal = self.ink.byte_to_line(start);
        if ordinal + 1 >= self.ink.len_lines() {
            return false;
        }
        let first = self.ink.line_to_byte(ordinal + 1) - 1;
        if first > at || first >= self.text.len_chars() {
            return false;
        }
        if self.text.char(first).is_alphabetic() {
            return true;
        }
        // A list marker's shape/indentation remains untouched by edits after
        // its first content character. List nesting can therefore stay cached.
        let prefix = self
            .text
            .slice(first..self.text.len_chars().min(first + 16))
            .to_string();
        let body = if ["- ", "+ ", "* "]
            .iter()
            .any(|marker| prefix.starts_with(marker))
        {
            Some(first + 2)
        } else {
            let digits = prefix.chars().take_while(char::is_ascii_digit).count();
            (digits > 0
                && digits <= 9
                && (prefix[digits..].starts_with(". ") || prefix[digits..].starts_with(") ")))
            .then_some(first + digits + 2)
        };
        body.is_some_and(|body| {
            body < self.text.len_chars() && body < at && self.text.char(body).is_alphabetic()
        })
    }
    fn replace(&mut self, from: usize, to: usize, inserted: &str) {
        let start_line = self.text.char_to_line(from);
        let end_line = self.text.char_to_line(to);
        let ordinary = start_line == end_line
            && !inserted.contains(['\n', '\r'])
            && !inserted.chars().any(hazard)
            && count(&self.hazards, from, to) == 0
            && self.plain_prefix(from)
            && self.plain_paragraph(from);
        self.text.remove(from..to);
        self.text.insert(from, inserted);
        self.hazards.remove(from..to);
        self.hazards.insert(from, &marks(inserted, hazard));
        self.ink.remove(from..to);
        self.ink.insert(from, &marks(inserted, nonwhite));
        let new_end = self.text.char_to_line(from + inserted.chars().count());
        let flags = (start_line..=new_end)
            .map(|line| self.blank_mark(line))
            .collect::<String>();
        self.breaks.remove(start_line..end_line + 1);
        self.breaks.insert(start_line, &flags);
        self.dirty |= !ordinary || !self.plain_prefix(from) || !self.plain_paragraph(from);
        self.invalid |= inserted.contains('\r');
    }
    fn apply(&mut self, changes: &[Delta]) {
        let mut cursor = 0;
        for change in changes {
            match change {
                Delta::Retain(len, attrs) => {
                    self.invalid |= attrs.is_some();
                    cursor += *len as usize;
                }
                Delta::Deleted(len) => {
                    if cursor + *len as usize > self.text.len_bytes() {
                        self.invalid = true;
                        return;
                    }
                    let from = self.text.byte_to_char(cursor);
                    let to = self.text.byte_to_char(cursor + *len as usize);
                    if self.text.char_to_byte(from) != cursor
                        || self.text.char_to_byte(to) != cursor + *len as usize
                    {
                        self.invalid = true;
                        return;
                    }
                    self.replace(from, to, "");
                }
                Delta::Inserted(Out::Any(Any::String(text)), attrs) => {
                    self.invalid |= attrs.is_some();
                    if cursor > self.text.len_bytes() {
                        self.invalid = true;
                        return;
                    }
                    let at = self.text.byte_to_char(cursor);
                    if self.text.char_to_byte(at) != cursor {
                        self.invalid = true;
                        return;
                    }
                    self.replace(at, at, text);
                    cursor += text.len();
                }
                _ => {
                    self.invalid = true;
                    return;
                }
            }
        }
    }
    fn references(&mut self) -> &HashSet<String> {
        if self.dirty {
            self.refs = Store::references(&self.text.to_string());
            self.dirty = false;
            #[cfg(test)]
            {
                self.parses += 1;
            }
        }
        &self.refs
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{
        GetString, Text, Update,
        sync::{Message, SyncMessage},
        updates::{decoder::Decode, encoder::Encode},
    };

    fn document(content: &str) -> Doc {
        let doc = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        doc.get_or_insert_text("content")
            .insert(&mut doc.transact_mut(), 0, content);
        doc
    }
    fn copy(doc: &Doc) -> Doc {
        let replica = document("");
        replica
            .transact_mut()
            .apply_update(
                Update::decode_v1(
                    &doc.transact()
                        .encode_state_as_update_v1(&StateVector::default()),
                )
                .unwrap(),
            )
            .unwrap();
        replica
    }
    fn update(doc: &Doc, at: u32, remove: u32, insert: &str) -> Vec<u8> {
        let before = doc.transact().state_vector();
        let text = doc.get_or_insert_text("content");
        let mut txn = doc.transact_mut();
        if remove != 0 {
            text.remove_range(&mut txn, at, remove);
        }
        text.insert(&mut txn, at, insert);
        drop(txn);
        let delta = doc.transact().encode_state_as_update_v1(&before);
        let frame = Message::Sync(SyncMessage::Update(delta.clone())).encode_v1();
        super::super::security::decode_frame(&frame).unwrap();
        delta
    }
    fn check_and_accept(validation: &mut Validated, server: &Doc, delta: &[u8]) {
        assert!(matches!(
            validation.check(server, delta).unwrap(),
            Check::Valid { .. }
        ));
        server
            .transact_mut()
            .apply_update(Update::decode_v1(delta).unwrap())
            .unwrap();
        validation.updates.push(delta);
        let expected = server
            .get_or_insert_text("content")
            .get_string(&server.transact());
        assert_eq!(
            validation.references(server).unwrap(),
            Store::references(&expected)
        );
        assert_eq!(
            validation
                .candidate
                .as_ref()
                .unwrap()
                .source
                .lock()
                .unwrap()
                .text
                .len_bytes(),
            expected.len()
        );
    }
    #[test]
    fn long_formatted_prose_keeps_reference_validation_incremental() {
        // A one-megabyte line and nested formatted lists, with actual image
        // references elsewhere: fast-path validity cannot rely on no images.
        let content = format!(
            "![cover](.assets/cover.png)\n\n{}\n\n- Nested **strong** and *emphasis* words\n    - Deeper words\n",
            "Readable **strong** and *emphasis* prose. ".repeat(25_000)
        );
        let server = document(&content);
        let client = copy(&server);
        let mut validation = Validated::new(&server).unwrap();
        let started = std::time::Instant::now();
        let base = content.find("Readable").unwrap() as u32 + 9;
        for n in 0..120 {
            let delta = update(&client, base + n, 0, "a");
            assert!(matches!(
                validation.check(&server, &delta).unwrap(),
                Check::Valid { .. }
            ));
            server
                .transact_mut()
                .apply_update(Update::decode_v1(&delta).unwrap())
                .unwrap();
            validation.updates.push(&delta);
        }
        validation.references(&server).unwrap();
        let candidate = validation.candidate.as_ref().unwrap();
        let source = candidate.source.lock().unwrap();
        assert_eq!(
            source.parses, 1,
            "Ordinary formatted-prose edits must not parse the full Markdown source"
        );
        assert_eq!(source.text.len_bytes(), content.len() + 120);
        assert!(
            started.elapsed().as_secs() < 8,
            "120 one-megabyte edits exceeded the bounded regression allowance"
        );
        drop(source);
        let text = client
            .get_or_insert_text("content")
            .get_string(&client.transact());
        let list_at = text.rfind("Nested **strong").unwrap() as u32 + 11;
        check_and_accept(&mut validation, &server, &update(&client, list_at, 0, "Z"));
        assert_eq!(
            validation
                .candidate
                .as_ref()
                .unwrap()
                .source
                .lock()
                .unwrap()
                .parses,
            1
        );
    }
    #[test]
    fn source_index_matches_exact_parser_through_structural_edits() {
        let examples = [
            "Plain words\n\n![x](.assets/a.png)\n",
            "- Plain words\n\n    ![x](.assets/a.png)\n",
            "![x](\n.assets/a.png\n)\n\nOrdinary words\n",
            "![name][ref]\n\n[ref]: .assets/a.png\n",
            "```\n![x](.assets/a.png)\n```\n\nText words\n",
            "Words [[comment(Example): ![hidden](x)]]\n\n![x](.assets/a.png)",
            "<div>\n![x](.assets/a.png)\n</div>\n\nText words",
            "Math words\n\n![x](.assets/a.png)\n\n$$\n",
            "First 😀 café words\n\n- Nested **bold** words\n    - More text\n",
        ];
        let inserts = [
            "a", " ", "\n", "[", "]", "!", "(", ")", "`", "~", "\\", "😀", "*", "-", "#", ":",
        ];
        for example in examples {
            let mut index = Source::new(example);
            let mut seed = 71u64;
            for n in 0..240 {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                let at = seed as usize % (index.text.len_chars() + 1);
                let end = (at + usize::from(n % 3 == 0)).min(index.text.len_chars());
                index.replace(at, end, inserts[n % inserts.len()]);
                let exact = Store::references(&index.text.to_string());
                assert_eq!(
                    index.references(),
                    &exact,
                    "Incremental references must match complete parsing, example {example:?}, edit {n}"
                );
                assert_eq!(index.breaks.len_chars(), index.text.len_lines());
                assert_eq!(index.hazards.len_chars(), index.text.len_chars());
                assert_eq!(index.ink.len_chars(), index.text.len_chars());
            }
        }
    }
    #[test]
    fn rejected_source_and_missing_dependencies_never_poison_next_candidate() {
        let server = document("Plain words");
        let client = copy(&server);
        let mut validation = Validated::new(&server).unwrap();
        let bad = update(&client, 5, 0, "\r");
        assert!(validation.check(&server, &bad).is_err());
        assert!(validation.candidate.is_none());
        let fresh = copy(&server);
        check_and_accept(&mut validation, &server, &update(&fresh, 5, 0, "valid "));
        let offline = copy(&server);
        let first = update(&offline, 0, 0, "first ");
        let after = offline.transact().state_vector();
        offline
            .get_or_insert_text("content")
            .insert(&mut offline.transact_mut(), 0, "second ");
        let second = offline.transact().encode_state_as_update_v1(&after);
        assert!(matches!(
            validation.check(&server, &second).unwrap(),
            Check::MissingDependencies
        ));
        assert!(validation.candidate.is_none());
        check_and_accept(&mut validation, &server, &first);
        check_and_accept(&mut validation, &server, &second);
    }
    #[test]
    fn externally_accepted_changes_refresh_the_replica_without_full_clone() {
        let server = document("Plain **words**\n\n![x](.assets/a.png)");
        let mut validation = Validated::new(&server).unwrap();
        let updates = validation.updates();
        let client = copy(&server);
        let delta = update(&client, 6, 0, "earlier ");
        server
            .transact_mut()
            .apply_update(Update::decode_v1(&delta).unwrap())
            .unwrap();
        updates.push(&delta);
        assert_eq!(
            validation.references(&server).unwrap(),
            Store::references(
                &client
                    .get_or_insert_text("content")
                    .get_string(&client.transact())
            )
        );
        assert_eq!(
            validation
                .candidate
                .as_ref()
                .unwrap()
                .source
                .lock()
                .unwrap()
                .parses,
            1
        );
        // Quota/authorization rejection invalidates a successfully validated
        // speculative edit too, so a later peer cannot inherit its source.
        let rejected = update(&client, 0, 0, "![x](.assets/private.png)\n\n");
        assert!(matches!(
            validation.check(&server, &rejected).unwrap(),
            Check::Valid { .. }
        ));
        validation.reject();
        let fresh = copy(&server);
        check_and_accept(&mut validation, &server, &update(&fresh, 3, 0, "yes "));
    }
    #[test]
    fn unavailable_storage_cannot_leak_an_uncommitted_update_through_sync() {
        use super::super::{Peer, process_frame};
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost:3477".into(),
        )
        .unwrap();
        std::fs::write(store.root.join("test.md"), "Accepted source").unwrap();
        let document = store.index_document("test.md").unwrap();
        let room = store.room(&document).unwrap();
        store.persist(&document, &mut room.lock().unwrap()).unwrap();
        let client = copy(room.lock().unwrap().awareness.doc());
        let delta = update(&client, 8, 0, "new ");
        store.db.lock().unwrap().execute_batch("CREATE TRIGGER fail_validation_update BEFORE INSERT ON doc_updates BEGIN SELECT RAISE(ABORT,'test storage outage'); END;").unwrap();
        let frame = Message::Sync(SyncMessage::Update(delta)).encode_v1();
        assert!(
            process_frame(
                &store,
                &document,
                &room,
                &frame,
                true,
                true,
                &mut Peer::default()
            )
            .is_err()
        );
        let handshake = Message::Sync(SyncMessage::SyncStep1(StateVector::default())).encode_v1();
        assert!(
            process_frame(
                &store,
                &document,
                &room,
                &handshake,
                false,
                false,
                &mut Peer::default()
            )
            .is_err(),
            "An undurable room cannot answer another peer's bootstrap"
        );
        store
            .db
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_validation_update;")
            .unwrap();
        let responses = process_frame(
            &store,
            &document,
            &room,
            &handshake,
            false,
            false,
            &mut Peer::default(),
        )
        .unwrap();
        assert_eq!(responses.len(), 1);
        let Message::Sync(SyncMessage::SyncStep2(delta)) =
            Message::decode_v1(&responses[0]).unwrap()
        else {
            panic!("Expected synchronization bootstrap")
        };
        let received = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        received
            .transact_mut()
            .apply_update(Update::decode_v1(&delta).unwrap())
            .unwrap();
        assert_eq!(
            received
                .get_or_insert_text("content")
                .get_string(&received.transact()),
            "Acceptednew  source"
        );
    }
    #[test]
    fn plain_root_proof_rejects_rich_or_hidden_updates_before_speculation() {
        use yrs::{Map, types::Attrs};
        let server = document("Plain source");
        let mut validation = Validated::new(&server).unwrap();
        for case in 0..4 {
            let client = copy(&server);
            let before = client.transact().state_vector();
            match case {
                0 => client.get_or_insert_text("hidden").insert(
                    &mut client.transact_mut(),
                    0,
                    "invisible",
                ),
                1 => client.get_or_insert_text("content").insert_with_attributes(
                    &mut client.transact_mut(),
                    0,
                    "bold",
                    Attrs::from([("bold".into(), true.into())]),
                ),
                2 => {
                    client.get_or_insert_text("content").insert_embed(
                        &mut client.transact_mut(),
                        0,
                        "",
                    );
                }
                _ => {
                    client.get_or_insert_map("content").insert(
                        &mut client.transact_mut(),
                        "hidden",
                        "value",
                    );
                }
            }
            let update = client.transact().encode_state_as_update_v1(&before);
            assert!(
                validation.check(&server, &update).is_err(),
                "Case {case} bypassed the text-only proof"
            );
            assert_eq!(
                server
                    .get_or_insert_text("content")
                    .get_string(&server.transact()),
                "Plain source"
            );
        }
        let client = copy(&server);
        check_and_accept(&mut validation, &server, &update(&client, 5, 0, "valid "));
    }
    #[test]
    fn bounded_update_queue_rebuilds_from_all_current_authoritative_changes() {
        let server = document("Plain source");
        let client = copy(&server);
        let mut validation = Validated::new(&server).unwrap();
        for _ in 0..300 {
            let delta = update(&client, 6, 0, "a");
            server
                .transact_mut()
                .apply_update(Update::decode_v1(&delta).unwrap())
                .unwrap();
            validation.updates.push(&delta);
        }
        assert!(validation.updates.0.lock().unwrap().is_none());
        validation.references(&server).unwrap();
        let source = validation
            .candidate
            .as_ref()
            .unwrap()
            .source
            .lock()
            .unwrap();
        assert_eq!(
            source.text.to_string(),
            server
                .get_or_insert_text("content")
                .get_string(&server.transact())
        );
        drop(source);
        check_and_accept(&mut validation, &server, &update(&client, 0, 0, "Next "));
    }
    #[test]
    fn byte_indexed_replica_matches_utf16_authority_for_unicode_and_concurrent_edits() {
        let server =
            document("😀 First café words\n\n![例](.assets/世界.png)\n\n- Más *words* here");
        let client = copy(&server);
        let mut validation = Validated::new(&server).unwrap();
        let insertions = ["🔥", "é", "漢", "\n", "a", "", "😀 café "];
        for n in 0..90 {
            let current = client
                .get_or_insert_text("content")
                .get_string(&client.transact());
            let chars = current.chars().count();
            let from_char = (n * 7) % (chars + 1);
            let at = current
                .chars()
                .take(from_char)
                .map(char::len_utf16)
                .sum::<usize>();
            let remove = if n % 3 == 0 {
                current.chars().nth(from_char).map_or(0, char::len_utf16)
            } else {
                0
            };
            check_and_accept(
                &mut validation,
                &server,
                &update(
                    &client,
                    at as u32,
                    remove as u32,
                    insertions[n % insertions.len()],
                ),
            );
            let cached = validation
                .candidate
                .as_ref()
                .unwrap()
                .source
                .lock()
                .unwrap()
                .text
                .to_string();
            assert!(
                cached
                    == server
                        .get_or_insert_text("content")
                        .get_string(&server.transact()),
                "Byte-indexed candidate diverged from UTF16 authority at edit {n}"
            );
        }
        let first = copy(&server);
        let second = copy(&server);
        let a = update(&first, 0, 0, "😀 first ");
        let b = update(&second, 0, 0, "🌍 second ");
        check_and_accept(&mut validation, &server, &a);
        check_and_accept(&mut validation, &server, &b);
        let cached = validation
            .candidate
            .as_ref()
            .unwrap()
            .source
            .lock()
            .unwrap()
            .text
            .to_string();
        assert!(
            cached
                == server
                    .get_or_insert_text("content")
                    .get_string(&server.transact()),
            "Concurrent Unicode updates changed the byte-indexed source"
        );
    }
    #[test]
    fn unicode_line_separators_do_not_hide_multiline_link_destinations() {
        for gap in [
            "\u{2028}\u{2028}",
            "\u{2029}\u{2029}",
            "\u{85}\u{85}",
            "\n\u{2003}\n",
        ] {
            let source = format!("![x](prefix{gap}middle{gap}suffix.png)");
            let mut index = Source::new(&source);
            let at = source[..source.find("middle").unwrap()].chars().count() + 2;
            index.replace(at, at + 1, "X");
            let expected = Store::references(&index.text.to_string());
            assert_eq!(index.references(), &expected);
        }
    }
    #[test]
    fn unicode_midpoint_origins_and_delete_ranges_are_rejected_without_mutation() {
        fn var(out: &mut Vec<u8>, mut value: u64) {
            while value >= 128 {
                out.push(value as u8 | 128);
                value >>= 7;
            }
            out.push(value as u8);
        }
        for case in 0..3 {
            let server = document("😀word");
            let mut validation = Validated::new(&server).unwrap();
            let mut delta = Vec::new();
            if case == 2 {
                // Insert x between the two UTF-16 halves of the existing emoji.
                // Yjs and Rust strings split this differently; neither may
                // reach accepted state, even though the UTF-8 string is valid.
                delta.extend([1, 1]);
                var(&mut delta, 1);
                delta.push(0);
                delta.push(196);
                var(&mut delta, server.client_id().get());
                delta.push(0);
                var(&mut delta, server.client_id().get());
                delta.push(1);
                delta.extend([1, b'x', 0]);
            } else {
                delta.extend([0, 1]);
                var(&mut delta, server.client_id().get());
                delta.extend([1, case, 1]);
            }
            assert!(
                validation.check(&server, &delta).is_err(),
                "Unicode midpoint case {case} was accepted"
            );
            assert_eq!(
                server
                    .get_or_insert_text("content")
                    .get_string(&server.transact()),
                "😀word"
            );
            let client = copy(&server);
            check_and_accept(&mut validation, &server, &update(&client, 2, 0, " safe "));
        }
    }
    #[test]
    fn legacy_hidden_rich_history_cannot_seed_the_incremental_proof() {
        use yrs::Map;
        let doc = document("Plain source");
        let map = doc.get_or_insert_map("content");
        map.insert(&mut doc.transact_mut(), "hidden", "value");
        map.remove(&mut doc.transact_mut(), "hidden");
        assert!(
            super::super::security::validate_document(&doc).is_ok(),
            "The visible-only guard would accept this seed"
        );
        assert!(
            Validated::new(&doc).is_err(),
            "Retained rich parents must not seed the incremental validator"
        );
    }
}

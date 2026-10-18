//! File projection has one phase, independent of the accepted CRDT journal.
//! Only a successful fsync followed by a durable baseline commit reaches Synced.
use std::{collections::HashMap, sync::Arc};

#[derive(Clone, Debug)]
enum Phase {
    Synced,
    Pending,
    Blocked,
    Interrupted(Arc<[u8]>),
    InterruptedBlocked(Arc<[u8]>),
}
impl Phase {
    fn target(&self) -> Option<&Arc<[u8]>> {
        match self {
            Self::Interrupted(target) | Self::InterruptedBlocked(target) => Some(target),
            _ => None,
        }
    }
    fn blocked(&self) -> bool {
        matches!(self, Self::Blocked | Self::InterruptedBlocked(_))
    }
}

#[derive(Clone, Debug)]
struct Metadata {
    target: Option<Arc<[u8]>>,
    ending: String,
    migrated: bool,
    generation: i64,
    protected: i64,
}

fn same_target(left: Option<&Arc<[u8]>>, right: Option<&Arc<[u8]>>) -> bool {
    match (left, right) {
        (Some(a), Some(b)) => Arc::ptr_eq(a, b),
        (None, None) => true,
        _ => false,
    }
}

pub(super) struct Loaded {
    pub source: String,
    pub baseline: Arc<[u8]>,
    pub persisted_baseline: Arc<[u8]>,
    pub ending: String,
    pub migrated: bool,
    pub target: Option<Arc<[u8]>>,
    pub generation: i64,
    pub protected: i64,
}

pub(super) struct SaveState {
    phase: Phase,
    source: String,
    baseline: Arc<[u8]>,
    ending: String,
    migrated: bool,
    generation: i64,
    protected: i64,
    durable_baseline: Arc<[u8]>,
    durable_metadata: Option<Metadata>,
    pub snapshot_at: i64,
    pub receipts: HashMap<uuid::Uuid, String>,
}
impl SaveState {
    pub fn loaded(value: Loaded) -> Self {
        Self {
            phase: match value.target {
                Some(target) => Phase::Interrupted(target),
                None => Phase::Pending,
            },
            source: value.source,
            baseline: value.baseline,
            durable_baseline: value.persisted_baseline,
            ending: value.ending,
            migrated: value.migrated,
            generation: value.generation,
            protected: value.protected,
            durable_metadata: None,
            snapshot_at: 0,
            receipts: HashMap::new(),
        }
    }
    pub fn needs_projection(&self) -> bool {
        !matches!(self.phase, Phase::Synced)
    }
    pub fn waiting(&self) -> bool {
        self.phase.blocked()
    }
    pub fn interrupted(&self) -> bool {
        self.phase.target().is_some()
    }
    pub fn source(&self) -> &str {
        &self.source
    }
    pub fn baseline(&self) -> &[u8] {
        &self.baseline
    }
    pub fn ending(&self) -> &str {
        &self.ending
    }
    pub fn migrated(&self) -> bool {
        self.migrated
    }
    pub fn generation(&self) -> i64 {
        self.generation
    }
    pub fn protected(&self) -> i64 {
        self.protected
    }
    pub fn unprotected(&self) -> bool {
        self.generation != self.protected
    }
    pub fn protect(&mut self) {
        self.protected = self.generation;
    }
    pub fn request(&mut self) {
        if matches!(self.phase, Phase::Synced) {
            self.phase = Phase::Pending;
        }
    }
    pub fn edited(&mut self) {
        self.generation += 1;
        self.request();
    }
    /// An unavailable file never discards an interrupted write intent.
    pub fn block(&mut self) {
        self.phase = match self.phase.target() {
            Some(target) => Phase::InterruptedBlocked(target.clone()),
            None => Phase::Blocked,
        };
    }
    pub fn prepare_write(&mut self, target: Vec<u8>) {
        self.phase = Phase::Interrupted(target.into());
    }
    pub fn target(&self) -> Option<&[u8]> {
        self.phase.target().map(|target| target.as_ref())
    }
    pub fn target_changed(&self) -> bool {
        !same_target(
            self.phase.target(),
            self.durable_metadata
                .as_ref()
                .and_then(|meta| meta.target.as_ref()),
        )
    }
    /// A complete external save supersedes an old, interrupted file image.
    pub fn external_save(&mut self) {
        self.phase = Phase::Pending;
    }
    pub fn observe_ending(&mut self, raw: &str) {
        self.ending = crate::text::ending(raw, &self.ending);
    }
    pub fn imported(&mut self, source: String, baseline: Vec<u8>) {
        self.source = source;
        self.baseline = baseline.into();
        self.phase = Phase::Pending;
    }
    /// The file is fsynced, but not acknowledged until committed() succeeds.
    pub fn projected(&mut self, source: String, baseline: Vec<u8>) {
        self.imported(source, baseline);
    }
    pub fn complete(&mut self) {
        debug_assert!(
            !self.needs_commit(),
            "projection must be committed before acknowledgment"
        );
        self.phase = Phase::Synced;
    }
    pub fn baseline_changed(&self) -> bool {
        !Arc::ptr_eq(&self.baseline, &self.durable_baseline)
    }
    fn metadata(&self) -> Metadata {
        Metadata {
            target: self.phase.target().cloned(),
            ending: self.ending.clone(),
            migrated: self.migrated,
            generation: self.generation,
            protected: self.protected,
        }
    }
    pub fn needs_commit(&self) -> bool {
        self.baseline_changed()
            || self.durable_metadata.as_ref().is_none_or(|meta| {
                meta.ending != self.ending
                    || meta.migrated != self.migrated
                    || meta.generation != self.generation
                    || meta.protected != self.protected
                    || self.target_changed()
            })
    }
    pub fn committed(&mut self) {
        self.durable_baseline = self.baseline.clone();
        self.durable_metadata = Some(self.metadata());
    }
}

// Bound both operation count and encoded bytes. A long offline batch must not
// postpone checkpointing merely because it arrived in one WebSocket frame.
pub(super) struct Journal {
    checkpoint_missing: bool,
    len: usize,
    bytes: usize,
}
impl Journal {
    pub fn loaded(checkpoint_missing: bool, len: usize, bytes: usize) -> Self {
        Self {
            checkpoint_missing,
            len,
            bytes,
        }
    }
    pub fn checkpoint(&self, updates: &[Vec<u8>]) -> bool {
        self.checkpoint_missing
            || self.len + updates.len() >= 128
            || self
                .bytes
                .saturating_add(updates.iter().map(Vec::len).sum::<usize>())
                >= 1_000_000
    }
    pub fn committed(&mut self, checkpoint: bool, updates: &[Vec<u8>]) {
        if checkpoint {
            self.checkpoint_missing = false;
            self.len = 0;
            self.bytes = 0;
        } else {
            self.len += updates.len();
            self.bytes += updates.iter().map(Vec::len).sum::<usize>();
        }
    }
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.len
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state(intent: bool) -> SaveState {
        SaveState::loaded(Loaded {
            source: "old".into(),
            baseline: Arc::from([1]),
            persisted_baseline: Arc::from([]),
            ending: "lf".into(),
            migrated: false,
            target: intent.then(|| Arc::from(b"intended".as_slice())),
            generation: 2,
            protected: 1,
        })
    }
    #[test]
    fn only_committed_projection_becomes_synced() {
        let mut s = state(false);
        assert!(s.needs_projection());
        s.committed();
        s.complete();
        assert!(!s.needs_projection());
        s.edited();
        assert_eq!(s.generation(), 3);
        assert!(s.needs_projection());
        s.prepare_write(b"new".to_vec());
        assert!(s.interrupted());
        assert!(s.needs_commit());
        s.committed();
        s.projected("new".into(), vec![2]);
        assert!(s.needs_projection());
        assert!(s.needs_commit());
        s.committed();
        s.complete();
        assert!(!s.needs_projection());
        assert!(!s.interrupted());
    }
    #[test]
    fn blocking_and_new_edits_preserve_interrupted_intent() {
        for interrupted in [false, true] {
            let mut s = state(interrupted);
            s.block();
            s.edited();
            s.request();
            assert!(s.waiting());
            assert_eq!(s.interrupted(), interrupted);
            s.committed();
            assert!(!s.needs_commit());
            s.external_save();
            assert!(!s.interrupted());
            assert!(!s.waiting());
            assert!(s.needs_projection());
            assert_eq!(s.needs_commit(), interrupted);
        }
    }
    #[test]
    fn recovery_generation_and_format_commit_without_a_text_update() {
        let mut s = state(false);
        s.committed();
        assert!(s.unprotected());
        s.protect();
        assert!(!s.unprotected());
        assert!(s.needs_commit());
        s.committed();
        s.observe_ending("desktop\r\n");
        assert_eq!(s.ending(), "crlf");
        assert!(s.needs_commit());
    }
    #[test]
    fn journal_limits_both_bytes_and_count() {
        let mut journal = Journal::loaded(false, 0, 0);
        let small = vec![vec![1; 10]];
        for _ in 0..127 {
            assert!(!journal.checkpoint(&small));
            journal.committed(false, &small);
        }
        assert!(journal.checkpoint(&small));
        journal.committed(true, &small);
        assert_eq!(journal.len(), 0);
        assert!(journal.checkpoint(&[vec![0; 1_000_000]]));
    }
}

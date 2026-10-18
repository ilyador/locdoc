//! File projection has one phase, independent of the accepted CRDT journal.
//! Only a successful fsync followed by a durable baseline commit reaches Synced.
use std::{collections::HashMap, sync::Arc};

#[derive(Clone, Debug)]
struct WriteIntent {
    bytes: Arc<[u8]>,
    // Legacy intents may predate frozen causal state. New writes always carry
    // the state whose visible text produced bytes, independent of later edits.
    state: Option<Arc<[u8]>>,
    before_hash: Option<String>,
    before: Option<Arc<[u8]>>,
}

#[derive(Clone, Debug)]
enum Phase {
    Synced,
    Pending,
    Blocked,
    Interrupted(Arc<WriteIntent>),
    InterruptedBlocked(Arc<WriteIntent>),
    Conflict(Arc<WriteIntent>),
}
impl Phase {
    fn intent(&self) -> Option<&Arc<WriteIntent>> {
        match self {
            Self::Interrupted(target)
            | Self::InterruptedBlocked(target)
            | Self::Conflict(target) => Some(target),
            _ => None,
        }
    }
    fn blocked(&self) -> bool {
        matches!(self, Self::Blocked | Self::InterruptedBlocked(_))
    }
}

#[derive(Clone, Debug)]
struct Metadata {
    intent: Option<Arc<WriteIntent>>,
    intent_code: u8,
    ending: Arc<str>,
    migrated: bool,
    generation: i64,
    protected: i64,
}

fn same_intent(left: Option<&Arc<WriteIntent>>, right: Option<&Arc<WriteIntent>>) -> bool {
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
    pub target_state: Option<Arc<[u8]>>,
    pub conflicted: bool,
    pub before_hash: Option<String>,
    pub before: Option<Arc<[u8]>>,
    pub generation: i64,
    pub protected: i64,
}

pub(super) struct SaveState {
    phase: Phase,
    source: String,
    baseline: Arc<[u8]>,
    ending: Arc<str>,
    migrated: bool,
    generation: i64,
    protected: i64,
    durable_baseline: Arc<[u8]>,
    durable_metadata: Option<Metadata>,
    pub snapshot_at: i64,
    pub receipts: HashMap<uuid::Uuid, String>,
    projection: Projection,
    observed: Option<crate::disk::Stamp>,
}
impl SaveState {
    pub fn loaded(value: Loaded) -> Self {
        Self {
            phase: match value.target {
                Some(bytes) => {
                    let intent = Arc::new(WriteIntent {
                        bytes,
                        state: value.target_state,
                        before_hash: value.before_hash,
                        before: value.before,
                    });
                    if value.conflicted {
                        Phase::Conflict(intent)
                    } else {
                        Phase::Interrupted(intent)
                    }
                }
                None => Phase::Pending,
            },
            source: value.source,
            baseline: value.baseline,
            durable_baseline: value.persisted_baseline,
            ending: value.ending.into(),
            migrated: value.migrated,
            generation: value.generation,
            protected: value.protected,
            durable_metadata: None,
            snapshot_at: 0,
            receipts: HashMap::new(),
            projection: Projection::default(),
            observed: None,
        }
    }
    pub fn projection_due(&self) -> bool {
        !self.conflicted() && self.projection.due(std::time::Instant::now())
    }
    pub fn projection_delayed(&self, large: bool) -> bool {
        self.conflicted() || (!self.projection_due() && (large || self.projection.failures != 0))
    }
    pub fn projection_result(&mut self, result: &crate::Result<bool>, large: bool) {
        self.projection.finished(
            std::time::Instant::now(),
            result.as_ref().ok().copied(),
            large,
        );
    }
    pub fn observe_file(&mut self, stamp: Option<crate::disk::Stamp>) {
        self.observed = stamp;
    }
    pub fn observed_file(&self, stamp: Option<crate::disk::Stamp>) -> bool {
        stamp.is_some() && stamp == self.observed
    }
    pub fn desktop_changed(&mut self) {
        self.request();
        self.projection = Projection::default();
    }
    pub fn needs_projection(&self) -> bool {
        !matches!(self.phase, Phase::Synced)
    }
    pub fn waiting(&self) -> bool {
        self.phase.blocked()
    }
    pub fn interrupted(&self) -> bool {
        self.phase.intent().is_some()
    }
    pub fn conflicted(&self) -> bool {
        matches!(self.phase, Phase::Conflict(_))
    }
    pub fn conflict(&mut self) {
        if let Some(intent) = self.phase.intent() {
            self.phase = Phase::Conflict(intent.clone());
        }
    }
    pub fn intent_code(&self) -> u8 {
        match self.phase {
            Phase::Conflict(_) => 2,
            Phase::Interrupted(_) | Phase::InterruptedBlocked(_) => 1,
            _ => 0,
        }
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
        if self.conflicted() {
            return;
        }
        self.phase = match self.phase.intent() {
            Some(target) => Phase::InterruptedBlocked(target.clone()),
            None => Phase::Blocked,
        };
    }
    #[cfg(test)]
    pub fn prepare_write(&mut self, target: Vec<u8>, target_state: Vec<u8>) {
        let before = crate::text::render(&self.source, &self.ending);
        self.prepare_observed_write(target, target_state, before.as_bytes());
    }
    pub fn prepare_observed_write(
        &mut self,
        target: Vec<u8>,
        target_state: Vec<u8>,
        before: &[u8],
    ) {
        use sha2::Digest;
        let before_hash = Some(hex::encode(sha2::Sha256::digest(before)));
        // Normal writes reconstruct their exact preimage from the baseline and
        // separator layout. A retry may instead start from a torn byte image;
        // retain that exceptional preimage before attempting another overwrite.
        let baseline = crate::text::render(&self.source, &self.ending);
        let before = (baseline.as_bytes() != before).then(|| before.into());
        self.phase = Phase::Interrupted(Arc::new(WriteIntent {
            bytes: target.into(),
            state: Some(target_state.into()),
            before_hash,
            before,
        }));
    }
    pub fn before_hash(&self) -> Option<&str> {
        self.phase
            .intent()
            .and_then(|intent| intent.before_hash.as_deref())
    }
    pub fn before(&self) -> Option<&[u8]> {
        self.phase
            .intent()
            .and_then(|intent| intent.before.as_deref())
    }
    pub fn target(&self) -> Option<&[u8]> {
        self.phase.intent().map(|intent| intent.bytes.as_ref())
    }
    pub fn target_state(&self) -> Option<&[u8]> {
        self.phase
            .intent()
            .and_then(|intent| intent.state.as_deref())
    }
    pub fn target_changed(&self) -> bool {
        !same_intent(
            self.phase.intent(),
            self.durable_metadata
                .as_ref()
                .and_then(|meta| meta.intent.as_ref()),
        )
    }
    /// A complete external save supersedes an old, interrupted file image.
    pub fn external_save(&mut self) {
        self.phase = Phase::Pending;
    }
    pub fn observe_ending(&mut self, raw: &str) {
        let ending = crate::text::ending(raw, &self.ending);
        if ending != self.ending.as_ref() {
            self.ending = ending.into();
        }
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
        if self.conflicted() {
            return;
        }
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
            intent: self.phase.intent().cloned(),
            intent_code: self.intent_code(),
            ending: self.ending.clone(),
            migrated: self.migrated,
            generation: self.generation,
            protected: self.protected,
        }
    }
    pub fn needs_commit(&self) -> bool {
        self.baseline_changed()
            || self.durable_metadata.as_ref().is_none_or(|meta| {
                (!Arc::ptr_eq(&meta.ending, &self.ending) && meta.ending != self.ending)
                    || meta.intent_code != self.intent_code()
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
            target_state: intent.then(|| Arc::from([3])),
            conflicted: false,
            before_hash: None,
            before: None,
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
        s.prepare_write(b"new".to_vec(), vec![2]);
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
    fn frozen_write_state_survives_new_edits_and_blocking_until_projection_commits() {
        let mut s = state(false);
        s.committed();
        s.prepare_observed_write(b"target".to_vec(), vec![4, 5], b"old");
        assert_eq!(s.target(), Some(b"target".as_slice()));
        assert_eq!(s.target_state(), Some([4, 5].as_slice()));
        s.committed();
        s.edited();
        s.block();
        assert_eq!(s.target_state(), Some([4, 5].as_slice()));
        assert!(s.needs_commit());
        s.committed();
        assert!(!s.target_changed());
        // The same bytes may have a different CRDT identity after an undo or
        // reinsert. That causal change must still be committed with the intent.
        s.prepare_observed_write(b"target".to_vec(), vec![6, 7], b"old");
        assert!(s.target_changed());
        assert!(s.needs_commit());
        assert_eq!(s.target_state(), Some([6, 7].as_slice()));
        s.committed();
        s.projected("target".into(), vec![6, 7]);
        assert!(s.needs_commit());
        s.committed();
        s.complete();
        assert!(s.target().is_none());
        assert!(s.target_state().is_none());
    }
    #[test]
    fn conflicting_file_images_remain_frozen_until_an_explicit_resolution() {
        let mut s = state(true);
        s.committed();
        s.conflict();
        assert!(s.conflicted());
        assert_eq!(s.intent_code(), 2);
        assert!(!s.target_changed());
        assert!(s.needs_commit(), "the conflict flag must be durable");
        s.committed();
        s.block();
        s.edited();
        s.desktop_changed();
        assert!(s.conflicted());
        assert!(!s.projection_due());
        assert!(s.projection_delayed(false));
        assert_eq!(s.target(), Some(b"intended".as_slice()));
        assert_eq!(s.target_state(), Some([3].as_slice()));
        s.committed();
        assert!(!s.needs_commit());
        s.complete();
        assert!(
            s.conflicted(),
            "a normal completion cannot resolve ambiguity"
        );
        s.external_save();
        assert!(!s.conflicted());
        assert_eq!(s.intent_code(), 0);
        assert!(s.needs_commit());
        assert!(s.target_state().is_none());
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

// Projection cadence is transient scheduling, never an acknowledgment of edits.
// SQLite accepts each delta immediately; file receipts wait for the fsynced pass.
struct Projection {
    next: std::time::Instant,
    failures: u32,
}
impl Default for Projection {
    fn default() -> Self {
        Self {
            next: std::time::Instant::now(),
            failures: 0,
        }
    }
}
impl Projection {
    fn due(&self, now: std::time::Instant) -> bool {
        now >= self.next
    }
    fn finished(&mut self, now: std::time::Instant, success: Option<bool>, large: bool) {
        let delay = if success == Some(true) {
            self.failures = 0;
            if large { 1000 } else { 100 }
        } else if success == Some(false) {
            // A desktop writer may close without changing metadata. Poll lease
            // availability promptly; actual I/O/decoding errors back off below.
            self.failures = 0;
            100
        } else {
            self.failures = self.failures.saturating_add(1);
            (100u64 << self.failures.min(6)).min(5000)
        };
        self.next = now + std::time::Duration::from_millis(delay);
    }
}

#[cfg(test)]
mod scheduling_tests {
    use super::*;
    use std::time::{Duration, Instant};
    #[test]
    fn large_document_writes_are_coalesced_without_a_typing_starvation_debounce() {
        let now = Instant::now();
        let mut cadence = Projection::default();
        cadence.finished(now, Some(true), true);
        assert!(!cadence.due(now + Duration::from_millis(999)));
        assert!(cadence.due(now + Duration::from_millis(1000)));
        // Browser deltas do not move this deadline; a continuous typist still
        // reaches the next file pass once per second.
        cadence.finished(now + Duration::from_secs(1), Some(true), false);
        assert!(!cadence.due(now + Duration::from_millis(1099)));
        assert!(cadence.due(now + Duration::from_millis(1100)));
    }
    #[test]
    fn persistent_failures_back_off_with_a_bounded_recovery_delay() {
        let mut cadence = Projection::default();
        let mut now = Instant::now();
        for delay in [200, 400, 800, 1600, 3200, 5000, 5000] {
            cadence.finished(now, None, true);
            assert!(!cadence.due(now + Duration::from_millis(delay - 1)));
            now += Duration::from_millis(delay);
            assert!(cadence.due(now));
        }
        cadence.finished(now, Some(true), false);
        assert_eq!(cadence.failures, 0);
        assert!(cadence.due(now + Duration::from_millis(100)));
    }
}

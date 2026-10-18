//! Filesystem notices and fair, nonblocking room projection scheduling.
use super::*;
use notify::Watcher;

/// A notice stays queued until its room can be inspected. Skipping a busy room
/// must not lose a desktop save merely because its CRDT is currently locked.
#[derive(Default)]
struct Coordinator {
    changed: HashSet<String>,
}
impl Coordinator {
    fn sweep(&mut self, s: &Store, rescan: bool) {
        let rooms = s.rooms.lock().unwrap().clone();
        self.changed.retain(|id| rooms.contains_key(id));
        for (id, room) in rooms {
            if rescan {
                self.changed.insert(id.clone());
            }
            let Ok(mut r) = room.try_lock() else {
                continue;
            };
            let Ok(d) = s.doc(&id) else {
                continue;
            };
            if let Err(error) = r.visit_filesystem(s, &d, self.changed.remove(&id)) {
                tracing::warn!("pending disk save failed: {error}");
            }
        }
    }
}

/// Ordinary desktop atomic saves rename files without changing any grant.
/// Ambiguous notices must still cover a removed shared directory or ancestor,
/// including directories whose names happen to end in .md or .fountain.
fn invalidates_permissions(s: &Store, event: &notify::Event) -> Result<bool> {
    match event.kind {
        notify::EventKind::Create(notify::event::CreateKind::Folder)
        | notify::EventKind::Remove(notify::event::RemoveKind::Folder) => return Ok(true),
        notify::EventKind::Remove(notify::event::RemoveKind::File) => return Ok(false),
        notify::EventKind::Remove(_)
        | notify::EventKind::Modify(notify::event::ModifyKind::Name(_)) => {}
        _ => return Ok(false),
    }
    if event.paths.iter().any(|path| path.is_dir()) {
        return Ok(true);
    }
    let paths = event
        .paths
        .iter()
        .filter_map(|path| path.strip_prefix(&s.root).ok())
        .collect::<Vec<_>>();
    if paths.is_empty() {
        return Ok(true);
    }
    let db = s.db.lock().unwrap();
    let mut statement = db.prepare("SELECT path FROM folder_shares WHERE permission!='private'")?;
    for shared in statement.query_map([], |row| row.get::<_, String>(0))? {
        let shared = shared?;
        if paths
            .iter()
            .any(|path| Path::new(&shared).starts_with(path))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn watch(s: App) -> notify::Result<notify::RecommendedWatcher> {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    use std::time::{Duration, Instant};
    let (tx, rx) = mpsc::sync_channel(1024);
    let overflow = Arc::new(AtomicBool::new(false));
    let invalidated = overflow.clone();
    let mut watcher = notify::recommended_watcher(move |event| {
        if tx.try_send(event).is_err() {
            invalidated.store(true, Ordering::Relaxed);
        }
    })?;
    watcher.watch(&s.root, notify::RecursiveMode::Recursive)?;
    // A dedicated blocking coordinator owns projection work. A bounded event
    // queue plus invalidation fallback handles bulk checkouts without a backlog
    // proportional to filesystem traffic or blocking network runtime threads.
    std::thread::spawn(move || {
        let settle = Duration::from_millis(1000);
        let mut coordinator = Coordinator::default();
        let mut missing_after = Some(Instant::now() + settle);
        let mut next_sweep = Instant::now();
        let mut next_identity_recovery = Instant::now() + Duration::from_secs(1);
        loop {
            if Instant::now() >= next_sweep {
                if Instant::now() >= next_identity_recovery {
                    if let Err(error) = s.retry_file_operations() {
                        tracing::warn!("file operation recovery pending: {error}");
                    }
                    next_identity_recovery = Instant::now() + Duration::from_secs(1);
                }
                let rescan = overflow.swap(false, Ordering::Relaxed);
                if rescan {
                    missing_after = Some(Instant::now() + settle);
                    s.permissions.invalidate();
                }
                coordinator.sweep(&s, rescan);
                if missing_after.is_some_and(|deadline| Instant::now() >= deadline) {
                    if let Err(error) = s.retire_missing_documents() {
                        tracing::warn!("document scan failed: {error}");
                    }
                    missing_after = None;
                }
                next_sweep = Instant::now() + Duration::from_millis(100);
            }
            let result = match rx.recv_timeout(next_sweep.saturating_duration_since(Instant::now()))
            {
                Ok(event) => event,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            let Ok(event): notify::Result<notify::Event> = result else {
                overflow.store(true, Ordering::Relaxed);
                continue;
            };
            // Permission reads are cached per socket. Only namespace changes
            // affecting directory capabilities invalidate that cache; normal
            // atomic desktop saves must not send every peer back to SQLite.
            if invalidates_permissions(&s, &event).unwrap_or(true) {
                s.permissions.invalidate();
            }
            if matches!(
                event.kind,
                notify::EventKind::Remove(_)
                    | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
            ) {
                missing_after = Some(Instant::now() + settle);
            }
            if !matches!(
                event.kind,
                notify::EventKind::Access(notify::event::AccessKind::Close(
                    notify::event::AccessMode::Write
                )) | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
                    | notify::EventKind::Modify(notify::event::ModifyKind::Metadata(_))
            ) {
                continue;
            }
            for p in event.paths {
                if documents::format(&p.to_string_lossy()).is_some()
                    && let Ok(rel) = p.strip_prefix(&s.root)
                    && let Ok(d) = s.index_document(&rel.to_string_lossy())
                    && s.rooms.lock().unwrap().contains_key(&d.id)
                {
                    // Compare the latest metadata during the next sweep,
                    // without reopening the file or waiting for its room.
                    coordinator.changed.insert(d.id);
                }
            }
        }
    });
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, App, Document, Document) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(
            directory.path().join("docs"),
            directory.path().join("state"),
            "http://localhost:3477".into(),
        )
        .unwrap();
        let busy = store.create_document("busy.md").unwrap();
        let ready = store.create_document("ready.md").unwrap();
        for document in [&busy, &ready] {
            let room = store.room(document).unwrap();
            store.persist(document, &mut room.lock().unwrap()).unwrap();
        }
        (directory, store, busy, ready)
    }

    #[test]
    fn ambiguous_notices_cover_removed_shared_folders_and_ancestors() {
        use notify::event::{ModifyKind, RemoveKind, RenameMode};
        let (_directory, store, _busy, _ready) = fixture();
        store
            .db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO folder_shares(path,identity,permission,token) VALUES(?,?,'view',?)",
                params![
                    "Screenplay.md/Pages",
                    "synthetic-directory-identity",
                    token()
                ],
            )
            .unwrap();
        for relative in ["Screenplay.md", "Screenplay.md/Pages"] {
            let missing = store.root.join(relative);
            assert!(!missing.exists());
            for kind in [
                notify::EventKind::Modify(ModifyKind::Name(RenameMode::From)),
                notify::EventKind::Remove(RemoveKind::Any),
            ] {
                let event = notify::Event::new(kind).add_path(missing.clone());
                assert!(invalidates_permissions(&store, &event).unwrap());
            }
        }
        let sibling = notify::Event::new(notify::EventKind::Modify(ModifyKind::Name(
            RenameMode::Both,
        )))
        .add_path(store.root.join("Screenplay.md.bak"));
        assert!(!invalidates_permissions(&store, &sibling).unwrap());
        let ordinary = notify::Event::new(notify::EventKind::Remove(RemoveKind::File))
            .add_path(store.root.join("busy.md"));
        assert!(!invalidates_permissions(&store, &ordinary).unwrap());
        let known_folder = notify::Event::new(notify::EventKind::Remove(RemoveKind::Folder))
            .add_path(store.root.join("Screenplay.md"));
        assert!(invalidates_permissions(&store, &known_folder).unwrap());
    }

    #[test]
    fn ordinary_atomic_desktop_saves_do_not_invalidate_socket_permissions() {
        let (_directory, store, document, _other) = fixture();
        let room = store.room(&document).unwrap();
        let watcher = watch(store.clone()).unwrap();
        let generation = store.permissions.current();
        let temporary = store.root.join("atomic.tmp");
        fs::write(&temporary, "Atomically replaced desktop text\n").unwrap();
        fs::rename(temporary, store.root.join(&document.path)).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while room_text(&room.lock().unwrap()) != "Atomically replaced desktop text\n"
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        drop(watcher);
        assert_eq!(
            room_text(&room.lock().unwrap()),
            "Atomically replaced desktop text\n"
        );
        assert_eq!(
            store.permissions.current(),
            generation,
            "A desktop file replacement must not invalidate every socket's permission cache"
        );
    }

    #[test]
    fn busy_rooms_do_not_block_other_saves_or_lose_desktop_notices() {
        let (_directory, store, busy, ready) = fixture();
        let busy_room = store.room(&busy).unwrap();
        let ready_room = store.room(&ready).unwrap();
        {
            let mut room = ready_room.lock().unwrap();
            let source = room_text(&room);
            apply_text(room.awareness.doc(), &source, "Accepted browser edit\n");
            room.engine.edited();
            store.store_room(&ready, &mut room).unwrap();
        }
        fs::write(store.root.join(&busy.path), "Complete desktop save\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(110));
        let held = busy_room.lock().unwrap();
        let mut coordinator = Coordinator {
            changed: HashSet::from([busy.id.clone()]),
        };
        let (done, result) = std::sync::mpsc::channel();
        let worker = store.clone();
        let thread = std::thread::spawn(move || {
            coordinator.sweep(&worker, false);
            let _ = done.send(coordinator);
        });
        let completed = result.recv_timeout(std::time::Duration::from_secs(2));
        // Release before asserting, so a failure never strands a test worker.
        drop(held);
        thread.join().unwrap();
        let mut coordinator = completed.expect("a busy room must not block another document");
        assert_eq!(
            fs::read_to_string(store.root.join(&ready.path)).unwrap(),
            "Accepted browser edit\n"
        );
        assert!(coordinator.changed.contains(&busy.id));
        coordinator.sweep(&store, false);
        assert_eq!(
            room_text(&busy_room.lock().unwrap()),
            "Complete desktop save\n"
        );
        assert!(coordinator.changed.is_empty());
    }

    #[test]
    fn a_conflicting_file_lease_cannot_stall_other_documents_projection() {
        use std::time::Duration;
        let (_directory, store, busy, ready) = fixture();
        for document in [&busy, &ready] {
            let room = store.room(document).unwrap();
            let mut room = room.lock().unwrap();
            let source = room_text(&room);
            apply_text(room.awareness.doc(), &source, "Accepted browser edit\n");
            room.engine.edited();
            store.store_room(document, &mut room).unwrap();
        }
        let busy_path = store.root.join(&busy.path);
        let before = fs::read_to_string(&busy_path).unwrap();
        let held = DiskFile::open_read(&busy_path).unwrap().unwrap();
        std::thread::sleep(Duration::from_millis(110));
        let (done, result) = std::sync::mpsc::channel();
        let worker = store.clone();
        let thread = std::thread::spawn(move || {
            Coordinator::default().sweep(&worker, false);
            done.send(()).unwrap();
        });
        let completed = result.recv_timeout(Duration::from_millis(500));
        // An old blocking open must not make this regression wait 45 seconds.
        drop(held);
        thread.join().unwrap();
        assert!(
            completed.is_ok(),
            "A leased file must not block the projection sweep"
        );
        assert_eq!(fs::read_to_string(&busy_path).unwrap(), before);
        assert_eq!(
            fs::read_to_string(store.root.join(&ready.path)).unwrap(),
            "Accepted browser edit\n"
        );
        let room = store.room(&busy).unwrap();
        assert!(room.lock().unwrap().engine.needs_projection());
        assert!(store.persist(&busy, &mut room.lock().unwrap()).unwrap());
        assert_eq!(
            fs::read_to_string(busy_path).unwrap(),
            "Accepted browser edit\n"
        );
    }

    #[test]
    fn an_overflow_rescan_remembers_busy_rooms_and_own_closes_preserve_backoff() {
        let (_directory, store, busy, _ready) = fixture();
        let room = store.room(&busy).unwrap();
        fs::write(store.root.join(&busy.path), "Desktop after lost notice\n").unwrap();
        let held = room.lock().unwrap();
        let mut coordinator = Coordinator::default();
        coordinator.sweep(&store, true);
        assert!(coordinator.changed.contains(&busy.id));
        drop(held);
        coordinator.sweep(&store, false);
        assert_eq!(
            room_text(&room.lock().unwrap()),
            "Desktop after lost notice\n"
        );

        let mut held = room.lock().unwrap();
        held.engine.request();
        held.engine
            .projection_result(&Err(bad("Retry later")), false);
        assert!(!held.engine.projection_due());
        drop(held);
        coordinator.changed.insert(busy.id.clone());
        coordinator.sweep(&store, false);
        assert!(room.lock().unwrap().engine.needs_projection());
        assert!(!room.lock().unwrap().engine.projection_due());
    }
}

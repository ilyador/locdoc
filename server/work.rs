//! Await document ownership before occupying a shared blocking worker. A queue
//! for one busy document must not exhaust storage capacity for every other one.
use std::{
    collections::HashMap,
    sync::{Arc, Condvar, Mutex, Weak},
};

fn keyed<T: Default>(registry: &Mutex<HashMap<String, Weak<T>>>, id: &str) -> Arc<T> {
    let mut entries = registry.lock().unwrap();
    if entries.len() >= 256 {
        entries.retain(|_, value| value.strong_count() != 0);
    }
    let gate = entries
        .get(id)
        .and_then(Weak::upgrade)
        .unwrap_or_else(|| Arc::new(T::default()));
    entries.insert(id.to_owned(), Arc::downgrade(&gate));
    gate
}

#[derive(Default)]
pub(super) struct Documents(Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>);
impl Documents {
    pub(super) async fn acquire(&self, id: String) -> tokio::sync::OwnedMutexGuard<()> {
        keyed(&self.0, &id).lock_owned().await
    }
}

/// Cold room construction can block on a file or decode substantial history.
/// Keep one constructor per document without holding the global cache map or
/// recursively acquiring the caller's asynchronous document admission.
#[derive(Default)]
pub(super) struct RoomLoads(Mutex<HashMap<String, Weak<Load>>>);

#[derive(Default)]
struct Load {
    active: Mutex<bool>,
    available: Condvar,
}

pub(super) struct LoadGuard(Arc<Load>);
impl RoomLoads {
    pub(super) fn acquire(&self, id: &str) -> LoadGuard {
        let gate = keyed(&self.0, id);
        let mut active = gate.active.lock().unwrap();
        while *active {
            active = gate.available.wait(active).unwrap();
        }
        *active = true;
        drop(active);
        LoadGuard(gate)
    }
}
impl Drop for LoadGuard {
    fn drop(&mut self) {
        *self.0.active.lock().unwrap() = false;
        self.0.available.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Store, doc_job, job};
    use std::time::Duration;

    #[test]
    fn blocking_load_admission_is_per_document_and_released_by_its_owner() {
        let loads = Arc::new(RoomLoads::default());
        let first = loads.acquire("same");
        let (started, ready) = std::sync::mpsc::channel();
        let (entered, completion) = std::sync::mpsc::channel();
        let waiting = loads.clone();
        let worker = std::thread::spawn(move || {
            started.send(()).unwrap();
            let _second = waiting.acquire("same");
            entered.send(()).unwrap();
        });
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        let unrelated = loads.acquire("another");
        assert!(completion.try_recv().is_err());
        drop(unrelated);
        drop(first);
        let completed = completion.recv_timeout(Duration::from_secs(2));
        worker.join().unwrap();
        assert!(completed.is_ok());
        // Completed document IDs are weak entries, not permanent room handles.
        for index in 0..512 {
            drop(loads.acquire(&format!("document-{index}")));
        }
        assert!(loads.0.lock().unwrap().len() < 256);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn queued_peers_on_one_document_leave_workers_for_other_documents() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(
            directory.path().join("docs"),
            directory.path().join("state"),
            "http://localhost".into(),
        )
        .unwrap();
        let room = Arc::new(Mutex::new(()));
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let busy = room.clone();
        let app = store.clone();
        let first = tokio::spawn(async move {
            doc_job(app, "busy".into(), move |_| {
                let _lock = busy.lock().unwrap();
                started.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(2)).unwrap();
                Ok(())
            })
            .await
            .unwrap();
        });
        ready.await.unwrap();
        let mut queued = Vec::new();
        for _ in 0..8 {
            let app = store.clone();
            let room = room.clone();
            queued.push(tokio::spawn(async move {
                doc_job(app, "busy".into(), move |_| {
                    let _lock = room.lock().unwrap();
                    Ok(())
                })
                .await
                .unwrap();
            }));
        }
        for _ in 0..32 {
            tokio::task::yield_now().await;
        }
        let unrelated = tokio::time::timeout(
            Duration::from_millis(500),
            doc_job(store.clone(), "another".into(), |_| Ok(())),
        )
        .await;
        let general =
            tokio::time::timeout(Duration::from_millis(500), job(store, |_| Ok(()))).await;
        release.send(()).unwrap();
        first.await.unwrap();
        for peer in queued {
            peer.await.unwrap();
        }
        assert!(
            matches!(unrelated, Ok(Ok(()))),
            "a queued busy-room peer must not starve other documents"
        );
        assert!(
            matches!(general, Ok(Ok(()))),
            "metadata work must retain shared worker capacity"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_the_caller_does_not_release_a_running_documents_admission() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(
            directory.path().join("docs"),
            directory.path().join("state"),
            "http://localhost".into(),
        )
        .unwrap();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let app = store.clone();
        let pending = tokio::spawn(async move {
            doc_job(app, "same".into(), move |_| {
                started.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(2)).unwrap();
                Ok(())
            })
            .await
        });
        ready.await.unwrap();
        pending.abort();
        let blocked = tokio::time::timeout(
            Duration::from_millis(30),
            store.document_jobs.acquire("same".into()),
        )
        .await;
        release.send(()).unwrap();
        assert!(
            blocked.is_err(),
            "the blocking job owns admission until its work completes"
        );
        let _guard = tokio::time::timeout(
            Duration::from_secs(1),
            store.document_jobs.acquire("same".into()),
        )
        .await
        .unwrap();
    }
}

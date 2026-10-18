//! Await document ownership before occupying a shared blocking worker. A queue
//! for one busy document must not exhaust storage capacity for every other one.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};

#[derive(Default)]
pub(super) struct Documents(Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>);
impl Documents {
    pub(super) async fn acquire(&self, id: String) -> tokio::sync::OwnedMutexGuard<()> {
        let gate = {
            let mut documents = self.0.lock().unwrap();
            if documents.len() >= 256 {
                documents.retain(|_, value| value.strong_count() != 0);
            }
            let gate = documents
                .get(&id)
                .and_then(Weak::upgrade)
                .unwrap_or_else(|| Arc::new(tokio::sync::Mutex::new(())));
            documents.insert(id, Arc::downgrade(&gate));
            gate
        };
        gate.lock_owned().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Store, doc_job, job};
    use std::time::Duration;

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

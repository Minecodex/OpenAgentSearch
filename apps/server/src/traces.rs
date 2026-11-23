use oas_adapters::repository::Repository;
use oas_application::engine::Execution;
use oas_domain::RequestStart;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use tokio::sync::{mpsc, oneshot};
#[derive(Default)]
pub struct Counters {
    pub dropped: AtomicU64,
    pub failed: AtomicU64,
    pub stored: AtomicU64,
}
pub struct Record {
    pub start: RequestStart,
    pub execution: Execution,
    pub duration: u64,
}
pub enum Message {
    Record(Box<Record>),
    Flush(oneshot::Sender<()>),
}
pub fn writer(repo: Repository, counters: Arc<Counters>) -> mpsc::Sender<Message> {
    let capacity = std::env::var("OAS_TRACE_QUEUE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8)
        .clamp(1, 1024);
    let (tx, mut rx) = mpsc::channel::<Message>(capacity);
    tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            match message {
                Message::Record(record) => {
                    let Record {
                        start,
                        execution,
                        duration,
                    } = *record;
                    if let Err(error) = repo.finish(&start, execution, duration).await {
                        counters.failed.fetch_add(1, Ordering::Relaxed);
                        tracing::error!(request_id=%start.id,error=%error,"diagnostic write failed");
                        let _ = repo
                            .recording_failed(&start.id, "diagnostic_write_failed")
                            .await;
                    } else {
                        counters.stored.fetch_add(1, Ordering::Relaxed);
                    }
                }
                Message::Flush(done) => {
                    let _ = done.send(());
                }
            }
        }
    });
    tx
}

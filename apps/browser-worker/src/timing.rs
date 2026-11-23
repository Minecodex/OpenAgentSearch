use anyhow::Result;
use oas_domain::observation::Phase;
use std::{
    future::Future,
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio_util::sync::CancellationToken;
#[derive(Clone)]
pub struct Trace {
    start: Instant,
    phases: Arc<Mutex<Vec<Phase>>>,
    cancel: CancellationToken,
}
impl Trace {
    pub fn new(cancel: CancellationToken) -> Self {
        Self {
            start: Instant::now(),
            phases: Default::default(),
            cancel,
        }
    }
    pub fn begin(&self, stage: &str) -> Guard {
        Guard {
            trace: self.clone(),
            stage: stage.into(),
            started: Instant::now(),
            offset: self.start.elapsed().as_millis() as u64,
            status: None,
        }
    }
    pub async fn measure<T>(
        &self,
        stage: &str,
        work: impl Future<Output = Result<T>>,
    ) -> Result<T> {
        let mut guard = self.begin(stage);
        let value = work.await;
        guard.finish(value.is_ok());
        value
    }
    pub fn snapshot(&self) -> Vec<Phase> {
        let mut phases = self.phases.lock().unwrap().clone();
        phases.sort_by_key(|p| p.start_offset_ms);
        phases
    }
}
pub struct Guard {
    trace: Trace,
    stage: String,
    started: Instant,
    offset: u64,
    status: Option<&'static str>,
}
impl Guard {
    pub fn finish(&mut self, success: bool) {
        self.status = Some(if success { "success" } else { "error" });
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        self.trace.phases.lock().unwrap().push(Phase {
            stage: self.stage.clone(),
            start_offset_ms: self.offset,
            duration_ms: self.started.elapsed().as_millis() as u64,
            status: self
                .status
                .unwrap_or(if self.trace.cancel.is_cancelled() {
                    "cancelled"
                } else {
                    "error"
                })
                .into(),
            source: "worker".into(),
            scope: "call".into(),
            parent_stage: Some("execute".into()),
        });
    }
}

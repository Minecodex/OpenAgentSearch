mod browser_context;
mod browser_timing;
pub mod cache;
mod cache_hooks;
mod calls;
mod compression;
mod cpu;
pub mod engine;
mod journal;
mod pipeline;
mod planning;
#[cfg(test)]
#[path = "../../../tests/rust_proof.rs"]
mod proof;
mod rewrite;
mod scoring;
mod search_cards;
mod sources;
mod synthesis;
pub use journal::Dispatch;
#[cfg(test)]
mod tests;
use async_trait::async_trait;
use oas_domain::{Endpoint, Result, Snapshot, WorkerNode};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

pub struct PreparedInvocation {
    pub input: Value,
    pub model_request: Option<Value>,
    pub input_tokens: Option<usize>,
}
impl PreparedInvocation {
    pub fn new(endpoint: &Endpoint, task: &str, input: &Value) -> Result<Self> {
        let model = if endpoint.kind == "model" {
            Some(oas_domain::model::checked(endpoint, task, input)?)
        } else {
            None
        };
        Ok(Self {
            input: input.clone(),
            model_request: model.as_ref().map(|(value, _)| value.clone()),
            input_tokens: model.map(|(_, tokens)| tokens),
        })
    }
}
pub async fn prepare(endpoint: &Endpoint, task: &str, input: &Value) -> Result<PreparedInvocation> {
    if endpoint.kind != "model" {
        return PreparedInvocation::new(endpoint, task, input);
    }
    let (endpoint, task, input) = (endpoint.clone(), task.to_owned(), input.clone());
    cpu::run(&CancellationToken::new(), move || {
        PreparedInvocation::new(&endpoint, &task, &input)
    })
    .await
}
pub struct Invocation<'a> {
    pub timeout: std::time::Duration,
    pub endpoint: &'a Endpoint,
    pub task: &'a str,
    pub prepared: &'a PreparedInvocation,
    pub snapshot: &'a Snapshot,
    pub session: Option<&'a Value>,
    pub cancel: &'a CancellationToken,
    pub dispatch: &'a Dispatch,
}
pub struct BrowserOpen<'a> {
    pub background: bool,
    pub deadline: tokio::time::Instant,
    pub node: &'a WorkerNode,
    pub proxy: Option<&'a Value>,
    pub probe: Option<&'a Value>,
    pub snapshot: &'a Snapshot,
    pub request: &'a str,
    pub job: &'a str,
    pub cancel: &'a CancellationToken,
}

#[async_trait]
pub trait Transport: Send + Sync {
    async fn validate(&self, endpoint: &Endpoint) -> Result<()>;
    /// A cached body is subject to the same destination policy as an upstream read.
    async fn validate_read_target(&self, _url: &str) -> Result<()> {
        Ok(())
    }
    async fn preflight(
        &self,
        endpoint: &Endpoint,
        task: &str,
        input: &Value,
    ) -> Result<PreparedInvocation> {
        prepare(endpoint, task, input).await
    }
    async fn invoke(&self, invocation: Invocation<'_>) -> Result<Value>;
    async fn open_browser(&self, open: BrowserOpen<'_>) -> Result<Value>;
    async fn close_browser(&self, session: &Value) -> Result<()>;
    async fn search_engine_failed(&self, _session: &Value, _reason: &str) -> Result<()> {
        Ok(())
    }
    async fn risk(&self, id: &str, until: i64) -> Result<()>;
    async fn proxy_state(&self, _id: &str, _version: i64, _state: &Value) -> Result<()> {
        Ok(())
    }
}

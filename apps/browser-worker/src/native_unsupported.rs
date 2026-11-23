use anyhow::{Result, bail};
use serde_json::Value;
use std::time::Duration;

/// The execution image uses Linux Firefox; other hosts can still build the workspace.
pub struct Browser;
impl Browser {
    pub async fn start(_proxy_port: u16) -> Result<Self> {
        bail!("Native Messaging browser execution requires the Linux container")
    }
    pub async fn call(&self, _op: &str, _args: Value, _timeout: Duration) -> Result<Value> {
        bail!("Native Messaging browser execution requires the Linux container")
    }
}

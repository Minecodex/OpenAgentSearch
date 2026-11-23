use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Phase {
    pub stage: String,
    pub start_offset_ms: u64,
    pub duration_ms: u64,
    pub status: String,
    pub source: String,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_stage: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProxyTest {
    pub reachable: bool,
    pub passed: bool,
    pub proxy_healthy: Option<bool>,
    pub expected_status: u16,
    pub http_status: Option<u16>,
    pub body_matches: Option<bool>,
    pub failure_kind: Option<String>,
    pub total_ms: u64,
    pub first_byte_ms: Option<u64>,
    pub phases: Vec<Phase>,
    pub checked_at: chrono::DateTime<chrono::Utc>,
    pub probe_pod_uid: String,
}

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_BROWSER_SLOTS: usize = 6;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerCommand {
    pub job_id: String,
    pub request_id: String,
    pub owner: String,
    pub pod_uid: String,
    pub action: String,
    pub deadline_ms: u64,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub time_range: Option<String>,
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub count: usize,
    #[serde(default)]
    pub proxy: Option<Value>,
}

/// The scheduler and URL builder resolve the same native engine capability.
pub enum SearchTimeFilter {
    Google(&'static str),
    Baidu(i64),
}
impl SearchTimeFilter {
    pub fn resolve(engine: &str, range: &str) -> Option<Self> {
        match (engine, range) {
            ("google", "day") => Some(Self::Google("qdr:d")),
            ("google", "month") => Some(Self::Google("qdr:m")),
            ("google", "year") => Some(Self::Google("qdr:y")),
            ("baidu", "day") => Some(Self::Baidu(1)),
            ("baidu", "month") => Some(Self::Baidu(30)),
            ("baidu", "year") => Some(Self::Baidu(365)),
            _ => None,
        }
    }
    pub fn parameter(self, until: i64) -> (&'static str, String) {
        match self {
            Self::Google(tbs) => ("tbs", tbs.into()),
            Self::Baidu(days) => (
                "gpc",
                format!("stf={},{until}|stftype=1", until - days * 86400),
            ),
        }
    }
}

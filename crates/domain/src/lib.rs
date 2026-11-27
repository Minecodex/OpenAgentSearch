pub mod administrator;
pub mod archive;
pub mod article;
pub mod cache;
pub mod evidence;
pub mod model;
mod model_prompt;
pub mod observation;
pub mod privacy;
#[cfg(test)]
#[path = "../../../tests/rust_proof.rs"]
mod proof;
pub mod search_cards;
pub mod tokens;
pub mod validation;
pub mod worker;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone)]
pub struct Error {
    pub code: String,
    pub status: u16,
    pub zh: String,
    pub en: String,
    pub details: Box<Value>,
}

impl Error {
    pub fn new(code: &str, status: u16, zh: &str, en: &str) -> Self {
        Self {
            code: code.into(),
            status,
            zh: zh.into(),
            en: en.into(),
            details: Box::new(Value::Null),
        }
    }
    pub fn field(mut self, field: &str) -> Self {
        self.details = Box::new(json!({"field":field}));
        self
    }
    pub fn invalid(field: &str) -> Self {
        Self::new(
            "INVALID_ARGUMENT",
            400,
            "字段值无效。",
            "Invalid field value.",
        )
        .field(field)
    }
    pub fn unavailable() -> Self {
        Self::new(
            "SERVICE_UNAVAILABLE",
            503,
            "所需能力暂不可用。",
            "A required capability is unavailable.",
        )
    }
    pub fn internal() -> Self {
        Self::new(
            "INTERNAL_ERROR",
            500,
            "服务暂时无法完成操作。",
            "The service could not complete this operation.",
        )
    }
    pub fn cancelled() -> Self {
        Self::new(
            "CANCELLED",
            499,
            "请求已取消。",
            "The request was cancelled.",
        )
    }
    pub fn timeout() -> Self {
        Self::new(
            "DEADLINE_EXCEEDED",
            504,
            "请求超出总时限。",
            "The request deadline was exceeded.",
        )
    }
    pub fn envelope(&self, id: &str, lang: &str) -> Value {
        json!({"request_id":id,"status":if self.code=="CANCELLED" {"cancelled"} else {"error"},
            "data":null,"warnings":[],"error":{"code":self.code,"message":if lang.starts_with("en") {&self.en} else {&self.zh},"details":self.details}})
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.code)
    }
}
impl std::error::Error for Error {}

pub fn success(id: &str, data: Value) -> Value {
    json!({"request_id":id,"status":"success","data":data,"warnings":[],"error":null})
}
pub fn id() -> String {
    Uuid::new_v4().to_string()
}
pub fn unknown_probe() -> Value {
    json!({"reachable":null,"checked_at":null})
}
pub const BROWSER_SEARCH: &str = "00000000-0000-4000-8000-000000000001";
pub const BROWSER_READER: &str = "00000000-0000-4000-8000-000000000002";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Endpoint {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub provider: String,
    pub adapter: String,
    pub base_url: Option<String>,
    pub timeout_ms: u64,
    pub max_concurrency: usize,
    pub rpm: usize,
    pub options: Value,
    pub version: i64,
    #[serde(default)]
    pub managed_by: String,
    #[serde(default)]
    pub availability: String,
    #[serde(default)]
    pub has_secret: bool,
    #[serde(default)]
    pub last_test: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ready_pods: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_network_google_probe: Option<Value>,
}
impl Endpoint {
    pub fn browser(&self) -> bool {
        self.provider == "browser"
    }
    pub fn supports(&self, range: Option<&str>, query: &str) -> bool {
        if self.kind != "search" {
            return true;
        }
        let range_ok = range.is_none_or(|range| match self.provider.as_str() {
            "tavily" | "searxng" => matches!(range, "day" | "month" | "year"),
            "browser" => ["google", "baidu"]
                .iter()
                .any(|engine| worker::SearchTimeFilter::resolve(engine, range).is_some()),
            _ => false,
        });
        range_ok && (self.provider != "deepseek" || query.chars().count() <= 128)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Project {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub search_pools: Vec<Vec<String>>,
    pub reader_pools: Vec<Vec<String>>,
    #[serde(default)]
    pub model_endpoint_id: Option<String>,
    #[serde(default)]
    pub browser_proxy_pool_id: Option<String>,
    #[serde(default = "ten")]
    pub search_limit: usize,
    #[serde(default = "four")]
    pub source_limit: usize,
    #[serde(default = "body_limit")]
    pub body_limit: usize,
    #[serde(default = "summary_limit")]
    pub summary_limit: usize,
    #[serde(default = "one")]
    pub rewrite_count: usize,
    #[serde(default = "enabled")]
    pub search_original_query: bool,
    #[serde(default)]
    pub summary_snippets_only: bool,
    #[serde(default)]
    pub allow_snippets: bool,
    #[serde(default)]
    pub cache_enabled: bool,
    #[serde(default)]
    pub cache_epoch: i64,
    #[serde(default)]
    pub cache_access_epoch: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_policy: Option<cache::PolicyOverrides>,
    #[serde(default)]
    pub version: i64,
}
fn ten() -> usize {
    10
}
fn four() -> usize {
    4
}
fn one() -> usize {
    1
}
fn enabled() -> bool {
    true
}
fn body_limit() -> usize {
    40000
}
fn summary_limit() -> usize {
    1200
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Command {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_chars: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_range: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_time: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hit {
    pub url: String,
    pub title: String,
    pub snippet: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_summary_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache: Option<cache::CachedOrigin>,
    #[serde(default)]
    pub coverage: cache::Coverage,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub rank: usize,
    #[serde(default)]
    pub variant_id: String,
    #[serde(default)]
    pub call_id: String,
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub project: Project,
    pub endpoints: Vec<Endpoint>,
    pub proxies: Vec<Value>,
    pub pools: Vec<Value>,
    pub routes: Value,
    pub secrets: HashMap<String, Value>,
    pub probes: HashMap<String, Value>,
    pub retention_days: i32,
    pub retention_version: i64,
}

impl Snapshot {
    /// Safe execution metadata shared by foreground and maintenance histories.
    pub fn recording(&self) -> Value {
        json!({"project":self.project,"routes_version":self.routes["version"].as_u64().unwrap_or(0),
            "endpoints":self.endpoints.iter().map(|e|json!({"id":e.id,"name":e.name,"version":e.version,"kind":e.kind,"provider":e.provider,"adapter":e.adapter,"timeout_ms":e.timeout_ms,"max_concurrency":e.max_concurrency,"rpm":e.rpm})).collect::<Vec<_>>()})
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerNode {
    pub uid: String,
    pub name: String,
    pub address: String,
    pub slots: usize,
    #[serde(default)]
    pub boot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestStart {
    pub id: String,
    pub project: Option<String>,
    pub operation: String,
    pub origin: String,
    pub language: Option<String>,
    pub input: Value,
    pub started_at: DateTime<Utc>,
    pub retention_days: i32,
    pub retention_version: i64,
    pub snapshot: Value,
}

pub fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}
pub fn canonical_url(raw: &str) -> Option<String> {
    let mut u = url::Url::parse(raw).ok()?;
    if !matches!(u.scheme(), "http" | "https") || !u.username().is_empty() || u.password().is_some()
    {
        return None;
    }
    u.set_fragment(None);
    Some(u.to_string())
}

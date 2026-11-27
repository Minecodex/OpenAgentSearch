//! Cache identities and versioned data. No transport or persistence decisions.
use crate::{Command, Error, Hit, Project, Result};
#[path = "cache_dates.rs"]
mod dates;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
pub fn point_id(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    uuid::Uuid::from_slice(&digest[..16]).unwrap().to_string()
}

/// Unknown fragments are retained. Only a browser-confirmed document anchor
/// can be merged with its main document; SPA routes always remain distinct.
pub fn page_key(raw: &str, confirmed_anchor: bool) -> Option<String> {
    let mut url = url::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    if confirmed_anchor
        && !url
            .fragment()
            .is_some_and(|f| f.starts_with('/') || f.starts_with("!/"))
    {
        url.set_fragment(None);
    }
    Some(hash(url.as_str()))
}

/// The main HTTP document may back several distinct rendered hash routes.
pub fn resource_key(raw: &str) -> Option<String> {
    let mut url = url::Url::parse(raw).ok()?;
    url.set_fragment(None);
    page_key(url.as_str(), false)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Coverage {
    Full,
    Excerpt,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HotPolicy {
    pub total_hot_percent: u32,
    pub recent_hot_percent: u32,
    pub recent_window_hours: u32,
}
impl Default for HotPolicy {
    fn default() -> Self {
        Self {
            total_hot_percent: 10,
            recent_hot_percent: 10,
            recent_window_hours: 24,
        }
    }
}
impl HotPolicy {
    pub fn validate(&mut self) -> Result<()> {
        if self.total_hot_percent > 100
            || self.recent_hot_percent > 100
            || !(1..=2160).contains(&self.recent_window_hours)
        {
            return Err(Error::invalid("cache_policy"));
        }
        self.total_hot_percent = self.total_hot_percent.max(1);
        self.recent_hot_percent = self.recent_hot_percent.max(1);
        Ok(())
    }
    pub fn slots(&self, total: usize, positive: usize, recent: bool) -> usize {
        let percent = if recent {
            self.recent_hot_percent
        } else {
            self.total_hot_percent
        }
        .max(1) as usize;
        (total.saturating_mul(percent).div_ceil(100)).min(positive)
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyOverrides {
    pub list: Option<HotPolicy>,
    pub content: Option<HotPolicy>,
}
impl PolicyOverrides {
    pub fn validate(&mut self) -> Result<()> {
        for p in [&mut self.list, &mut self.content].into_iter().flatten() {
            p.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Binding {
    pub handler: String,
    pub namespace: String,
    pub activation: i64,
}
pub fn summary_identity(id: &str, version: i64, options: &Value, summary_tokens: usize) -> String {
    hash(&format!(
        "{id}/{version}/{options}/{}/{summary_tokens}",
        crate::model::PROMPT_VERSION
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scope {
    pub project: String,
    pub epoch: i64,
    #[serde(default)]
    pub access_epoch: i64,
    pub sources: BTreeSet<String>,
    #[serde(default)]
    pub lease: Option<String>,
    #[serde(default)]
    pub summary_version: Option<String>,
}
impl Scope {
    pub fn for_endpoint(endpoint: &crate::Endpoint) -> Self {
        Self {
            project: format!("admin:{}", endpoint.id),
            epoch: 0,
            access_epoch: endpoint.version,
            sources: [
                endpoint.id.clone(),
                crate::BROWSER_SEARCH.into(),
                crate::BROWSER_READER.into(),
            ]
            .into(),
            lease: None,
            summary_version: None,
        }
    }
    pub fn from_project(project: &Project) -> Self {
        let mut sources = project
            .search_pools
            .iter()
            .chain(&project.reader_pools)
            .flatten()
            .cloned()
            .collect::<BTreeSet<_>>();
        sources.extend([crate::BROWSER_SEARCH.into(), crate::BROWSER_READER.into()]);
        Self {
            project: project.id.clone(),
            epoch: project.cache_epoch,
            access_epoch: project.cache_access_epoch,
            sources,
            lease: None,
            summary_version: None,
        }
    }
    pub fn from_snapshot(snapshot: &crate::Snapshot, summary_tokens: usize) -> Self {
        let mut scope = Self::from_project(&snapshot.project);
        scope.summary_version = snapshot
            .project
            .model_endpoint_id
            .as_ref()
            .and_then(|id| snapshot.endpoints.iter().find(|e| &e.id == id))
            .map(|e| summary_identity(&e.id, e.version, &e.options, summary_tokens));
        scope
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Query {
    pub text: String,
    pub language: Option<String>,
    pub time_range: Option<String>,
    pub region: Option<String>,
}
impl Query {
    pub fn new(command: &Command, text: &str) -> Self {
        Self {
            text: text.trim().into(),
            language: command.language.clone(),
            time_range: command.time_range.clone(),
            region: command.region.clone(),
        }
    }
    pub fn id(&self) -> String {
        point_id(&serde_json::to_string(self).unwrap())
    }
    pub fn supported_by<'a>(
        &self,
        historical: &Self,
        material: impl IntoIterator<Item = &'a str>,
    ) -> bool {
        self.id() == historical.id()
            || dates::supports_versions(&self.text, &historical.text, material)
    }
    pub fn compatible(&self, other: &Self) -> bool {
        fn restrictions(text: &str) -> BTreeSet<String> {
            text.split_whitespace()
                .map(|t| t.trim_matches(['(', ')', '"']).to_ascii_lowercase())
                .filter(|t| {
                    ["site:", "-site:", "before:", "after:", "lang:"]
                        .iter()
                        .any(|prefix| t.starts_with(prefix))
                })
                .collect()
        }
        self.language == other.language
            && self.time_range == other.time_range
            && self.region == other.region
            && restrictions(&self.text) == restrictions(&other.text)
            && dates::constraints(&self.text) == dates::constraints(&other.text)
            && dates::compatible_versions(&self.text, &other.text)
            && dates::compatible_focus(&self.text, &other.text)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchSnapshot {
    #[serde(default)]
    pub request_id: String,
    pub id: String,
    pub question: String,
    pub query: Query,
    pub source: String,
    pub call_id: String,
    pub collected_at: i64,
    #[serde(default)]
    pub acquisition_order: i64,
    pub expires_at: i64,
    pub hits: Vec<Hit>,
    pub partial: bool,
    pub engine_answer: Option<Value>,
    #[serde(default)]
    pub cards: Vec<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedOrigin {
    pub lookup_id: String,
    pub snapshot_id: String,
    pub call_id: String,
    pub source: String,
    pub collected_at: i64,
}
impl SearchSnapshot {
    pub fn origin(&self, lookup: &str) -> CachedOrigin {
        CachedOrigin {
            lookup_id: lookup.into(),
            snapshot_id: self.id.clone(),
            call_id: self.call_id.clone(),
            source: self.source.clone(),
            collected_at: self.collected_at,
        }
    }
    pub fn admissible(&self) -> bool {
        let pages = self
            .hits
            .iter()
            .filter_map(|h| page_key(&h.url, false))
            .collect::<BTreeSet<_>>();
        pages.len() >= 5
            || self.engine_answer.as_ref().is_some_and(|a| {
                a["content"]
                    .as_str()
                    .or(a["text"].as_str())
                    .or(a["answer"].as_str())
                    .is_some_and(|s| !s.trim().is_empty())
                    && a["sources"].as_array().is_some_and(|s| {
                        s.iter()
                            .all(|v| v["url"].as_str().and_then(|u| page_key(u, false)).is_some())
                    })
            })
    }
}
/// Access decisions are scoped to the project's current access configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageAccess {
    Open,
    VerifyNotFound,
    Gone,
    Denied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageState {
    pub epoch: i64,
    pub access: PageAccess,
    pub retry_at: i64,
}
impl PageState {
    pub fn require_fetch(self, verify_gone: bool) -> Result<()> {
        match self.access {
            PageAccess::Denied => Err(Error::new(
                "ACCESS_DENIED",
                502,
                "目标网页已拒绝当前访问范围。",
                "The target page denied this access scope.",
            )),
            PageAccess::Gone if !verify_gone => Err(Self::gone_error()),
            _ => Ok(()),
        }
    }
    pub fn gone_error() -> Error {
        let mut error = Error::new(
            "CONTENT_UNAVAILABLE",
            502,
            "源站已撤下该网页。",
            "The origin has removed this page.",
        );
        error.details = Box::new(serde_json::json!({"source_gone":true}));
        error
    }
    pub fn require_network(self, verify_gone: bool) -> Result<()> {
        self.require_fetch(verify_gone)?;
        let remaining = self
            .retry_at
            .saturating_sub(chrono::Utc::now().timestamp_millis());
        if remaining > 0 {
            let mut error = Error::new(
                "ORIGIN_RETRY_LATER",
                503,
                "源站要求稍后重试。",
                "The origin requested a later retry.",
            );
            error.details = Box::new(serde_json::json!({"retry_after_ms":remaining}));
            return Err(error);
        }
        Ok(())
    }
    pub fn in_access_scope(
        epoch: i64,
        status: i32,
        recorded_access: i64,
        access: i64,
        retry_at: i64,
    ) -> Self {
        if access == recorded_access || access < 0 {
            Self {
                retry_at,
                ..Self::from_stored(epoch, status)
            }
        } else {
            Self::from_stored(epoch + 1, if status == 410 { 410 } else { 200 })
        }
    }
    pub fn from_stored(epoch: i64, status: i32) -> Self {
        let access = match status {
            -1 | 401 | 403 => PageAccess::Denied,
            404 => PageAccess::VerifyNotFound,
            410 => PageAccess::Gone,
            _ => PageAccess::Open,
        };
        Self {
            epoch,
            access,
            retry_at: 0,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OriginObservation {
    Http(u16),
    /// A provider explicitly identified the target as denying access, without an HTTP status.
    TargetDenied,
}
impl OriginObservation {
    pub fn stops_fetch(self) -> bool {
        matches!(self, Self::TargetDenied | Self::Http(401 | 403 | 410))
    }
    pub fn stored(self) -> i32 {
        match self {
            Self::Http(status) => i32::from(status),
            Self::TargetDenied => -1,
        }
    }
    pub fn from_error(error: &Error) -> Option<Self> {
        error.details["source_status"]
            .as_u64()
            .and_then(|s| u16::try_from(s).ok())
            .map(Self::Http)
            .or_else(|| {
                (error.details["target_access_denied"] == true).then_some(Self::TargetDenied)
            })
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Page {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_url: Option<String>,
    pub key: String,
    pub url: String,
    pub source: String,
    pub call_id: String,
    pub title: String,
    pub markdown: String,
    pub collected_at: i64,
    #[serde(default)]
    pub acquisition_order: i64,
    pub expires_at: i64,
    pub content_hash: String,
    pub summary: Option<String>,
    pub summary_version: Option<String>,
    pub object_epoch: i64,
    #[serde(default)]
    pub object_key: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobPlan {
    pub kind: String,
    pub target: String,
    pub reason: String,
    pub input: Value,
    pub object_epoch: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub scope: Scope,
    pub binding: Binding,
    pub payload_version: i32,
    pub plan: JobPlan,
    pub attempt: i32,
    pub created_at: i64,
    pub deadline: i64,
    pub lease: String,
}
#[derive(Debug, Clone, Default)]
pub struct Recall {
    pub dense_rank: Option<usize>,
    pub lexical_rank: Option<usize>,
    pub question: String,
    pub cosine: f32,
    pub lexical: f32,
}
#[derive(Debug, Clone, Default)]
pub struct Lookup {
    pub snapshots: Vec<SearchSnapshot>,
    pub questions: Vec<String>,
    pub exact: bool,
    pub degraded: bool,
    pub bypass: bool,
    pub search_needed: bool,
    pub vector: Option<Vec<f32>>,
    pub ranked: Vec<Hit>,
    pub verification: Option<VerificationTrace>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MatchMaterial {
    pub title: String,
    pub snippet: String,
    pub summary: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MatchCandidate {
    pub question_id: String,
    pub question: String,
    pub materials: Vec<MatchMaterial>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReuseLabel {
    Reusable,
    Insufficient,
    Conflict,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MatchScore {
    pub question_id: String,
    pub label: ReuseLabel,
    pub reusable_score: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MatchResponse {
    pub profile: String,
    // An uncalibrated language abstains from semantic reuse.
    #[serde(deserialize_with = "serde::Deserialize::deserialize")]
    pub threshold: Option<f64>,
    pub decisions: Vec<MatchScore>,
}
#[derive(Debug, Clone, Serialize)]
pub struct VerificationTrace {
    pub profile: String,
    pub state: &'static str,
    pub elapsed_ms: Option<u64>,
    pub reason: Option<String>,
    pub threshold: Option<f64>,
    pub shortlisted_question_ids: Vec<String>,
    pub question_texts: BTreeMap<String, String>,
    pub decisions: Vec<MatchScore>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Usage {
    pub event_id: String,
    pub request: String,
    pub lookup: String,
    pub project: String,
    pub kind: String,
    pub object: String,
    pub outcome: String,
    pub at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routes_and_anchors() {
        assert_ne!(
            page_key("https://e.org/#/a", true),
            page_key("https://e.org/#/b", true)
        );
        assert_eq!(
            page_key("https://e.org/#intro", true),
            page_key("https://e.org/", false)
        );
        assert_ne!(
            page_key("https://e.org/#intro", false),
            page_key("https://e.org/", false)
        );
        assert!(page_key("file:///secret", false).is_none());
    }
    #[test]
    fn full_denominator_and_positive_slots() {
        let mut p = HotPolicy {
            total_hot_percent: 0,
            recent_hot_percent: 0,
            recent_window_hours: 24,
        };
        p.validate().unwrap();
        assert_eq!(p.slots(1000, 2, true), 2);
        assert_eq!(p.slots(1000, 0, false), 0);
        assert_eq!(p.total_hot_percent, 1);
    }
    #[test]
    fn query_conditions_are_identity() {
        let a = Query::new(&Command::default(), "  rust cache ");
        let mut b = a.clone();
        b.time_range = Some("day".into());
        assert_ne!(a.id(), b.id());
        assert!(!a.compatible(&b));
        assert_eq!(a.id(), Query::new(&Command::default(), "rust cache").id());
        assert!(!a.compatible(&Query::new(
            &Command::default(),
            "rust cache site:example.org"
        )));
        assert!(
            !Query::new(&Command::default(), "rust site:example.org")
                .compatible(&Query::new(&Command::default(), "rust -site:example.org"))
        );
    }
}

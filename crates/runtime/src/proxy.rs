use super::*;
use std::sync::atomic::{AtomicI64, Ordering};

pub trait Clock: Send + Sync {
    fn millis(&self) -> i64;
}
pub struct SystemClock;
impl Clock for SystemClock {
    fn millis(&self) -> i64 {
        Utc::now().timestamp_millis()
    }
}
pub struct ManualClock(pub AtomicI64);
impl ManualClock {
    pub fn new(millis: i64) -> Self {
        Self(AtomicI64::new(millis))
    }
    pub fn advance(&self, millis: i64) {
        self.0.fetch_add(millis, Ordering::SeqCst);
    }
}
impl Clock for ManualClock {
    fn millis(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}
#[derive(Clone)]
pub struct ProxyPolicy {
    pub failures: u32,
    pub cooldown_ms: i64,
    pub maximum_ms: i64,
}
impl Default for ProxyPolicy {
    fn default() -> Self {
        Self {
            failures: 3,
            cooldown_ms: 30_000,
            maximum_ms: 1_800_000,
        }
    }
}
#[derive(Clone)]
pub(super) struct Health {
    version: i64,
    enabled: bool,
    status: String,
    failures: u32,
    backoff: u32,
    until: Option<i64>,
    reason: Option<String>,
    checked: Option<i64>,
    revision: i64,
    probing: bool,
}
fn adopt<'a>(s: &'a mut State, proxy: &Value, now: i64) -> &'a mut Health {
    let id = proxy["id"].as_str().unwrap_or("").to_owned();
    let version = proxy["version"].as_i64().unwrap_or(1);
    if s.proxy_health.get(&id).is_none_or(|h| h.version < version) {
        let mut status = proxy["health"].as_str().unwrap_or("unknown").to_owned();
        let mut until = proxy["cooldown_until"]
            .as_str()
            .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
            .map(|v| v.timestamp_millis());
        if status == "probing" {
            status = "cooling".into();
            until = Some(now);
        }
        s.proxy_health.insert(
            id.clone(),
            Health {
                version,
                enabled: proxy["enabled"] == true,
                status,
                failures: proxy["failure_count"].as_u64().unwrap_or(0) as u32,
                backoff: proxy["health_backoff"].as_u64().unwrap_or(0) as u32,
                until,
                reason: proxy["health_reason"].as_str().map(str::to_owned),
                checked: proxy["last_health_check"]
                    .as_str()
                    .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
                    .map(|v| v.timestamp_millis()),
                revision: proxy["health_revision"].as_i64().unwrap_or(0),
                probing: false,
            },
        );
    }
    s.proxy_health.get_mut(&id).unwrap()
}
fn view(h: &Health) -> Value {
    let date = |at: Option<i64>| at.and_then(chrono::DateTime::<Utc>::from_timestamp_millis);
    json!({"health":if h.enabled{h.status.as_str()}else{"disabled"},"health_reason":h.reason,"failure_count":h.failures,"health_backoff":h.backoff,"cooldown_until":date(h.until),"last_health_check":date(h.checked),"health_revision":h.revision})
}
pub(super) fn eligible(s: &mut State, proxy: &Value, now: i64) -> bool {
    let h = adopt(s, proxy, now);
    h.version == proxy["version"].as_i64().unwrap_or(1)
        && h.enabled
        && !matches!(h.status.as_str(), "cooling" | "probing" | "disabled")
}
impl Scheduler {
    pub fn with_clock(concurrency: usize, queue: usize, clock: Arc<dyn Clock>) -> Self {
        let mut s = Self::new(concurrency, queue);
        s.clock = clock;
        s
    }
    pub fn now_millis(&self) -> i64 {
        self.clock.millis()
    }
    pub fn proxy_policy(&self, policy: ProxyPolicy) {
        *self.proxy_policy.lock().unwrap() = policy;
    }
    pub fn proxy_view(&self, proxy: &Value) -> Value {
        let mut s = self.state.lock().unwrap();
        view(adopt(&mut s, proxy, self.clock.millis()))
    }
    pub fn proxy_success(&self, id: &str, version: i64) -> Option<Value> {
        let mut s = self.state.lock().unwrap();
        let h = s.proxy_health.get_mut(id)?;
        if h.version != version || !h.enabled {
            return None;
        }
        let changed = h.status != "healthy" || h.failures > 0;
        h.status = "healthy".into();
        h.failures = 0;
        h.backoff = 0;
        h.until = None;
        h.reason = None;
        h.checked = Some(self.clock.millis());
        h.probing = false;
        if changed {
            h.revision += 1;
            Some(view(h))
        } else {
            None
        }
    }
    pub fn proxy_failure(&self, id: &str, version: i64, reason: &str) -> Option<Value> {
        let policy = self.proxy_policy.lock().unwrap().clone();
        let mut s = self.state.lock().unwrap();
        let h = s.proxy_health.get_mut(id)?;
        if h.version != version || !h.enabled || h.probing {
            return None;
        }
        h.failures = h.failures.saturating_add(1);
        h.reason = Some(reason.into());
        h.revision += 1;
        if h.failures >= policy.failures {
            h.status = "cooling".into();
            h.until = Some(self.clock.millis() + policy.cooldown_ms);
            h.backoff = 0;
        } else {
            h.status = "degraded".into();
        }
        Some(view(h))
    }
    pub fn health_due(&self, proxies: &[Value]) -> Vec<(String, i64)> {
        let mut s = self.state.lock().unwrap();
        let now = self.clock.millis();
        proxies
            .iter()
            .filter_map(|proxy| {
                let h = adopt(&mut s, proxy, now);
                (h.enabled
                    && h.status == "cooling"
                    && !h.probing
                    && h.until.is_some_and(|t| t <= now))
                .then(|| (proxy["id"].as_str().unwrap().into(), h.version))
            })
            .collect()
    }
    pub fn begin_health_probe(&self, id: &str, version: i64) -> Option<Value> {
        let mut s = self.state.lock().unwrap();
        let h = s.proxy_health.get_mut(id)?;
        if h.version != version
            || !h.enabled
            || h.probing
            || h.status != "cooling"
            || h.until.is_some_and(|t| t > self.clock.millis())
        {
            return None;
        }
        h.probing = true;
        h.status = "probing".into();
        h.revision += 1;
        Some(view(h))
    }
    pub fn finish_health_probe(
        &self,
        id: &str,
        version: i64,
        revision: i64,
        healthy: bool,
    ) -> Option<Value> {
        let policy = self.proxy_policy.lock().unwrap().clone();
        let mut s = self.state.lock().unwrap();
        let h = s.proxy_health.get_mut(id)?;
        if h.version != version || !h.enabled || !h.probing || h.revision != revision {
            return None;
        }
        h.probing = false;
        h.checked = Some(self.clock.millis());
        h.revision += 1;
        if healthy {
            h.status = "healthy".into();
            h.failures = 0;
            h.backoff = 0;
            h.until = None;
            h.reason = None;
        } else {
            h.status = "cooling".into();
            h.backoff = h.backoff.saturating_add(1);
            let multiplier = 1i64.checked_shl(h.backoff.min(20)).unwrap_or(i64::MAX);
            h.until = Some(
                self.clock.millis()
                    + policy
                        .cooldown_ms
                        .saturating_mul(multiplier)
                        .min(policy.maximum_ms),
            );
            h.reason = Some("health_probe_failed".into());
        }
        Some(view(h))
    }
    pub fn abort_health_probe(&self, id: &str, version: i64, revision: i64) {
        let mut s = self.state.lock().unwrap();
        if let Some(h) = s.proxy_health.get_mut(id)
            && h.version == version
            && h.probing
            && h.revision == revision
        {
            h.probing = false;
            h.status = "cooling".into();
            h.until = Some(self.clock.millis() + 5_000);
        }
    }
}

#[cfg(test)]
#[path = "../../../tests/rust_proof.rs"]
mod proof;
use chrono::Utc;
use oas_domain::{Endpoint, Error, Project, Result, Snapshot, WorkerNode};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;
mod fair;
mod probes;
mod proxy;
pub use probes::{ProbePlanner, ProbeTicket};
pub use proxy::{Clock, ManualClock, ProxyPolicy, SystemClock};
#[cfg(test)]
mod tests;

#[derive(Clone, Copy)]
pub struct Selection<'a> {
    pub kind: &'a str,
    pub language: &'a str,
    pub range: Option<&'a str>,
    pub query: &'a str,
    pub tried: &'a HashSet<String>,
    pub minimum: usize,
}
#[derive(Default)]
struct State {
    proxy_health: HashMap<String, proxy::Health>,
    model_queues: HashMap<String, fair::Queue>,
    active: HashMap<String, usize>,
    sent: HashMap<String, VecDeque<i64>>,
    cursors: HashMap<String, String>,
    reserved: HashMap<String, usize>,
    rotations: HashMap<String, VecDeque<(u64, String, bool)>>,
    sequence: u64,
    recovering: HashMap<String, usize>,
    logins: VecDeque<Instant>,
    risk: HashMap<String, i64>,
    workers: Vec<WorkerNode>,
    requests: HashMap<String, (Option<String>, CancellationToken)>,
}
#[derive(Clone)]
pub struct Scheduler {
    state: Arc<Mutex<State>>,
    requests: Arc<Semaphore>,
    waiting: Arc<Semaphore>,
    quarantined: Arc<Mutex<Vec<Quarantined>>>,
    stop: CancellationToken,
    clock: Arc<dyn Clock>,
    proxy_policy: Arc<Mutex<ProxyPolicy>>,
}
pub struct Quarantined {
    pub node: WorkerNode,
    pub job_id: String,
    pub owner: Option<String>,
    _lease: Lease,
}
impl Default for Scheduler {
    fn default() -> Self {
        Self::new(24, 48)
    }
}
impl Scheduler {
    pub fn new(concurrency: usize, queue: usize) -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
            requests: Arc::new(Semaphore::new(concurrency)),
            waiting: Arc::new(Semaphore::new(queue)),
            quarantined: Arc::new(Mutex::new(Vec::new())),
            stop: CancellationToken::new(),
            clock: Arc::new(SystemClock),
            proxy_policy: Arc::new(Mutex::new(ProxyPolicy::default())),
        }
    }
    pub fn login_attempt(&self) -> Result<()> {
        let mut s = self.state.lock().unwrap();
        while s
            .logins
            .front()
            .is_some_and(|t| t.elapsed() >= Duration::from_secs(60))
        {
            s.logins.pop_front();
        }
        if s.logins.len() >= 20 {
            return Err(Error::new(
                "RATE_LIMITED",
                429,
                "登录尝试过于频繁。",
                "Too many login attempts.",
            ));
        }
        s.logins.push_back(Instant::now());
        Ok(())
    }
    pub fn shutdown(&self) {
        self.stop.cancel();
        self.cancel_all();
    }
    pub fn is_stopping(&self) -> bool {
        self.stop.is_cancelled()
    }
    pub async fn stopped(&self) {
        self.stop.cancelled().await;
    }
    pub fn quarantine(&self, node: WorkerNode, job_id: String, lease: Lease) {
        self.quarantined.lock().unwrap().push(Quarantined {
            node,
            job_id,
            owner: None,
            _lease: lease,
        });
    }
    pub fn recover_job(
        &self,
        node: WorkerNode,
        job_id: String,
        owner: String,
        proxy: Option<&str>,
    ) {
        let mut s = self.state.lock().unwrap();
        let mut keys = vec![format!("worker:{}", node.uid)];
        if let Some(proxy) = proxy {
            keys.push(format!("proxy:{proxy}"));
        }
        for key in &keys {
            take(&mut s, key);
        }
        *s.recovering.entry(node.uid.clone()).or_default() += 1;
        let lease = Lease {
            clock: self.clock.clone(),
            state: self.state.clone(),
            keys,
            rate: None,
            rotation: None,
            recovery_node: Some(node.uid.clone()),
        };
        drop(s);
        self.quarantined.lock().unwrap().push(Quarantined {
            node,
            job_id,
            owner: Some(owner),
            _lease: lease,
        });
    }
    pub fn pending_cleanup(&self) -> Vec<Quarantined> {
        std::mem::take(&mut *self.quarantined.lock().unwrap())
    }
    pub fn keep_pending(&self, item: Quarantined) {
        self.quarantined.lock().unwrap().push(item);
    }
    pub async fn admission(&self, cancel: &CancellationToken) -> Result<OwnedSemaphorePermit> {
        if cancel.is_cancelled() {
            return Err(Error::cancelled());
        }
        if let Ok(p) = self.requests.clone().try_acquire_owned() {
            return Ok(p);
        }
        let _waiting = self
            .waiting
            .clone()
            .try_acquire_owned()
            .map_err(|_| capacity())?;
        tokio::select! {
            _=cancel.cancelled()=>Err(Error::cancelled()),
            p=tokio::time::timeout(Duration::from_secs(3),self.requests.clone().acquire_owned())=>p.map_err(|_|capacity())?.map_err(|_|Error::unavailable())
        }
    }
    pub fn register(&self, id: &str, project: Option<String>, token: CancellationToken) -> bool {
        let mut s = self.state.lock().unwrap();
        if s.requests.contains_key(id) {
            return false;
        }
        s.requests.insert(id.into(), (project, token));
        true
    }
    pub fn unregister(&self, id: &str) {
        self.state.lock().unwrap().requests.remove(id);
    }
    pub fn active_requests(&self) -> usize {
        self.state.lock().unwrap().requests.len()
    }
    pub fn diagnostics(&self) -> Value {
        let state = self.state.lock().unwrap();
        json!({"stopping":self.is_stopping(),"active_requests":state.requests.len(),"ready_workers":state.workers.len(),"recovering_workers":state.recovering.len(),"active_leases":state.active,"reserved_rpm":state.reserved})
    }
    pub fn cancel(&self, id: &str) -> bool {
        self.state
            .lock()
            .unwrap()
            .requests
            .get(id)
            .is_some_and(|(_, t)| {
                t.cancel();
                true
            })
    }
    pub fn cancel_all(&self) {
        for (_, token) in self.state.lock().unwrap().requests.values() {
            token.cancel();
        }
    }
    pub fn set_workers(&self, nodes: Vec<WorkerNode>) {
        self.state.lock().unwrap().workers = nodes;
    }
    pub fn workers(&self) -> Vec<WorkerNode> {
        let s = self.state.lock().unwrap();
        s.workers
            .iter()
            .filter(|node| !s.recovering.contains_key(&node.uid))
            .cloned()
            .collect()
    }
    pub fn active(&self, id: &str) -> usize {
        *self.state.lock().unwrap().active.get(id).unwrap_or(&0)
    }
    pub fn risk(&self, id: &str, until: i64) {
        self.state
            .lock()
            .unwrap()
            .risk
            .entry(id.into())
            .and_modify(|u| *u = (*u).max(until))
            .or_insert(until);
    }
    pub fn mark_risk(&self, e: &Endpoint) -> Option<i64> {
        if e.browser() {
            return None;
        }
        let until = self.clock.millis() + 1_800_000;
        self.risk(&e.id, until);
        Some(until)
    }
    pub fn preferred_pool(
        project: &Project,
        routes: &Value,
        kind: &str,
        language: &str,
    ) -> Option<usize> {
        if kind != "search" || language.is_empty() {
            return None;
        }
        let entries = routes["entries"].as_array()?;
        let mut tag = language;
        loop {
            if let Some(members) = entries
                .iter()
                .find(|entry| {
                    entry["language"]
                        .as_str()
                        .is_some_and(|code| code.eq_ignore_ascii_case(tag))
                })
                .and_then(|entry| entry["endpoint_ids"].as_array())
                && let Some(index) = project.search_pools.iter().position(|pool| {
                    pool.iter()
                        .any(|id| members.iter().any(|m| m.as_str() == Some(id)))
                })
            {
                return Some(index);
            }
            tag = tag.rsplit_once('-')?.0;
        }
    }
    pub fn starting_pool(project: &Project, routes: &Value, kind: &str, language: &str) -> usize {
        Self::preferred_pool(project, routes, kind, language).unwrap_or(0)
    }
    pub fn choose(
        &self,
        snapshot: &Snapshot,
        selection: Selection<'_>,
    ) -> Option<(Endpoint, usize, Lease)> {
        let Selection {
            kind,
            language,
            range,
            query,
            tried,
            minimum,
        } = selection;
        let p = &snapshot.project;
        let pools = if kind == "search" {
            &p.search_pools
        } else {
            &p.reader_pools
        };
        let first = Self::starting_pool(p, &snapshot.routes, kind, language);
        let mut s = self.state.lock().unwrap();
        for (idx, members) in pools.iter().enumerate().skip(first.max(minimum)) {
            let key = format!("{}/{}/{}", p.id, kind, idx);
            let last = s
                .rotations
                .get(&key)
                .and_then(|entries| entries.back())
                .and_then(|(_, last, _)| members.iter().position(|id| id == last))
                .map_or(0, |i| i + 1);
            for n in 0..members.len() {
                let id = &members[(last + n) % members.len()];
                let Some(e) = snapshot
                    .endpoints
                    .iter()
                    .find(|e| &e.id == id && e.kind == kind)
                else {
                    continue;
                };
                if tried.contains(id) || e.availability != "available" || !e.supports(range, query)
                {
                    continue;
                }
                if s.risk.get(id).is_some_and(|u| *u > self.clock.millis()) {
                    continue;
                }
                if !has_room(&mut s, id, e.max_concurrency, e.rpm, self.clock.millis()) {
                    continue;
                }
                take(&mut s, id);
                *s.reserved.entry(id.clone()).or_default() += 1;
                s.sequence += 1;
                let token = s.sequence;
                s.rotations
                    .entry(key.clone())
                    .or_default()
                    .push_back((token, id.clone(), false));
                return Some((
                    e.clone(),
                    idx,
                    Lease {
                        clock: self.clock.clone(),
                        state: self.state.clone(),
                        keys: vec![id.clone()],
                        rate: Some(id.clone()),
                        rotation: Some((key.clone(), token)),
                        recovery_node: None,
                    },
                ));
            }
        }
        None
    }
    pub fn endpoint(&self, e: &Endpoint) -> Result<Lease> {
        let mut s = self.state.lock().unwrap();
        self.endpoint_locked(&mut s, e)
    }
    fn endpoint_locked(&self, s: &mut State, e: &Endpoint) -> Result<Lease> {
        if !has_room(s, &e.id, e.max_concurrency, e.rpm, self.clock.millis()) {
            return Err(capacity());
        }
        take(s, &e.id);
        *s.reserved.entry(e.id.clone()).or_default() += 1;
        Ok(Lease {
            clock: self.clock.clone(),
            state: self.state.clone(),
            keys: vec![e.id.clone()],
            rate: Some(e.id.clone()),
            rotation: None,
            recovery_node: None,
        })
    }
    pub async fn endpoint_wait(&self, e: &Endpoint, cancel: &CancellationToken) -> Result<Lease> {
        wait_resource(cancel, || self.endpoint(e)).await
    }
    pub async fn browser_wait(
        &self,
        snapshot: &Snapshot,
        search: bool,
        cancel: &CancellationToken,
    ) -> Result<(WorkerNode, Option<Value>, Option<Value>, Lease)> {
        wait_resource(cancel, || self.browser(snapshot, search)).await
    }
    pub async fn browser_wait_excluding(
        &self,
        snapshot: &Snapshot,
        search: bool,
        cancel: &CancellationToken,
        excluded: &HashSet<String>,
    ) -> Result<(WorkerNode, Option<Value>, Option<Value>, Lease)> {
        wait_resource(cancel, || {
            self.browser_excluding(snapshot, search, excluded)
        })
        .await
    }
    pub fn eligible(&self, snapshot: &Snapshot, selection: Selection<'_>) -> bool {
        let Selection {
            kind,
            language,
            range,
            query,
            tried,
            minimum,
        } = selection;
        let s = self.state.lock().unwrap();
        let p = &snapshot.project;
        let pools = if kind == "search" {
            &p.search_pools
        } else {
            &p.reader_pools
        };
        pools
            .iter()
            .skip(Self::starting_pool(p, &snapshot.routes, kind, language).max(minimum))
            .flatten()
            .any(|id| {
                !tried.contains(id)
                    && !s.risk.get(id).is_some_and(|t| *t > self.clock.millis())
                    && snapshot.endpoints.iter().any(|e| {
                        &e.id == id
                            && e.kind == kind
                            && e.availability == "available"
                            && e.supports(range, query)
                    })
            })
    }
    pub fn browser(
        &self,
        snapshot: &Snapshot,
        search: bool,
    ) -> Result<(WorkerNode, Option<Value>, Option<Value>, Lease)> {
        self.browser_excluding(snapshot, search, &HashSet::new())
    }
    pub fn browser_excluding(
        &self,
        snapshot: &Snapshot,
        search: bool,
        excluded: &HashSet<String>,
    ) -> Result<(WorkerNode, Option<Value>, Option<Value>, Lease)> {
        let mut s = self.state.lock().unwrap();
        let mut nodes = s
            .workers
            .iter()
            .filter(|node| !s.recovering.contains_key(&node.uid))
            .cloned()
            .collect::<Vec<_>>();
        if nodes.is_empty() {
            return Err(Error::unavailable());
        }
        if let Some(last) = s.cursors.get("workers")
            && let Some(i) = nodes.iter().position(|n| &n.uid == last)
        {
            let len = nodes.len();
            nodes.rotate_left((i + 1) % len);
        }
        nodes.sort_by_key(|w| {
            s.active
                .get(&format!("worker:{}", w.uid))
                .copied()
                .unwrap_or(0)
        });
        let node = nodes
            .into_iter()
            .find(|w| {
                s.active
                    .get(&format!("worker:{}", w.uid))
                    .copied()
                    .unwrap_or(0)
                    < w.slots
            })
            .ok_or_else(capacity)?;
        let mut keys = vec![format!("worker:{}", node.uid)];
        let (proxy, probe) = if let Some(pool) = &snapshot.project.browser_proxy_pool_id {
            let members = snapshot
                .pools
                .iter()
                .find(|p| p["id"] == *pool)
                .and_then(|p| p["members"].as_array())
                .ok_or_else(proxy_error)?;
            let mut candidates = Vec::new();
            let mut eligible = false;
            let mut members = members.iter().collect::<Vec<_>>();
            let cursor = format!("proxy-pool:{pool}");
            if let Some(last) = s.cursors.get(&cursor)
                && let Some(i) = members
                    .iter()
                    .position(|m| m["proxy_id"].as_str() == Some(last))
            {
                let len = members.len();
                members.rotate_left((i + 1) % len);
            }
            for member in members {
                let id = member["proxy_id"].as_str().unwrap_or("");
                if excluded.contains(id) {
                    continue;
                }
                let Some(proxy) = snapshot
                    .proxies
                    .iter()
                    .find(|p| p["id"] == id && p["enabled"] == true)
                else {
                    continue;
                };
                if !proxy::eligible(&mut s, proxy, self.clock.millis()) {
                    continue;
                }
                let probe = snapshot.probes.get(id);
                if search && !probe.is_some_and(|p| p["reachable"].is_boolean()) {
                    continue;
                }
                eligible = true;
                let limit = proxy["max_concurrency"].as_u64().unwrap_or(1) as usize;
                let active = s.active.get(&format!("proxy:{id}")).copied().unwrap_or(0);
                if active >= limit {
                    continue;
                }
                candidates.push((
                    (active + 1) as f64
                        / (limit as f64 * member["weight"].as_u64().unwrap_or(1) as f64),
                    proxy,
                    probe,
                ));
            }
            candidates.sort_by(|a, b| a.0.total_cmp(&b.0));
            let (_, proxy, probe) = candidates
                .first()
                .ok_or_else(|| if eligible { capacity() } else { proxy_error() })?;
            keys.push(format!("proxy:{}", proxy["id"].as_str().unwrap()));
            s.cursors
                .insert(cursor, proxy["id"].as_str().unwrap().to_owned());
            (Some((*proxy).clone()), probe.cloned())
        } else {
            let direct = snapshot.probes.get("default_network");
            let mut exits = Vec::new();
            if !search || direct.is_some_and(|p| p["reachable"].is_boolean()) {
                exits.push((None, direct));
            }
            let mut busy = false;
            for proxy in &snapshot.proxies {
                let Some(id) = proxy["id"].as_str() else {
                    continue;
                };
                let probe = snapshot.probes.get(id);
                if excluded.contains(id)
                    || proxy["enabled"] != true
                    || !proxy::eligible(&mut s, proxy, self.clock.millis())
                    || (search && !probe.is_some_and(|p| p["reachable"].is_boolean()))
                {
                    continue;
                }
                if s.active.get(&format!("proxy:{id}")).copied().unwrap_or(0)
                    >= proxy["max_concurrency"].as_u64().unwrap_or(1) as usize
                {
                    busy = true;
                    continue;
                }
                exits.push((Some(proxy), probe));
            }
            if exits.is_empty() {
                return Err(if busy {
                    capacity()
                } else {
                    Error::unavailable()
                });
            }
            let (proxy, probe) =
                exits[(uuid::Uuid::new_v4().as_u128() % exits.len() as u128) as usize];
            if let Some(p) = proxy {
                keys.push(format!("proxy:{}", p["id"].as_str().unwrap()));
            }
            (proxy.cloned(), probe.cloned())
        };
        for key in &keys {
            take(&mut s, key);
        }
        s.cursors.insert("workers".into(), node.uid.clone());
        Ok((
            node,
            proxy,
            probe,
            Lease {
                clock: self.clock.clone(),
                state: self.state.clone(),
                keys,
                rate: None,
                rotation: None,
                recovery_node: None,
            },
        ))
    }
}
async fn wait_resource<T>(
    cancel: &CancellationToken,
    mut reserve: impl FnMut() -> Result<T>,
) -> Result<T> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        if cancel.is_cancelled() {
            return Err(Error::cancelled());
        }
        match reserve() {
            Ok(value) => return Ok(value),
            Err(error) if error.code == "CAPACITY_EXHAUSTED" => {
                if tokio::time::Instant::now() >= deadline {
                    return Err(error);
                }
            }
            Err(error) => return Err(error),
        }
        tokio::select! {_=cancel.cancelled()=>return Err(Error::cancelled()),_=tokio::time::sleep(Duration::from_millis(20))=>{}}
    }
}
fn has_room(s: &mut State, id: &str, limit: usize, rpm: usize, now: i64) -> bool {
    if s.active.get(id).copied().unwrap_or(0) >= limit {
        return false;
    }
    let times = s.sent.entry(id.into()).or_default();
    while times
        .front()
        .is_some_and(|t| now.saturating_sub(*t) >= 60_000)
    {
        times.pop_front();
    }
    times.len() + s.reserved.get(id).copied().unwrap_or(0) < rpm
}
fn take(s: &mut State, id: &str) {
    *s.active.entry(id.into()).or_default() += 1;
}
pub struct Lease {
    clock: Arc<dyn Clock>,
    state: Arc<Mutex<State>>,
    keys: Vec<String>,
    rate: Option<String>,
    rotation: Option<(String, u64)>,
    recovery_node: Option<String>,
}
impl Lease {
    /// Commit only immediately before sending. Unsent reservations are refunded.
    pub fn commit(&mut self) {
        let mut s = self.state.lock().unwrap();
        if let Some(id) = self.rate.take() {
            if let Some(n) = s.reserved.get_mut(&id) {
                *n = n.saturating_sub(1);
            }
            s.sent.entry(id).or_default().push_back(self.clock.millis());
        }
        if let Some((key, token)) = self.rotation.take()
            && let Some(entries) = s.rotations.get_mut(&key)
        {
            if let Some(entry) = entries.iter_mut().find(|e| e.0 == token) {
                entry.2 = true;
            }
            compact_rotation(entries);
        }
    }
}
fn compact_rotation(entries: &mut VecDeque<(u64, String, bool)>) {
    if let Some(last) = entries.iter().rposition(|e| e.2) {
        entries.drain(..last);
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut s = self.state.lock().unwrap();
        if let Some(id) = self.rate.take()
            && let Some(n) = s.reserved.get_mut(&id)
        {
            *n = n.saturating_sub(1);
        }
        if let Some((key, token)) = self.rotation.take()
            && let Some(entries) = s.rotations.get_mut(&key)
        {
            entries.retain(|e| e.0 != token);
            compact_rotation(entries);
        }
        if let Some(node) = self.recovery_node.take()
            && let Some(count) = s.recovering.get_mut(&node)
        {
            *count = count.saturating_sub(1);
            if *count == 0 {
                s.recovering.remove(&node);
            }
        }
        for key in &self.keys {
            if let Some(n) = s.active.get_mut(key) {
                *n = n.saturating_sub(1)
            }
        }
    }
}
pub fn capacity() -> Error {
    Error::new(
        "CAPACITY_EXHAUSTED",
        429,
        "资源名额已满。",
        "Resource capacity is exhausted.",
    )
}
pub fn proxy_error() -> Error {
    Error::new(
        "PROXY_UNAVAILABLE",
        503,
        "绑定的代理池没有可用出口。",
        "The bound proxy pool has no available egress.",
    )
}

pub fn route_reason(pool: usize, preferred: Option<usize>) -> &'static str {
    if pool > preferred.unwrap_or(0) {
        "fallback"
    } else if preferred.is_some() {
        "language"
    } else {
        "primary"
    }
}

pub fn probe_snapshot(value: Option<&Value>) -> Value {
    value
        .cloned()
        .unwrap_or(json!({"reachable":null,"checked_at":null}))
}
pub async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install termination handler");
        tokio::select! {_=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{}}
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

use crate::{App, Session, authorized, search, start_session};
use anyhow::Result;
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, OwnedMutexGuard, RwLock};
use tokio::time::Instant;

const REFRESH: Duration = Duration::from_secs(600);
const RETRY: Duration = Duration::from_secs(15);

#[derive(Clone, Deserialize, Serialize)]
pub struct Route {
    proxy: Option<Value>,
    engine: String,
}

pub struct Slot {
    pub session: Option<Session>,
    proxy: Option<Value>,
    pub engine: Option<String>,
    pub dirty: bool,
    generation: usize,
    planned_engine: Option<String>,
    pub google_failure: Option<String>,
    next_refresh: Instant,
    warm: bool,
    count: Arc<AtomicUsize>,
}
impl Slot {
    fn matches(&self, proxy: Option<&Value>) -> bool {
        match (self.proxy.as_ref(), proxy) {
            (None, None) => true,
            (Some(a), Some(b)) => a["id"] == b["id"] && a["version"] == b["version"],
            _ => false,
        }
    }
    fn set_warm(&mut self, warm: bool) {
        if self.warm != warm {
            if warm {
                self.count.fetch_add(1, Ordering::Relaxed);
            } else {
                self.count.fetch_sub(1, Ordering::Relaxed);
            }
            self.warm = warm;
        }
    }
    pub fn searched(&mut self, engine: &str) {
        if !self.warm {
            self.next_refresh = Instant::now() + REFRESH;
        }
        self.set_warm(true);
        self.engine = Some(engine.into());
    }
    pub fn discard(&mut self) {
        self.set_warm(false);
        self.session = None;
        self.engine = None;
        self.google_failure = None;
        self.dirty = false;
        self.next_refresh = Instant::now();
    }
    async fn establish(&mut self, app: &App, proxy: Option<&Value>) -> Result<()> {
        if self.dirty || !self.matches(proxy) {
            self.discard();
        }
        if self.session.is_none() {
            self.proxy = proxy.cloned();
            self.session = Some(start_session(app, self.proxy.clone()).await?);
        }
        Ok(())
    }
}
pub struct Pages {
    slots: Vec<Arc<Mutex<Slot>>>,
    routes: RwLock<(usize, Vec<Route>)>,
    warm: Arc<AtomicUsize>,
    refreshed: AtomicUsize,
    cursor: AtomicUsize,
}
impl Pages {
    pub fn new(n: usize) -> Self {
        let warm = Arc::new(AtomicUsize::new(0));
        let slots = (0..n)
            .map(|_| {
                Arc::new(Mutex::new(Slot {
                    session: None,
                    proxy: None,
                    engine: None,
                    planned_engine: None,
                    google_failure: None,
                    dirty: false,
                    generation: 0,
                    next_refresh: Instant::now(),
                    warm: false,
                    count: warm.clone(),
                }))
            })
            .collect();
        Self {
            slots,
            routes: Default::default(),
            warm,
            refreshed: Default::default(),
            cursor: Default::default(),
        }
    }
    pub fn warm_count(&self) -> usize {
        self.warm.load(Ordering::Relaxed)
    }
    pub fn refresh_count(&self) -> usize {
        self.refreshed.load(Ordering::Relaxed)
    }
    pub async fn acquire(
        &self,
        app: &App,
        proxy: Option<&Value>,
        engine: Option<&str>,
    ) -> Result<OwnedMutexGuard<Slot>> {
        let start = self.cursor.fetch_add(1, Ordering::Relaxed);
        loop {
            let mut best = None;
            let mut best_rank = 10;
            for i in 0..self.slots.len() {
                let Ok(slot) = self.slots[start.wrapping_add(i) % self.slots.len()]
                    .clone()
                    .try_lock_owned()
                else {
                    continue;
                };
                let rank = if slot.matches(proxy) && slot.session.is_some() {
                    usize::from(engine.is_some() && engine != slot.engine.as_deref())
                } else if slot.session.is_none() {
                    2
                } else {
                    3
                };
                if rank < best_rank {
                    best = Some(slot);
                    best_rank = rank;
                }
                if rank == 0 {
                    break;
                }
            }
            if let Some(mut slot) = best {
                slot.establish(app, proxy).await?;
                slot.generation = self.routes.read().await.0;
                return Ok(slot);
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }
}
pub async fn configure(
    State(app): State<App>,
    headers: HeaderMap,
    Json(routes): Json<Vec<Route>>,
) -> std::result::Result<Json<Value>, StatusCode> {
    if !authorized(&headers, &app.key) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    if routes
        .iter()
        .any(|r| !matches!(r.engine.as_str(), "google" | "baidu"))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut config = app.pages.routes.write().await;
    let same = config.1.len() == routes.len()
        && config.1.iter().zip(&routes).all(|(a, b)| {
            a.engine == b.engine
                && a.proxy.as_ref().map(|p| (&p["id"], &p["version"]))
                    == b.proxy.as_ref().map(|p| (&p["id"], &p["version"]))
        });
    if !same {
        config.0 = config.0.wrapping_add(1);
        config.1 = routes;
    }

    Ok(Json(json!({"configured":true})))
}
pub async fn maintain(app: App) {
    let mut tasks = tokio::task::JoinSet::new();
    let preparing = Arc::new(tokio::sync::Semaphore::new(2));
    for i in 0..app.pages.slots.len() {
        let app = app.clone();
        let preparing = preparing.clone();
        tasks.spawn(async move {
            tokio::time::sleep(Duration::from_millis(i as u64 * 170)).await;
            let mut tick = tokio::time::interval(Duration::from_millis(500));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                let (generation, routes) = app.pages.routes.read().await.clone();
                let Ok(mut slot) = app.pages.slots[i].try_lock() else {
                    continue;
                };
                if routes.is_empty() {
                    if slot.proxy.is_some() {
                        slot.discard();
                        slot.proxy = None;
                    }
                    continue;
                }
                // Preserve healthy pages between leases. Redistribute idle slots when the
                // configured exits change, or rebind on demand if all matching slots are busy.
                let desired = &routes[i % routes.len()];
                let route = if slot.generation == generation && slot.session.is_some() {
                    routes
                        .iter()
                        .find(|r| slot.matches(r.proxy.as_ref()))
                        .unwrap_or(desired)
                } else {
                    desired
                };
                slot.generation = generation;
                if slot.matches(route.proxy.as_ref())
                    && slot.planned_engine.as_deref() == Some(&route.engine)
                    && Instant::now() < slot.next_refresh
                {
                    continue;
                }
                let Ok(_prepare) = preparing.try_acquire() else {
                    continue;
                };
                if slot.dirty {
                    slot.discard();
                }
                let was_warm = slot.warm;
                let prepare = async {
                    slot.establish(&app, route.proxy.as_ref()).await?;
                    let session = slot.session.as_ref().unwrap();
                    let opened = search::home(&app, session, &route.engine).await;
                    if let Err(ref e) = opened
                        && route.engine == "google"
                        && e.to_string() != "policy"
                    {
                        let reason = if e.to_string() == "ENDPOINT_RISK_CONTROL" {
                            "ENDPOINT_RISK_CONTROL"
                        } else {
                            "SEARCH_ENGINE_UNAVAILABLE"
                        };
                        search::home(&app, session, "baidu").await?;
                        return Ok::<_, anyhow::Error>((
                            "baidu".to_owned(),
                            Some(reason.to_owned()),
                        ));
                    } else {
                        opened?;
                    }
                    Ok((route.engine.clone(), None))
                };
                match tokio::time::timeout(Duration::from_secs(20), prepare).await {
                    Ok(Ok((engine, failure))) => {
                        slot.set_warm(true);
                        slot.engine = Some(engine);
                        slot.google_failure = failure;
                        if was_warm {
                            app.pages.refreshed.fetch_add(1, Ordering::Relaxed);
                        }
                        slot.next_refresh = Instant::now() + REFRESH;
                    }
                    _ => {
                        slot.discard();
                        slot.next_refresh = Instant::now() + RETRY;
                    }
                }
                slot.planned_engine = Some(route.engine.clone());
            }
        });
    }
    while tasks.join_next().await.is_some() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn search_use_preserves_the_ten_minute_home_refresh_deadline() {
        let pages = Pages::new(1);
        let mut slot = pages.slots[0].lock().await;
        let start = Instant::now();
        slot.searched("google");
        assert_eq!(slot.next_refresh, start + Duration::from_secs(600));
        tokio::time::advance(Duration::from_secs(599)).await;
        slot.searched("google");
        assert!(Instant::now() < slot.next_refresh);
        assert!(pages.slots[0].try_lock().is_err());
        drop(slot);
        tokio::time::advance(Duration::from_secs(1)).await;
        assert_eq!(
            pages.slots[0].try_lock().unwrap().next_refresh,
            Instant::now()
        );
    }
}

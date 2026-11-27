use super::*;

pub struct BrowserWaiting {
    state: Arc<Mutex<State>>,
}
impl Drop for BrowserWaiting {
    fn drop(&mut self) {
        let mut s = self.state.lock().unwrap();
        s.foreground_browser_waiters = s.foreground_browser_waiters.saturating_sub(1);
    }
}
impl Scheduler {
    pub fn register_background(
        &self,
        id: &str,
        project: Option<String>,
        cancel: CancellationToken,
    ) -> bool {
        if !self.register(id, project, cancel) {
            return false;
        }
        self.state
            .lock()
            .unwrap()
            .background_requests
            .insert(id.into());
        true
    }
    pub fn cancel_cache_project(&self, project: &str) {
        let s = self.state.lock().unwrap();
        for id in &s.background_requests {
            if let Some((Some(scope), token)) = s.requests.get(id)
                && scope == project
            {
                token.cancel();
            }
        }
    }
    pub fn browser_waiter(&self, background: bool) -> Option<BrowserWaiting> {
        if background {
            return None;
        }
        self.state.lock().unwrap().foreground_browser_waiters += 1;
        Some(BrowserWaiting {
            state: self.state.clone(),
        })
    }
    pub fn configure_cache(&self, browser: usize, model: usize, rpm: usize) {
        let mut s = self.state.lock().unwrap();
        s.cache_limit = browser.max(1);
        s.cache_model_limit = model.max(1);
        s.cache_model_rpm = rpm.max(1);
    }
    pub fn cache_capacity(&self) -> Value {
        let s = self.state.lock().unwrap();
        let ready = s
            .workers
            .iter()
            .filter(|w| !s.recovering.contains_key(&w.uid))
            .map(|w| w.slots)
            .sum::<usize>();
        let configured = s.cache_limit.max(1);
        let effective = configured.min(ready.saturating_sub(1));
        let background = s.active.get("cache:browser").copied().unwrap_or(0);
        let total = s
            .workers
            .iter()
            .map(|w| {
                s.active
                    .get(&format!("worker:{}", w.uid))
                    .copied()
                    .unwrap_or(0)
            })
            .sum::<usize>();
        json!({"configured_limit":configured,"effective_limit":effective,"ready_tabs":ready,"background_active":background,"foreground_active":total.saturating_sub(background),
            "foreground_waiting":s.foreground_browser_waiters,"capacity_insufficient":ready<2,"model_concurrency":s.cache_model_limit.max(1),"model_rpm":s.cache_model_rpm.max(1)})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn node(slots: usize) -> WorkerNode {
        WorkerNode {
            uid: "cache-test".into(),
            name: "Cache worker".into(),
            address: "http://unused".into(),
            slots,
            boot_id: "b".into(),
        }
    }
    fn snapshot() -> Snapshot {
        Snapshot {
            project: serde_json::from_value(
                json!({"id":"p","name":"p","search_pools":[],"reader_pools":[]}),
            )
            .unwrap(),
            endpoints: vec![],
            proxies: vec![],
            pools: vec![],
            routes: json!({}),
            secrets: HashMap::new(),
            probes: HashMap::new(),
            retention_days: 7,
            retention_version: 1,
        }
    }
    #[test]
    fn background_preserves_a_foreground_slot_and_keeps_saved_limit_when_capacity_shrinks() {
        let scheduler = Scheduler::default();
        scheduler.set_workers(vec![node(3)]);
        scheduler.configure_cache(2, 1, 10);
        let snap = snapshot();
        let excluded = HashSet::new();
        let a = scheduler
            .browser_excluding_class(&snap, false, &excluded, true)
            .unwrap();
        let b = scheduler
            .browser_excluding_class(&snap, false, &excluded, true)
            .unwrap();
        assert!(
            scheduler
                .browser_excluding_class(&snap, false, &excluded, true)
                .is_err()
        );
        let foreground = scheduler
            .browser_excluding_class(&snap, false, &excluded, false)
            .unwrap();
        assert_eq!(scheduler.cache_capacity()["background_active"], 2);
        drop((a, b, foreground));
        scheduler.set_workers(vec![node(1)]);
        assert_eq!(scheduler.cache_capacity()["configured_limit"], 2);
        assert_eq!(scheduler.cache_capacity()["effective_limit"], 0);
        assert!(
            scheduler
                .browser_excluding_class(&snap, false, &excluded, true)
                .is_err()
        );
        assert!(
            scheduler
                .browser_excluding_class(&snap, false, &excluded, false)
                .is_ok()
        );
    }
    #[test]
    fn foreground_waiter_blocks_new_background_and_project_toggle_cancels_only_cache_requests() {
        let scheduler = Scheduler::default();
        scheduler.set_workers(vec![node(3)]);
        let waiter = scheduler.browser_waiter(false).unwrap();
        assert!(
            scheduler
                .browser_excluding_class(&snapshot(), false, &HashSet::new(), true)
                .is_err()
        );
        drop(waiter);
        assert!(
            scheduler
                .browser_excluding_class(&snapshot(), false, &HashSet::new(), true)
                .is_ok()
        );
        let foreground = CancellationToken::new();
        let background = CancellationToken::new();
        let other = CancellationToken::new();
        assert!(scheduler.register("foreground", Some("p".into()), foreground.clone()));
        assert!(scheduler.register_background("background", Some("p".into()), background.clone()));
        assert!(scheduler.register_background("other", Some("q".into()), other.clone()));
        scheduler.cancel_cache_project("p");
        assert!(background.is_cancelled());
        assert!(!foreground.is_cancelled());
        assert!(!other.is_cancelled());
    }
    #[test]
    fn recovery_holds_the_real_background_capacity_until_cleanup() {
        let scheduler = Scheduler::default();
        scheduler.set_workers(vec![node(3)]);
        scheduler.recover_job_class(node(3), "old-job".into(), "old-owner".into(), None, true);
        assert_eq!(scheduler.cache_capacity()["background_active"], 1);
        assert_eq!(scheduler.cache_capacity()["effective_limit"], 0);
    }
}

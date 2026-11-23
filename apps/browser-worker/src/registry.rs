use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
const MAX_ENTRIES: usize = 4096;
const CLOSED_FOR: Duration = Duration::from_secs(60);
struct Entry {
    owner: String,
    gate: Arc<Mutex<()>>,
    cancel: CancellationToken,
    expires: Instant,
    closed: bool,
}
#[derive(Default)]
pub struct Registry {
    entries: Mutex<HashMap<String, Entry>>,
}
pub struct Control {
    pub gate: Arc<Mutex<()>>,
    pub cancel: CancellationToken,
}
pub struct Rejection {
    pub status: u16,
    pub code: &'static str,
}
impl Registry {
    pub async fn enter(
        &self,
        id: &str,
        owner: &str,
        action: &str,
        budget: u64,
    ) -> Result<Control, Rejection> {
        self.enter_at(id, owner, action, budget, Instant::now())
            .await
    }
    async fn enter_at(
        &self,
        id: &str,
        owner: &str,
        action: &str,
        budget: u64,
        now: Instant,
    ) -> Result<Control, Rejection> {
        let closing = matches!(action, "close" | "cancel");
        let mut entries = self.entries.lock().await;
        if !entries.contains_key(id) {
            if !closing && action != "open" {
                return Err(Rejection {
                    status: 404,
                    code: "JOB_NOT_FOUND",
                });
            }
            if entries.len() >= MAX_ENTRIES {
                return Err(Rejection {
                    status: 429,
                    code: "WORKER_REGISTRY_FULL",
                });
            }
            entries.insert(
                id.into(),
                Entry {
                    owner: owner.into(),
                    gate: Arc::new(Mutex::new(())),
                    cancel: CancellationToken::new(),
                    expires: now + Duration::from_millis(budget.min(60_000)),
                    closed: false,
                },
            );
        }
        let entry = entries.get_mut(id).unwrap();
        if entry.owner != owner {
            return Err(Rejection {
                status: 409,
                code: "STALE_OWNER",
            });
        }
        if closing {
            entry.cancel.cancel();
            entry.closed = true;
            entry.expires = now + CLOSED_FOR;
        } else if entry.closed || entry.expires <= now {
            entry.cancel.cancel();
            return Err(Rejection {
                status: 409,
                code: "JOB_CLOSED",
            });
        }
        Ok(Control {
            gate: entry.gate.clone(),
            cancel: entry.cancel.clone(),
        })
    }
    pub async fn mark_closed(&self, id: &str) {
        if let Some(entry) = self.entries.lock().await.get_mut(id) {
            entry.cancel.cancel();
            entry.closed = true;
            entry.expires = Instant::now() + CLOSED_FOR;
        }
    }
    pub async fn expired(&self) -> Vec<String> {
        self.expired_at(Instant::now()).await
    }
    async fn expired_at(&self, now: Instant) -> Vec<String> {
        let mut entries = self.entries.lock().await;
        let mut expired = Vec::new();
        entries.retain(|_, entry| {
            !entry.closed || entry.expires > now || Arc::strong_count(&entry.gate) > 1
        });
        for (id, entry) in entries.iter_mut() {
            if !entry.closed && entry.expires <= now {
                entry.cancel.cancel();
                entry.closed = true;
                entry.expires = now + CLOSED_FOR;
                expired.push(id.clone());
            }
        }
        expired
    }
    pub async fn shutdown(&self) {
        for entry in self.entries.lock().await.values() {
            entry.cancel.cancel();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn a11_cancel_before_open_is_fenced_after_cleanup_and_stale_owner_cannot_release_new_work()
     {
        let registry = Registry::default();
        let now = Instant::now();
        let cancelled = registry
            .enter_at("late", "owner", "cancel", 5000, now)
            .await
            .ok()
            .unwrap();
        assert!(cancelled.cancel.is_cancelled());
        crate::proof::check("A11.late_open", cancelled.cancel.is_cancelled());
        drop(cancelled);
        registry.expired_at(now + Duration::from_secs(3)).await;
        assert_eq!(
            registry
                .enter_at("late", "owner", "open", 45000, now + Duration::from_secs(3))
                .await
                .err()
                .unwrap()
                .code,
            "JOB_CLOSED"
        );
        let active = registry
            .enter_at("next", "new", "open", 45000, now)
            .await
            .ok()
            .unwrap();
        assert_eq!(
            registry
                .enter_at("next", "old", "close", 5000, now)
                .await
                .err()
                .unwrap()
                .code,
            "STALE_OWNER"
        );
        assert!(!active.cancel.is_cancelled());
        crate::proof::check("A11.stale_owner", !active.cancel.is_cancelled());
    }
    #[tokio::test]
    async fn a11_deadline_cancels_without_waiting_for_the_job_gate_and_registry_storage_is_bounded()
    {
        let registry = Registry::default();
        let now = Instant::now();
        let active = registry
            .enter_at("job", "owner", "open", 1000, now)
            .await
            .ok()
            .unwrap();
        let held = active.gate.lock().await;
        assert_eq!(
            registry.expired_at(now + Duration::from_secs(1)).await,
            ["job"]
        );
        assert!(active.cancel.is_cancelled());
        crate::proof::check("A11.deadline_cancel", active.cancel.is_cancelled());
        drop(held);
        drop(active);
        registry.expired_at(now + Duration::from_secs(62)).await;
        assert!(registry.entries.lock().await.is_empty());

        for n in 0..MAX_ENTRIES {
            registry
                .enter_at(&n.to_string(), "owner", "cancel", 5000, now)
                .await
                .ok()
                .unwrap();
        }
        let rejected = registry
            .enter_at("overflow", "owner", "open", 1000, now)
            .await
            .err()
            .unwrap();
        crate::proof::check(
            "A11.bounded_registry",
            rejected.code == "WORKER_REGISTRY_FULL"
                && registry.entries.lock().await.len() == MAX_ENTRIES,
        );
    }
}

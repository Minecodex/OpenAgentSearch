use crate::engine::{BrowserSlot, Run};
use futures::{StreamExt, stream};
use oas_domain::{Result, WorkerNode};
use oas_runtime::Lease;
use serde_json::{Value, json};
use std::{
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};

impl Run<'_> {
    pub fn browser_slot(&self) -> BrowserSlot {
        let slot = Arc::new(tokio::sync::Mutex::new(None));
        self.browsers.lock().unwrap().push(slot.clone());
        slot
    }

    pub async fn allocate_browser(
        &self,
        search: bool,
    ) -> Result<(WorkerNode, Option<Value>, Option<Value>, Lease)> {
        let queued = Instant::now();
        loop {
            if self.browser_blocked.load(Ordering::SeqCst) {
                return Err(oas_runtime::proxy_error());
            }
            let excluded = self.excluded_proxies.lock().unwrap().clone();
            match self
                .engine
                .scheduler
                .browser_excluding(self.snapshot, search, &excluded)
            {
                Ok(allocation) => return Ok(allocation),
                Err(error) if error.code == "CAPACITY_EXHAUSTED" => {
                    // A sibling owns a real lease and will release it on completion.
                    // Wait for that work inside the shared stage deadline instead of
                    // failing a one-slot request while its own first query is active.
                    if self.browser_active.load(Ordering::SeqCst) == 0
                        && queued.elapsed() >= Duration::from_secs(3)
                    {
                        return Err(error);
                    }
                }
                Err(error) => return Err(error),
            }
            self.bounded(async {
                tokio::time::sleep(Duration::from_millis(20)).await;
                Ok(())
            })
            .await?;
        }
    }

    pub async fn close_browser_slot(&self, slot: &BrowserSlot) {
        self.close_browser_slot_until(slot, self.deadline).await;
    }

    async fn close_browser_slot_until(&self, slot: &BrowserSlot, deadline: tokio::time::Instant) {
        let mut guard = slot.lock().await;
        let Some(browser) = guard.as_mut() else {
            return;
        };
        let cleanup = Instant::now();
        let offset = self.start.elapsed().as_millis() as u64;
        let allowance = deadline
            .saturating_duration_since(tokio::time::Instant::now())
            .min(Duration::from_secs(5));
        let confirmed = matches!(
            tokio::time::timeout(
                allowance,
                self.engine.transport.close_browser(&browser.value)
            )
            .await,
            Ok(Ok(()))
        );
        if confirmed {
            browser.lease.take();
        } else {
            self.browser_blocked.store(true, Ordering::SeqCst);
        }
        let phase = json!({"stage":"cleanup","start_offset_ms":offset,"duration_ms":cleanup.elapsed().as_millis()as u64,"status":if confirmed{"success"}else{"error"},"source":"api","scope":"job"});
        for call in &mut self.journal.lock().unwrap().calls {
            if call["browser_job"]["job_id"] == browser.value["job_id"]
                && let Some(phases) = call["browser_job"]["phases"].as_array_mut()
            {
                phases.push(phase.clone());
            }
        }
        guard.take();
    }

    pub async fn close_browsers(&self) {
        let slots = std::mem::take(&mut *self.browsers.lock().unwrap());
        stream::iter(slots)
            .for_each_concurrent(4, |slot| async move {
                self.close_browser_slot_until(&slot, self.total_deadline)
                    .await
            })
            .await;
    }
}

use super::*;

#[derive(Default)]
pub(super) struct Queue {
    order: VecDeque<String>,
    tasks: HashMap<String, VecDeque<u64>>,
}
impl Queue {
    fn push(&mut self, request: &str, ticket: u64) {
        if !self.tasks.contains_key(request) {
            self.order.push_back(request.into());
        }
        self.tasks
            .entry(request.into())
            .or_default()
            .push_back(ticket);
    }
    fn turn(&self, request: &str, ticket: u64) -> bool {
        self.order.front().is_some_and(|r| r == request)
            && self.tasks.get(request).and_then(|v| v.front()).copied() == Some(ticket)
    }
    fn remove(&mut self, request: &str, ticket: u64, rotate: bool) {
        if let Some(tasks) = self.tasks.get_mut(request) {
            tasks.retain(|t| *t != ticket);
            if tasks.is_empty() {
                self.tasks.remove(request);
                self.order.retain(|r| r != request);
            } else if rotate {
                self.order.retain(|r| r != request);
                self.order.push_back(request.into());
            }
        }
    }
}
struct Waiting {
    state: Arc<Mutex<State>>,
    endpoint: String,
    request: String,
    ticket: u64,
    granted: bool,
}
impl Drop for Waiting {
    fn drop(&mut self) {
        if !self.granted
            && let Some(q) = self
                .state
                .lock()
                .unwrap()
                .model_queues
                .get_mut(&self.endpoint)
        {
            q.remove(&self.request, self.ticket, false);
        }
    }
}
impl Scheduler {
    /// Per-endpoint FIFO within a request and round robin between requests.
    /// New passages cannot repeatedly jump ahead of already waiting requests.
    pub async fn model_permit(
        &self,
        e: &Endpoint,
        request: &str,
        cancel: &CancellationToken,
    ) -> Result<Lease> {
        self.model_permit_class(e, request, cancel, false).await
    }
    pub async fn model_permit_class(
        &self,
        e: &Endpoint,
        request: &str,
        cancel: &CancellationToken,
        background: bool,
    ) -> Result<Lease> {
        let queue_key = if background {
            format!("{}:background", e.id)
        } else {
            e.id.clone()
        };
        let ticket = {
            let mut s = self.state.lock().unwrap();
            s.sequence += 1;
            let t = s.sequence;
            s.model_queues
                .entry(queue_key.clone())
                .or_default()
                .push(request, t);
            t
        };
        let mut waiting = Waiting {
            state: self.state.clone(),
            endpoint: queue_key.clone(),
            request: request.into(),
            ticket,
            granted: false,
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            if cancel.is_cancelled() {
                return Err(Error::cancelled());
            }
            {
                let mut s = self.state.lock().unwrap();
                let turn = s
                    .model_queues
                    .get(&queue_key)
                    .is_some_and(|q| q.turn(request, ticket));
                let bg_key = format!("cache:model:{}", e.id);
                let foreground = s
                    .model_queues
                    .get(&e.id)
                    .is_some_and(|q| !q.order.is_empty());
                let (limit, rpm) = (
                    s.cache_model_limit.max(1),
                    if s.cache_model_rpm == 0 {
                        10
                    } else {
                        s.cache_model_rpm
                    },
                );
                let bg_room = !background
                    || (!foreground && has_room(&mut s, &bg_key, limit, rpm, self.clock.millis()));
                if turn
                    && bg_room
                    && has_room(&mut s, &e.id, e.max_concurrency, e.rpm, self.clock.millis())
                {
                    s.model_queues
                        .get_mut(&queue_key)
                        .unwrap()
                        .remove(request, ticket, true);
                    waiting.granted = true;
                    let mut lease = self.endpoint_locked(&mut s, e)?;
                    if background {
                        take(&mut s, &bg_key);
                        *s.reserved.entry(bg_key.clone()).or_default() += 1;
                        lease.keys.push(bg_key.clone());
                        lease.background_rate = Some(bg_key);
                    }
                    return Ok(lease);
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(capacity());
            }
            tokio::select! {_=cancel.cancelled()=>return Err(Error::cancelled()),_=tokio::time::sleep(Duration::from_millis(2))=>{}}
        }
    }
}

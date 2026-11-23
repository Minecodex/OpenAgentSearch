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
        let ticket = {
            let mut s = self.state.lock().unwrap();
            s.sequence += 1;
            let t = s.sequence;
            s.model_queues
                .entry(e.id.clone())
                .or_default()
                .push(request, t);
            t
        };
        let mut waiting = Waiting {
            state: self.state.clone(),
            endpoint: e.id.clone(),
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
                    .get(&e.id)
                    .is_some_and(|q| q.turn(request, ticket));
                if turn && has_room(&mut s, &e.id, e.max_concurrency, e.rpm, self.clock.millis()) {
                    s.model_queues
                        .get_mut(&e.id)
                        .unwrap()
                        .remove(request, ticket, true);
                    waiting.granted = true;
                    return self.endpoint_locked(&mut s, e);
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(capacity());
            }
            tokio::select! {_=cancel.cancelled()=>return Err(Error::cancelled()),_=tokio::time::sleep(Duration::from_millis(2))=>{}}
        }
    }
}

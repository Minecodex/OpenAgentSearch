use super::snapshot;
use crate::{
    BrowserOpen, Invocation, Transport,
    engine::{Engine, Execution, ExecutionContext},
};
use async_trait::async_trait;
use oas_domain::{Command, Endpoint, Error, Result, WorkerNode};
use oas_runtime::Scheduler;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Mock {
    active: AtomicUsize,
    search_peak: AtomicUsize,
    reader_peak: AtomicUsize,
    opened: Mutex<HashSet<String>>,
    closed: Mutex<HashSet<String>>,
    reader_started: CancellationToken,
    slow_first: bool,
    fail_close: AtomicBool,
}
struct Active<'a>(&'a AtomicUsize);
impl Drop for Active<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[async_trait]
impl Transport for Mock {
    async fn validate(&self, _: &Endpoint) -> Result<()> {
        Ok(())
    }
    async fn invoke(&self, call: Invocation<'_>) -> Result<Value> {
        call.dispatch.sent()?;
        let input = &call.prepared.input;
        let _active = if call.endpoint.browser() {
            let session = call.session.unwrap();
            assert!(
                self.opened
                    .lock()
                    .unwrap()
                    .contains(session["job_id"].as_str().unwrap())
            );
            let now = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            if call.task == "search" {
                self.search_peak.fetch_max(now, Ordering::SeqCst);
            } else {
                self.reader_peak.fetch_max(now, Ordering::SeqCst);
                self.reader_started.cancel();
            }
            Some(Active(&self.active))
        } else {
            assert_eq!(
                self.opened.lock().unwrap().len(),
                self.closed.lock().unwrap().len(),
                "idle browser jobs must be released before model work"
            );
            None
        };
        if call.endpoint.browser() {
            let delay = if self.slow_first && input["variant_id"] == "Q0" {
                3100
            } else {
                60
            };
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        Ok(match call.task {
            "rewrite" => json!({"queries":["rain a","rain b","rain c"]}),
            "search" => {
                json!({"hits":(0..4).map(|i|json!({"url":format!("https://example.com/{i}"),"title":format!("Rain {i}"),"snippet":"Rainfall measurements."})).collect::<Vec<_>>()})
            }
            "score" => {
                json!({"scores":input["candidates"].as_array().unwrap().iter().map(|candidate|json!({"candidate_id":candidate["candidate_id"],"relevant":true,"score":90})).collect::<Vec<_>>()})
            }
            "extract" => {
                json!({"body":format!("Rainfall measurements for {}.", input["url"].as_str().unwrap()),"media_type":"text/markdown"})
            }
            "synthesis" => {
                json!({"summary":"Rainfall is measured.","citations":[{"source_id":"s1","segment_id":"p1"}],"passages":crate::synthesis::passages(&input["sources"]).as_array().unwrap().iter().map(|part|json!({"source_id":part["source_id"],"segment_id":part["segment_id"],"relevant":true,"summary":"Rainfall measurements."})).collect::<Vec<_>>()})
            }
            _ => unreachable!(),
        })
    }
    async fn open_browser(&self, open: BrowserOpen<'_>) -> Result<Value> {
        assert!(self.opened.lock().unwrap().insert(open.job.into()));
        Ok(
            json!({"job_id":open.job,"request_id":open.request,"node":open.node,"diagnostics":{"job_id":open.job,"pod_uid":open.node.uid,"search_engine":"baidu","phases":[]}}),
        )
    }
    async fn close_browser(&self, session: &Value) -> Result<()> {
        if self.fail_close.load(Ordering::SeqCst) {
            return Err(Error::unavailable());
        }
        self.closed
            .lock()
            .unwrap()
            .insert(session["job_id"].as_str().unwrap().into());
        Ok(())
    }
    async fn risk(&self, _: &str, _: i64) -> Result<()> {
        Ok(())
    }
}

async fn run(
    transport: Arc<Mock>,
    slots: usize,
    cancel: CancellationToken,
    op: &str,
) -> (Execution, Scheduler) {
    let scheduler = Scheduler::default();
    scheduler.set_workers(vec![WorkerNode {
        uid: "worker".into(),
        name: "worker".into(),
        address: "http://unused".into(),
        slots,
        boot_id: "boot".into(),
    }]);
    let engine = Engine {
        transport,
        scheduler: scheduler.clone(),
    };
    let mut snapshot = snapshot();
    snapshot.project.rewrite_count = 3;
    snapshot.project.source_limit = 4;
    snapshot
        .probes
        .insert("default_network".into(), json!({"reachable":false}));
    for endpoint in snapshot.endpoints.iter_mut().take(2) {
        endpoint.provider = "browser".into();
        endpoint.adapter = if endpoint.kind == "search" {
            "browser_search"
        } else {
            "browser_reader"
        }
        .into();
        endpoint.timeout_ms = 5000;
    }
    let command: Command = serde_json::from_value(if op == "summary" {
        json!({"query":"rain","source_count":4})
    } else {
        json!({"query":"rain","count":1})
    })
    .unwrap();
    let output = engine
        .run(
            op,
            command,
            snapshot,
            ExecutionContext {
                request_id: oas_domain::id(),
                ui_language: "en".into(),
                cancel,
                deadline: tokio::time::Instant::now() + Duration::from_secs(15),
            },
        )
        .await;
    (output, scheduler)
}

#[tokio::test]
async fn browser_queries_and_readers_use_independent_jobs_and_release_them_before_models() {
    let transport = Arc::new(Mock::default());
    let (output, scheduler) = run(transport.clone(), 4, CancellationToken::new(), "summary").await;
    assert_eq!(output.response["status"], "success", "{}", output.response);
    assert_eq!(transport.search_peak.load(Ordering::SeqCst), 4);
    assert_eq!(transport.reader_peak.load(Ordering::SeqCst), 4);
    assert_eq!(transport.opened.lock().unwrap().len(), 8);
    assert_eq!(
        *transport.opened.lock().unwrap(),
        *transport.closed.lock().unwrap()
    );
    assert_eq!(scheduler.active("worker:worker"), 0);
    for call in output
        .calls
        .iter()
        .filter(|call| call["browser_job"].is_object())
    {
        let phases = call["browser_job"]["phases"].as_array().unwrap();
        assert_eq!(
            phases
                .iter()
                .filter(|phase| phase["stage"] == "cleanup")
                .count(),
            1
        );
        assert_eq!(call["browser_job"]["reused_context"], false);
    }
    assert_eq!(output.response["data"]["sources"][0]["id"], "s1");
}

#[tokio::test]
async fn one_slot_waits_for_its_own_sibling_beyond_the_external_queue_limit() {
    let transport = Arc::new(Mock {
        slow_first: true,
        ..Default::default()
    });
    let (output, scheduler) = run(transport.clone(), 1, CancellationToken::new(), "summary").await;
    assert_eq!(output.response["status"], "success", "{}", output.response);
    assert_eq!(transport.search_peak.load(Ordering::SeqCst), 1);
    assert_eq!(transport.reader_peak.load(Ordering::SeqCst), 1);
    assert_eq!(transport.opened.lock().unwrap().len(), 8);
    assert_eq!(scheduler.active("worker:worker"), 0);
}

#[tokio::test]
async fn cancelling_parallel_readers_closes_every_job_and_releases_every_lease() {
    let transport = Arc::new(Mock::default());
    let cancel = CancellationToken::new();
    let (result, ()) = tokio::join!(
        run(transport.clone(), 4, cancel.clone(), "summary"),
        async {
            transport.reader_started.cancelled().await;
            cancel.cancel();
        }
    );
    let (output, scheduler) = result;
    assert_eq!(output.response["error"]["code"], "CANCELLED");
    assert_eq!(transport.active.load(Ordering::SeqCst), 0);
    assert_eq!(
        *transport.opened.lock().unwrap(),
        *transport.closed.lock().unwrap()
    );
    assert_eq!(scheduler.active("worker:worker"), 0);
    assert!(scheduler.pending_cleanup().is_empty());
}

#[tokio::test]
async fn unconfirmed_cleanup_still_holds_the_browser_lease_until_recovered() {
    let transport = Arc::new(Mock {
        fail_close: AtomicBool::new(true),
        ..Default::default()
    });
    let (output, scheduler) = run(transport.clone(), 1, CancellationToken::new(), "list").await;
    assert_eq!(output.response["status"], "success");
    assert_eq!(scheduler.active("worker:worker"), 1);
    let pending = scheduler.pending_cleanup();
    assert_eq!(pending.len(), 1);
    transport.fail_close.store(false, Ordering::SeqCst);
    for job in &pending {
        transport
            .close_browser(&json!({"job_id":job.job_id}))
            .await
            .unwrap();
    }
    drop(pending);
    assert_eq!(scheduler.active("worker:worker"), 0);
}

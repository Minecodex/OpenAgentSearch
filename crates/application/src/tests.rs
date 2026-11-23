use crate::{
    BrowserOpen, Invocation, Transport,
    engine::{Engine, ExecutionContext},
};
use async_trait::async_trait;
use oas_domain::{Command, Endpoint, Result, Snapshot, WorkerNode};
use oas_runtime::Scheduler;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
#[path = "browser_concurrency_tests.rs"]
mod browser_concurrency;
struct Fake {
    mode: &'static str,
    active: std::sync::atomic::AtomicUsize,
    peak: std::sync::atomic::AtomicUsize,
    inputs: Mutex<Vec<(String, Value)>>,
}
#[async_trait]
impl Transport for Fake {
    async fn validate(&self, _: &Endpoint) -> Result<()> {
        Ok(())
    }
    async fn invoke(&self, invocation: Invocation<'_>) -> Result<Value> {
        let Invocation {
            endpoint: e,
            task,
            prepared,
            cancel,
            dispatch,
            ..
        } = invocation;
        let input = &prepared.input;
        dispatch.sent()?;
        self.inputs
            .lock()
            .unwrap()
            .push((task.into(), input.clone()));
        if self.mode == "rewrite_error" && task == "rewrite" {
            return Err(oas_domain::Error::new(
                "MODEL_FAILED",
                502,
                "改写失败。",
                "Rewrite failed.",
            ));
        }
        if matches!(self.mode, "fanout_cancel" | "fanout_timeout")
            && task == "search"
            && input["variant_id"] == "Q1"
        {
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
        if self.mode == "timing" && task == "extract" {
            tokio::time::sleep(Duration::from_millis(20)).await;
            return Ok(
                json!({"body":"A readable article.","media_type":"text/markdown","_phases":[{"stage":"navigate","start_offset_ms":1,"duration_ms":5,"status":"success","source":"worker","scope":"call","parent_stage":"execute"},{"stage":"extract","start_offset_ms":6,"duration_ms":2,"status":"success","source":"worker","scope":"call","parent_stage":"execute"}]}),
            );
        }
        let _activity = if task == "segments" {
            let now = self
                .active
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1;
            self.peak
                .fetch_max(now, std::sync::atomic::Ordering::SeqCst);
            Some(Activity(&self.active))
        } else {
            None
        };
        if self.mode == "parallel" && matches!(task, "segments" | "extract") {
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        if self.mode == "budget" && task == "segments" && input["source_id"] == "s2" {
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
        if e.id == "slow" {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        if self.mode == "cancel" && matches!(task, "segments" | "synthesis") {
            cancel.cancel();
            return Err(oas_domain::Error::cancelled());
        }
        Ok(match task {
            "compress" => {
                json!({"summary":"Rainfall.","citations":input["source"]["segments"].as_array().unwrap().iter().flat_map(|part|{
                let ids=part["references"].as_array().cloned().unwrap_or_else(||vec![part["id"].clone()]);
                ids.into_iter().map(|id|json!({"source_id":input["source"]["id"],"segment_id":id})).collect::<Vec<_>>()
            }).collect::<Vec<_>>()})
            }
            "search" if self.mode == "search_cards" => json!({"hits":[],"cards":[{
                "engine":"google","url":"https://www.google.com/search?q=rain","title":"Rainfall card","content":"A rain gauge measures rainfall.\nRainfall: 12 mm."
            }]}),
            "rewrite" if self.mode == "rewrite" => {
                json!({"queries":["rain second", " RAIN SECOND ", "rain", ""]})
            }
            "search" if self.mode == "inline_material" => {
                json!({"hits":[{
                    "url":"https://example.com/a",
                    "title":"Rain <guide> **literal**",
                    "snippet":"A rain gauge measures rainfall.",
                    "content":"FULL_ARTICLE_MUST_BE_IGNORED"
                }]})
            }
            "search" if self.mode == "empty_search_item" => {
                json!({"hits":[{"url":"https://example.com/a","title":"","snippet":""}]})
            }
            "search" => {
                json!({"hits":[{"url":"https://example.com/a","title":"A","snippet":"Rain"},{"url":"https://example.com/b","title":"B","snippet":"Rain"}]})
            }
            "score" => {
                let inputs = self.inputs.lock().unwrap();
                let first = inputs.iter().filter(|(t, _)| t == "score").count() == 1;
                let candidates = input["candidates"].as_array().unwrap();
                let n = if self.mode == "partial_score" && first {
                    1
                } else {
                    candidates.len()
                };
                json!({"scores":candidates.iter().take(n).map(|v|json!({"candidate_id":v["candidate_id"],"relevant":true,"score":90})).collect::<Vec<_>>()})
            }
            "extract" => {
                json!({"body":if self.mode=="parallel"{"雨量计记录毫米。 Rain is measured. ".repeat(1000)}else if self.mode=="budget"{"Rain gauges record daily rainfall in millimetres. ".repeat(48)}else{"# Rain\n\nRain gauges measure rainfall.".into()},"media_type":"text/markdown"})
            }
            "segments" if input["passages"].is_array() => {
                json!({"passages":input["passages"].as_array().unwrap().iter().map(|p|json!({"source_id":p["source_id"],"segment_id":p["segment_id"],"relevant":true,"summary":"Rainfall."})).collect::<Vec<_>>()})
            }
            "synthesis" if input["mode"] == "whole_sources" => {
                let passages = crate::synthesis::passages(&input["sources"]);
                let relevant = self.mode != "irrelevant";
                let rows=passages.as_array().unwrap().iter().map(|p|json!({"source_id":p["source_id"],"segment_id":p["segment_id"],"relevant":relevant,"summary":if relevant {"Rainfall."} else {""}})).collect::<Vec<_>>();
                json!({"summary":if relevant {"Rain is measured."}else{""},"citations":if relevant {json!([{"source_id":rows[0]["source_id"],"segment_id":rows[0]["segment_id"]}])}else{json!([])},"passages":rows})
            }
            "segments" => {
                json!({"source_id":input["source_id"],"segment_id":input["segment_id"],"relevant":self.mode!="irrelevant","summary":"Rain is measured."})
            }
            "synthesis" => {
                json!({"summary":"Rain is measured.","citations":[{"source_id":input["sources"][0]["id"],"segment_id":input["sources"][0]["segments"][0]["id"]}]})
            }
            _ => {
                json!({"queries":if self.mode.starts_with("fanout"){json!(["rain second"])}else{json!([])}})
            }
        })
    }
    async fn open_browser(&self, open: BrowserOpen<'_>) -> Result<Value> {
        if self.mode == "timing" {
            tokio::time::sleep(Duration::from_millis(180)).await;
            return Ok(
                json!({"job_id":open.job,"request_id":open.request,"node":open.node,"diagnostics":{"job_id":open.job,"pod_name":open.node.name,"pod_uid":open.node.uid,"egress_mode":"default_network","phases":[]}}),
            );
        }
        let _cancel = open.cancel;
        if self.mode == "opening" {
            _cancel.cancel();
            return std::future::pending().await;
        }
        unreachable!()
    }
    async fn close_browser(&self, _: &Value) -> Result<()> {
        Ok(())
    }
    async fn risk(&self, _: &str, _: i64) -> Result<()> {
        Ok(())
    }
}
#[tokio::test]
async fn search_list_summary_uses_literal_titles_and_snippets_without_a_reader_or_inline_body() {
    let mut snap = snapshot();
    snap.project.summary_snippets_only = true;
    snap.project.reader_pools.clear();
    assert!(!snap.project.allow_snippets);

    let (response, transport) = execute("inline_material", snap, "summary").await;
    assert_eq!(response["status"], "success", "{response}");
    assert_eq!(response["warnings"], json!([]));
    assert_eq!(response["data"]["sources"][0]["kind"], "snippet");
    assert!(!response["data"]["citations"].as_array().unwrap().is_empty());
    let inputs = transport.inputs.lock().unwrap();
    assert!(!inputs.iter().any(|(task, _)| task == "extract"));
    let summary = &inputs
        .iter()
        .find(|(task, _)| task == "synthesis")
        .unwrap()
        .1;
    assert_eq!(
        summary["sources"][0]["segments"][0]["text"],
        "Rain <guide> **literal**\n\nA rain gauge measures rainfall."
    );
    assert!(!summary.to_string().contains("FULL_ARTICLE_MUST_BE_IGNORED"));
}

#[tokio::test]
async fn normal_summary_keeps_using_search_inline_articles_by_default() {
    let snap = snapshot();
    assert!(!snap.project.summary_snippets_only);
    let (response, transport) = execute("inline_material", snap, "summary").await;
    assert_eq!(response["status"], "success", "{response}");
    assert_eq!(response["data"]["sources"][0]["kind"], "body");
    let inputs = transport.inputs.lock().unwrap();
    let summary = &inputs
        .iter()
        .find(|(task, _)| task == "synthesis")
        .unwrap()
        .1;
    assert_eq!(
        summary["sources"][0]["segments"][0]["text"],
        "FULL_ARTICLE_MUST_BE_IGNORED"
    );
}

#[tokio::test]
async fn search_list_summary_returns_empty_when_selected_items_have_no_text() {
    let mut snap = snapshot();
    snap.project.summary_snippets_only = true;
    let (response, transport) = execute("empty_search_item", snap, "summary").await;
    assert_eq!(response["status"], "empty", "{response}");
    assert_eq!(response["data"]["citations"], json!([]));
    assert!(
        !transport
            .inputs
            .lock()
            .unwrap()
            .iter()
            .any(|(task, _)| task == "extract")
    );
}

#[tokio::test]
async fn original_query_switch_preserves_variant_ids_and_scoring_context() {
    for enabled in [true, false] {
        let mut snap = snapshot();
        snap.project.rewrite_count = 1;
        snap.project.search_original_query = enabled;
        let (result, transport) = execute("rewrite", snap, "summary").await;
        assert_eq!(result["status"], "success", "{result}");
        let inputs = transport.inputs.lock().unwrap();
        let searches = inputs
            .iter()
            .filter(|(task, _)| task == "search")
            .map(|(_, input)| input)
            .collect::<Vec<_>>();
        assert_eq!(searches.len(), if enabled { 2 } else { 1 });
        assert_eq!(searches.last().unwrap()["query"], "rain second");
        assert_eq!(searches.last().unwrap()["variant_id"], "Q1");
        assert_eq!(
            searches.iter().any(|input| input["variant_id"] == "Q0"),
            enabled
        );
        for (_, input) in inputs
            .iter()
            .filter(|(task, _)| matches!(task.as_str(), "score" | "synthesis"))
        {
            assert_eq!(input["query"], "rain");
        }
    }
}
#[tokio::test]
async fn rewrite_only_never_silently_searches_the_original_on_empty_or_failed_rewriting() {
    for mode in ["empty_rewrite", "rewrite_error"] {
        let mut snap = snapshot();
        snap.project.rewrite_count = 1;
        snap.project.search_original_query = false;
        let (result, transport) = execute(mode, snap.clone(), "summary").await;
        assert_eq!(result["error"]["code"], "QUERY_REWRITE_FAILED", "{result}");
        assert!(
            !transport
                .inputs
                .lock()
                .unwrap()
                .iter()
                .any(|(task, _)| task == "search")
        );
        let (list, transport) = execute(mode, snap, "list").await;
        assert_eq!(list["status"], "success", "{list}");
        let inputs = transport.inputs.lock().unwrap();
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].1["variant_id"], "Q0");
        assert_eq!(inputs[0].1["query"], "rain");
    }
}
#[tokio::test]
async fn ordinary_search_cards_are_list_material_and_scored_inline_sources_for_summaries() {
    let (list, transport) = execute("search_cards", snapshot(), "list").await;
    assert_eq!(list["status"], "success", "{list}");
    assert!(list["data"]["items"].as_array().unwrap().is_empty());
    assert_eq!(list["data"]["cards"][0]["engine"], "google");
    assert!(list["data"]["engine_answer"].is_null());
    assert_eq!(transport.inputs.lock().unwrap().len(), 1);
    let (summary, transport) = execute("search_cards", snapshot(), "summary").await;
    assert_eq!(summary["status"], "success", "{summary}");
    assert_eq!(
        summary["data"]["sources"][0]["url"],
        "https://www.google.com/search?q=rain"
    );
    let inputs = transport.inputs.lock().unwrap();
    assert!(!inputs.iter().any(|(task, _)| task == "extract"));
    let score = &inputs.iter().find(|(task, _)| task == "score").unwrap().1;
    assert_eq!(score["query"], "rain");
    assert!(
        score["candidates"][0]["title"]
            .as_str()
            .unwrap()
            .contains("搜索页卡片")
    );
    let synthesis = &inputs
        .iter()
        .find(|(task, _)| task == "synthesis")
        .unwrap()
        .1;
    assert!(synthesis.to_string().contains("12 mm"));
}
fn snapshot() -> Snapshot {
    let project=serde_json::from_value(json!({"id":"project","name":"Test","rewrite_count":0,"search_pools":[["search"]],"reader_pools":[["reader"]],"model_endpoint_id":"model"})).unwrap();
    let endpoints=[("search","search"),("reader","reader"),("model","model")].into_iter().map(|(id,kind)|serde_json::from_value(json!({"id":id,"kind":kind,"name":id,"provider":"test","adapter":"test","base_url":null,"timeout_ms":1000,"max_concurrency":10,"rpm":100,"version":1,"availability":"available","managed_by":"administrator","has_secret":false,"last_test":null,"options":{}})).unwrap()).collect();
    Snapshot {
        project,
        endpoints,
        proxies: vec![],
        pools: vec![],
        routes: json!({"entries":[]}),
        secrets: HashMap::new(),
        probes: HashMap::new(),
        retention_days: 7,
        retention_version: 1,
    }
}
async fn execute(mode: &'static str, mut snap: Snapshot, op: &str) -> (Value, Arc<Fake>) {
    let transport = Arc::new(Fake {
        mode,
        active: Default::default(),
        peak: Default::default(),
        inputs: Mutex::new(vec![]),
    });
    let engine = Engine {
        transport: transport.clone(),
        scheduler: Scheduler::default(),
    };
    if mode == "timeout" {
        snap.endpoints[0].id = "slow".into();
        snap.endpoints[0].timeout_ms = 5;
        let mut next = snap.endpoints[0].clone();
        next.id = "fast".into();
        snap.endpoints.push(next);
        snap.project.search_pools = vec![vec!["slow".into(), "fast".into()]];
    }
    let command: Command = serde_json::from_value(if op == "list" {
        json!({"query":"rain","count":1})
    } else {
        json!({"query":"rain","source_count":if mode=="parallel"{2}else{1}})
    })
    .unwrap();
    let result = engine
        .run(
            op,
            command,
            snap,
            ExecutionContext {
                request_id: oas_domain::id(),
                ui_language: "en".into(),
                cancel: CancellationToken::new(),
                deadline: tokio::time::Instant::now() + Duration::from_secs(10),
            },
        )
        .await;
    (result.response, transport)
}
#[tokio::test]
async fn score_correction_keeps_valid_candidates_and_retries_only_missing() {
    let (result, t) = execute("partial_score", snapshot(), "summary").await;
    assert_eq!(result["status"], "success", "{result}");
    let inputs = t.inputs.lock().unwrap();
    let scores = inputs
        .iter()
        .filter(|(task, _)| task == "score")
        .collect::<Vec<_>>();
    assert_eq!(scores.len(), 2);
    assert_eq!(scores[1].1["candidates"].as_array().unwrap().len(), 1);
    assert_eq!(scores[1].1["candidates"][0]["candidate_id"], "c2");
}
#[tokio::test]
async fn whole_sources_use_one_synthesis_with_scoped_citations_and_local_time() {
    let (reply, transport) = execute("normal", snapshot(), "summary").await;
    assert_eq!(reply["status"], "success");
    let inputs = transport.inputs.lock().unwrap();
    assert!(!inputs.iter().any(|(stage, _)| stage == "segments"));
    let mut synthesis = inputs.iter().filter(|(stage, _)| stage == "synthesis");
    let (_, input) = synthesis.next().unwrap();
    assert!(synthesis.next().is_none());
    assert_eq!(input["mode"], "whole_sources");
    assert!(
        input["sources"][0]["segments"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Rain")
    );
    assert!(input["local_time"].is_string());
    assert!(input.get("region").is_none());
    assert_eq!(
        reply["data"]["citations"][0]["segment_id"],
        reply["data"]["sources"][0]["segments"][0]["id"]
    );
}
#[tokio::test]
async fn all_segments_irrelevant_is_a_valid_empty_result() {
    let (result, _) = execute("irrelevant", snapshot(), "summary").await;
    assert_eq!(result["status"], "empty", "{result}");
}
#[tokio::test]
async fn cancellation_during_segments_keeps_its_terminal_code() {
    let (result, _) = execute("cancel", snapshot(), "summary").await;
    assert_eq!(result["error"]["code"], "CANCELLED");
}
#[tokio::test]
async fn endpoint_timeout_falls_over_within_the_request_budget() {
    let (result, t) = execute("timeout", snapshot(), "summary").await;
    assert_eq!(result["status"], "success", "{result}");
    assert_eq!(
        t.inputs
            .lock()
            .unwrap()
            .iter()
            .filter(|(task, _)| task == "search")
            .count(),
        2
    );
}

#[tokio::test]
async fn cancellation_while_opening_browser_does_not_dispatch_a_search_or_leak_a_slot() {
    let transport = Arc::new(Fake {
        mode: "opening",
        active: Default::default(),
        peak: Default::default(),
        inputs: Mutex::new(vec![]),
    });
    let scheduler = Scheduler::default();
    scheduler.set_workers(vec![WorkerNode {
        uid: "unit".into(),
        name: "unit".into(),
        address: "http://unused".into(),
        slots: 1,
        boot_id: "boot".into(),
    }]);
    let engine = Engine {
        transport: transport.clone(),
        scheduler: scheduler.clone(),
    };
    let mut snap = snapshot();
    snap.endpoints[1].provider = "browser".into();
    snap.endpoints[1].adapter = "browser_reader".into();
    let command: Command = serde_json::from_value(json!({"url":"https://example.com/"})).unwrap();
    let run = engine.run(
        "content",
        command,
        snap,
        ExecutionContext {
            request_id: oas_domain::id(),
            ui_language: "en".into(),
            cancel: CancellationToken::new(),
            deadline: tokio::time::Instant::now() + Duration::from_secs(10),
        },
    );
    let output = tokio::time::timeout(Duration::from_secs(1), run)
        .await
        .unwrap();
    assert_eq!(output.response["error"]["code"], "CANCELLED");
    assert!(output.calls.is_empty());
    assert!(transport.inputs.lock().unwrap().is_empty());
    assert_eq!(scheduler.active("worker:unit"), 1);
    crate::proof::check("A11.quarantine", scheduler.active("worker:unit") == 1);
    let pending = scheduler.pending_cleanup();
    assert_eq!(pending.len(), 1);
    transport
        .close_browser(&json!({"job_id":pending[0].job_id}))
        .await
        .unwrap();
    drop(pending);
    assert_eq!(scheduler.active("worker:unit"), 0);
}

struct Activity<'a>(&'a std::sync::atomic::AtomicUsize);
impl Drop for Activity<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}
#[tokio::test]
async fn a08_parallel_passages_share_a_four_slot_request_limit_and_cancelled_work_is_released() {
    let mut snap = snapshot();
    snap.project.source_limit = 2;
    snap.endpoints[2].options = json!({"max_input_tokens":1536,"tokenizer":"cl100k_base"});
    let (_, transport) = execute("parallel", snap, "summary").await;
    assert!(transport.peak.load(std::sync::atomic::Ordering::SeqCst) >= 2);
    assert!(transport.peak.load(std::sync::atomic::Ordering::SeqCst) <= 4);
    crate::proof::check(
        "A08.parallel_limit",
        transport.peak.load(std::sync::atomic::Ordering::SeqCst) <= 4,
    );
    assert_eq!(
        transport.active.load(std::sync::atomic::Ordering::SeqCst),
        0
    );
}
#[tokio::test]
async fn a08_slow_material_leaves_synthesis_time_and_completed_evidence_in_the_shared_journal() {
    let transport = Arc::new(Fake {
        mode: "budget",
        inputs: Mutex::new(vec![]),
        active: Default::default(),
        peak: Default::default(),
    });
    let scheduler = Scheduler::default();
    let engine = Engine {
        transport: transport.clone(),
        scheduler: scheduler.clone(),
    };
    let mut snap = snapshot();
    snap.project.source_limit = 2;
    snap.endpoints[2].timeout_ms = 5000;
    snap.endpoints[2].options = json!({"max_input_tokens":1200,"tokenizer":"cl100k_base"});
    let result = engine
        .run(
            "summary",
            serde_json::from_value(json!({"query":"rain","source_count":2})).unwrap(),
            snap,
            ExecutionContext {
                request_id: oas_domain::id(),
                ui_language: "en".into(),
                cancel: CancellationToken::new(),
                deadline: tokio::time::Instant::now() + Duration::from_secs(3),
            },
        )
        .await;
    assert_eq!(result.response["status"], "partial", "{} calls={}", result.response,
        serde_json::json!(result.calls.iter().map(|call|serde_json::json!({"stage":call["stage"],"status":call["status"],"code":call["error_code"],"sent":call["sent"],"tokens":call["estimated_input_tokens"]})).collect::<Vec<_>>()));
    assert!(!result.evidence["segments"].as_array().unwrap().is_empty());
    assert!(
        result
            .calls
            .iter()
            .any(|c| c["stage"] == "synthesis" && c["sent"] == true)
    );
    assert!(
        result
            .calls
            .iter()
            .any(|c| c["stage"] == "segments" && c["status"] == "error")
    );
    assert_eq!(scheduler.active("model"), 0);
    crate::proof::check(
        "A08.synthesis_reserve",
        result.response["status"] == "partial"
            && result.calls.iter().any(|c| c["stage"] == "synthesis"),
    );
}
#[tokio::test]
async fn a08_preflight_context_rejection_never_commits_rpm_or_creates_a_sent_call() {
    let scheduler = Scheduler::default();
    let transport = Arc::new(Fake {
        mode: "normal",
        inputs: Mutex::new(vec![]),
        active: Default::default(),
        peak: Default::default(),
    });
    let engine = Engine {
        transport,
        scheduler: scheduler.clone(),
    };
    let mut snap = snapshot();
    snap.endpoints[2].rpm = 1;
    snap.endpoints[2].options = json!({"max_input_tokens":1});
    let context = || ExecutionContext {
        request_id: oas_domain::id(),
        ui_language: "en".into(),
        cancel: CancellationToken::new(),
        deadline: tokio::time::Instant::now() + Duration::from_secs(2),
    };
    let input = json!({"source_id":"s1","segment_id":"p1","text":"rain"});
    let rejected = engine
        .test(
            snap.endpoints[2].clone(),
            "segments",
            input.clone(),
            snap.clone(),
            context(),
        )
        .await;
    assert!(rejected.calls.is_empty());
    crate::proof::check("A08.unsent_rpm", rejected.calls.is_empty());
    assert_eq!(scheduler.active("model"), 0);
    snap.endpoints[2].options = json!({"max_input_tokens":8192});
    let accepted = engine
        .test(
            snap.endpoints[2].clone(),
            "segments",
            input,
            snap,
            context(),
        )
        .await;
    assert_eq!(accepted.calls.len(), 1);
    assert_eq!(accepted.calls[0]["sent"], true);
}

#[tokio::test]
async fn completed_search_evidence_survives_cancel_and_timeout() {
    for mode in ["fanout_cancel", "fanout_timeout"] {
        let transport = Arc::new(Fake {
            mode,
            inputs: Mutex::new(vec![]),
            active: Default::default(),
            peak: Default::default(),
        });
        let engine = Arc::new(Engine {
            transport: transport.clone(),
            scheduler: Scheduler::default(),
        });
        let mut snap = snapshot();
        snap.project.rewrite_count = 1;
        snap.endpoints[0].timeout_ms = 10000;
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let task = tokio::spawn(async move {
            engine
                .run(
                    "summary",
                    serde_json::from_value(json!({"query":"rain"})).unwrap(),
                    snap,
                    ExecutionContext {
                        request_id: oas_domain::id(),
                        ui_language: "en".into(),
                        cancel: token,
                        deadline: tokio::time::Instant::now() + Duration::from_secs(2),
                    },
                )
                .await
        });
        for _ in 0..200 {
            if transport
                .inputs
                .lock()
                .unwrap()
                .iter()
                .any(|(task, input)| task == "search" && input["variant_id"] == "Q1")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        if mode == "fanout_cancel" {
            cancel.cancel();
        }
        let execution = task.await.unwrap();
        let variants = execution.evidence["variants"].as_array().unwrap();
        let counts = oas_domain::evidence::retrieval(&execution.calls, &execution.evidence);
        let valid = variants.len() == 2
            && variants[0]["hits"].as_array().is_some_and(|v| v.len() == 2)
            && variants[1]["hits"].is_null()
            && counts["raw_candidates"].is_null()
            && counts["known_raw_candidates"] == 2
            && counts["completed_variants"] == 1;
        crate::proof::check(
            if mode == "fanout_cancel" {
                "A08.completed_cancel"
            } else {
                "A08.completed_timeout"
            },
            valid,
        );
        crate::proof::check("A13.completed_evidence", valid);
        if mode == "fanout_timeout" {
            crate::proof::check(
                "A08.total_deadline",
                execution.response["error"]["code"] == "DEADLINE_EXCEEDED",
            );
        }
        crate::proof::check(
            "A19.incomplete_payload",
            execution.calls.iter().any(|c| c["status"] == "success")
                && execution.response["error"].is_object(),
        );
    }
}
#[tokio::test]
async fn browser_context_time_is_not_counted_as_navigation() {
    let transport = Arc::new(Fake {
        mode: "timing",
        inputs: Mutex::new(vec![]),
        active: Default::default(),
        peak: Default::default(),
    });
    let scheduler = Scheduler::default();
    scheduler.set_workers(vec![WorkerNode {
        uid: "timing".into(),
        name: "timing".into(),
        address: "http://unused".into(),
        slots: 1,
        boot_id: "boot".into(),
    }]);
    let engine = Engine {
        transport,
        scheduler,
    };
    let mut snap = snapshot();
    snap.endpoints[1].provider = "browser".into();
    snap.endpoints[1].adapter = "browser_reader".into();
    let execution = engine
        .run(
            "content",
            serde_json::from_value(json!({"url":"https://example.com/"})).unwrap(),
            snap,
            ExecutionContext {
                request_id: oas_domain::id(),
                ui_language: "en".into(),
                cancel: CancellationToken::new(),
                deadline: tokio::time::Instant::now() + Duration::from_secs(5),
            },
        )
        .await;
    let phases = execution.calls[0]["browser_job"]["phases"]
        .as_array()
        .unwrap();
    let context = phases.iter().find(|p| p["stage"] == "context").unwrap();
    let rpc = phases.iter().find(|p| p["stage"] == "execute").unwrap();
    let nav = phases.iter().find(|p| p["stage"] == "navigate").unwrap();
    crate::proof::check(
        "A13.phase_accounting",
        context["duration_ms"].as_u64().unwrap() >= 150
            && nav["duration_ms"] == 5
            && rpc["duration_ms"].as_u64().unwrap() < 150
            && nav["start_offset_ms"].as_u64().unwrap()
                >= context["start_offset_ms"].as_u64().unwrap()
                    + context["duration_ms"].as_u64().unwrap()
            && nav["parent_stage"] == "execute",
    );
}

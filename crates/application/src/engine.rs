use crate::{
    Transport,
    journal::{Journal, SharedJournal},
};
use oas_domain::{
    Command, Endpoint, Error, Result, Snapshot, id, success, validation::validate_command,
};
use oas_runtime::{Lease, Scheduler};
use serde_json::{Value, json};
use std::{
    future::Future,
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

pub struct Engine {
    pub transport: Arc<dyn Transport>,
    pub scheduler: Scheduler,
}
pub struct ExecutionContext {
    pub request_id: String,
    pub ui_language: String,
    pub cancel: CancellationToken,
    pub deadline: tokio::time::Instant,
}
pub struct Execution {
    pub response: Value,
    pub calls: Vec<Value>,
    pub spans: Vec<Value>,
    pub evidence: Value,
    pub materials: Vec<Value>,
}
pub(crate) struct Browser {
    pub value: Value,
    pub lease: Option<Lease>,
    pub scheduler: Scheduler,
    pub active: Arc<std::sync::atomic::AtomicUsize>,
}
impl Drop for Browser {
    fn drop(&mut self) {
        self.active
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        if let Some(lease) = self.lease.take()
            && let (Ok(node), Some(job)) = (
                serde_json::from_value(self.value["node"].clone()),
                self.value["job_id"].as_str(),
            )
        {
            self.scheduler.quarantine(node, job.into(), lease);
        }
    }
}
pub(crate) type BrowserSlot = Arc<AsyncMutex<Option<Browser>>>;
pub(crate) struct Run<'a> {
    pub excluded_proxies: Arc<Mutex<std::collections::HashSet<String>>>,
    pub reselections: Arc<std::sync::atomic::AtomicUsize>,
    pub browser_blocked: Arc<std::sync::atomic::AtomicBool>,
    pub engine: &'a Engine,
    pub snapshot: &'a Snapshot,
    pub request: &'a str,
    pub lang: &'a str,
    pub cancel: CancellationToken,
    pub start: Instant,
    pub deadline: tokio::time::Instant,
    pub total_deadline: tokio::time::Instant,
    pub journal: SharedJournal,
    pub browsers: Arc<Mutex<Vec<BrowserSlot>>>,
    pub browser_active: Arc<std::sync::atomic::AtomicUsize>,
    pub query_context: Value,
    pub parent: Option<String>,
}
impl Engine {
    pub async fn run(
        &self,
        op: &str,
        command: Command,
        snapshot: Snapshot,
        context: ExecutionContext,
    ) -> Execution {
        let mut run = Run::new(self, &snapshot, &context);
        if op == "summary" {
            if let Some(region) = &command.region {
                run.query_context["region"] = json!(region.trim());
            }
            if let Some(time) = &command.current_time {
                run.query_context["current_time"] = json!(time);
            } else {
                run.query_context["local_time"] =
                    json!(chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false));
            }
        }
        let outcome = async {
            let (span, started) = run.begin("admit", serde_json::to_value(&command).unwrap());
            validate_command(op, &command, &snapshot.project)?;
            let _permit = self.scheduler.admission(&run.cancel).await?;
            run.end(
                &span,
                "success",
                json!({"project_version":snapshot.project.version}),
                started,
            );
            run.execute(op, &command).await
        };
        let response = match tokio::time::timeout_at(context.deadline, outcome).await {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => error.envelope(&context.request_id, &context.ui_language),
            Err(_) => {
                context.cancel.cancel();
                Error::timeout().envelope(&context.request_id, &context.ui_language)
            }
        };
        run.finish(response).await
    }
    pub async fn test(
        &self,
        endpoint: Endpoint,
        task: &str,
        input: Value,
        snapshot: Snapshot,
        context: ExecutionContext,
    ) -> Execution {
        let run = Run::new(self, &snapshot, &context);
        let outcome = async {
            let _permit = self.scheduler.admission(&context.cancel).await?;
            let queued = Instant::now();
            let lease = if endpoint.kind == "model" {
                run.bounded(self.scheduler.model_permit(
                    &endpoint,
                    &context.request_id,
                    &context.cancel,
                ))
                .await?
            } else {
                run.bounded(self.scheduler.endpoint_wait(&endpoint, &context.cancel))
                    .await?
            };
            let output = run
                .call(
                    &endpoint,
                    task,
                    &input,
                    None,
                    lease,
                    queued.elapsed().as_millis() as u64,
                )
                .await?;
            if endpoint.kind == "reader" {
                let article = match run.article(&output.value).await {
                    Ok(article) => article,
                    Err(error) => {
                        run.journal
                            .lock()
                            .unwrap()
                            .fail_call(&output.call_id, &error.code);
                        run.material(
                            &output.call_id,
                            input["url"].as_str().unwrap(),
                            &output.value,
                            None,
                            None,
                        );
                        return Err(error);
                    }
                };
                run.material(
                    &output.call_id,
                    input["url"].as_str().unwrap(),
                    &output.value,
                    Some(&article),
                    None,
                );
                run.article_length(&output.call_id, article.text().chars().count() as u64);
            }
            if endpoint.kind == "model"
                && !crate::scoring::valid_output(task, &output.value, &input)
            {
                run.journal
                    .lock()
                    .unwrap()
                    .fail_call(&output.call_id, "MODEL_FORMAT_INVALID");
                return Err(protocol("MODEL_FORMAT_INVALID"));
            }
            Ok::<_, Error>(success(&context.request_id, json!({"tested":true})))
        };
        let response = match tokio::time::timeout_at(context.deadline, outcome).await {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => error.envelope(&context.request_id, &context.ui_language),
            Err(_) => {
                context.cancel.cancel();
                Error::timeout().envelope(&context.request_id, &context.ui_language)
            }
        };
        run.finish(response).await
    }
}
impl<'a> Run<'a> {
    fn new(engine: &'a Engine, snapshot: &'a Snapshot, context: &'a ExecutionContext) -> Self {
        Self {
            excluded_proxies: Arc::new(Mutex::new(std::collections::HashSet::new())),
            reselections: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            browser_blocked: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            engine,
            snapshot,
            request: &context.request_id,
            lang: &context.ui_language,
            cancel: context.cancel.clone(),
            start: Instant::now(),
            deadline: context.deadline,
            total_deadline: context.deadline,
            journal: Arc::new(Mutex::new(Journal::new())),
            browsers: Arc::new(Mutex::new(Vec::new())),
            browser_active: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            query_context: json!({}),
            parent: None,
        }
    }
    async fn finish(self, mut response: Value) -> Execution {
        let rewrite_fallback = self.journal.lock().unwrap().rewrite_fallback.clone();
        if let Some(reason) = rewrite_fallback.filter(|_| response["error"].is_null()) {
            if response["status"] == "success" {
                response["status"] = json!("partial");
            }
            self.warnings(&mut response, &["query_rewrite_fallback"]);
            if let Some(warning) = response["warnings"]
                .as_array_mut()
                .and_then(|values| values.last_mut())
            {
                warning["details"] = json!({"reason":reason});
            }
        }
        let code = response["error"]["code"]
            .as_str()
            .unwrap_or("UPSTREAM_UNAVAILABLE");
        self.journal
            .lock()
            .unwrap()
            .finalize_pending(code, self.start);
        self.close_browsers().await;
        let mut trace = self.journal.lock().unwrap();
        trace.calls.sort_by(|a, b| {
            a["started_at"]
                .as_str()
                .cmp(&b["started_at"].as_str())
                .then(a["call_id"].as_str().cmp(&b["call_id"].as_str()))
        });
        trace
            .spans
            .sort_by_key(|s| s["span"]["start_offset_ms"].as_u64().unwrap_or(0));
        if let Some(sources) = trace.evidence["sources"].as_array_mut() {
            sources.sort_by_key(|v| number(v["source_id"].as_str().unwrap_or("")));
        }
        if let Some(segments) = trace.evidence["segments"].as_array_mut() {
            segments.sort_by_key(|v| {
                (
                    number(v["source_id"].as_str().unwrap_or("")),
                    number(v["segment_id"].as_str().unwrap_or("")),
                )
            });
        }
        let known = oas_domain::privacy::secrets(&self.snapshot.secrets);
        for value in &mut trace.calls {
            oas_domain::privacy::redact(value, &known);
        }
        for value in &mut trace.spans {
            oas_domain::privacy::redact(value, &known);
        }
        // A second pass at the final persistence boundary covers archive bytes
        // and any full wire replies received after a failed validation.
        for value in &mut trace.materials {
            oas_domain::privacy::redact(value, &known);
        }
        oas_domain::privacy::redact(&mut trace.evidence, &known);
        Execution {
            response,
            calls: std::mem::take(&mut trace.calls),
            spans: std::mem::take(&mut trace.spans),
            evidence: std::mem::take(&mut trace.evidence),
            materials: std::mem::take(&mut trace.materials),
        }
    }

    pub fn fork(&self) -> Self {
        Self {
            excluded_proxies: self.excluded_proxies.clone(),
            reselections: self.reselections.clone(),
            browser_blocked: self.browser_blocked.clone(),
            engine: self.engine,
            snapshot: self.snapshot,
            request: self.request,
            lang: self.lang,
            cancel: self.cancel.clone(),
            start: self.start,
            deadline: self.deadline,
            total_deadline: self.total_deadline,
            journal: self.journal.clone(),
            browsers: self.browsers.clone(),
            browser_active: self.browser_active.clone(),
            query_context: self.query_context.clone(),
            parent: self.parent.clone(),
        }
    }
    pub fn begin(&self, stage: &str, input: Value) -> (String, Instant) {
        let span = format!("{}-{}", stage, id());
        let started = Instant::now();
        self.journal.lock().unwrap().add_span(json!({"span":{"span_id":span,"parent_id":self.parent,"stage":stage,"status":"running","start_offset_ms":self.start.elapsed().as_millis()as u64,"duration_ms":0},"input":input,"output":null,"diagnostics":{},"replay":[],"_pending":true}));
        (span, started)
    }
    pub fn end(&self, span: &str, status: &str, output: Value, started: Instant) {
        self.journal
            .lock()
            .unwrap()
            .finish_span(span, status, output, started);
    }
    pub async fn bounded<T>(&self, future: impl Future<Output = Result<T>>) -> Result<T> {
        tokio::select! {_=self.cancel.cancelled()=>Err(Error::cancelled()),result=tokio::time::timeout_at(self.deadline,future)=>result.unwrap_or_else(|_|Err(self.deadline_error()))}
    }
    pub fn deadline_error(&self) -> Error {
        if tokio::time::Instant::now() >= self.total_deadline {
            Error::timeout()
        } else {
            Error::new(
                "STAGE_BUDGET_EXCEEDED",
                504,
                "本阶段预算已耗尽，剩余时间留给后续阶段。",
                "This stage exhausted its budget; remaining time is reserved for later stages.",
            )
        }
    }
    pub fn model_endpoint(&self) -> Result<&Endpoint> {
        self.snapshot
            .endpoints
            .iter()
            .find(|e| Some(&e.id) == self.snapshot.project.model_endpoint_id.as_ref())
            .ok_or_else(Error::unavailable)
    }
    pub fn evidence(&self, key: &str, value: Value) {
        self.journal.lock().unwrap().evidence[key] = value;
    }
    pub fn warnings(&self, response: &mut Value, reasons: &[&str]) {
        for reason in reasons {
            response["warnings"].as_array_mut().unwrap().push(json!({"code":reason,"message":if self.lang.starts_with("en"){match *reason{"segments_truncated"=>"Some passages exceeded the configured processing limit.","material_budget_exhausted"=>"Some material was skipped to reserve synthesis time.","query_rewrite_fallback"=>"No usable rewritten query was produced; search used the original question.",_=>"Some source material was incomplete."}}else{match *reason{"segments_truncated"=>"部分段落超出处理上限。","material_budget_exhausted"=>"部分材料未处理，已为最终总结保留时间。","query_rewrite_fallback"=>"未取得可用改写，已使用原问题检索。",_=>"部分来源材料未完整参与处理。"}},"details":null}));
        }
    }
    pub fn empty(&self) -> Value {
        let mut value = success(
            self.request,
            json!({"summary":"","sources":[],"citations":[]}),
        );
        value["status"] = json!("empty");
        value
    }
}
pub(crate) fn terminal(error: &Error) -> bool {
    matches!(error.code.as_str(), "CANCELLED" | "DEADLINE_EXCEEDED")
}
pub(crate) fn protocol(code: &str) -> Error {
    Error::new(
        code,
        502,
        "上游未能返回有效材料。",
        "The upstream did not return valid material.",
    )
}

fn number(value: &str) -> usize {
    value.get(1..).and_then(|v| v.parse().ok()).unwrap_or(0)
}

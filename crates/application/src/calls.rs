use crate::{
    BrowserOpen, Dispatch, Invocation,
    engine::{Browser, BrowserSlot, Run, protocol, terminal},
    journal::call_record,
};
use oas_domain::{Command, Endpoint, Error, Hit, Result, article::Article, canonical_url, id};
use oas_runtime::{Lease, Scheduler, Selection, route_reason};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::Arc,
    time::{Duration, Instant},
};

pub(crate) struct CallOutput {
    pub value: Value,
    pub call_id: String,
    pub article: Option<Arc<Article>>,
}
// A switch of search engine shares the original browser invocation's deadline.
struct AttemptWindow {
    deadline: tokio::time::Instant,
    queue_ms: u64,
    retry_engine: bool,
    browser: Option<BrowserSlot>,
}
fn google_budget(available: Duration) -> Duration {
    (available / 2).min(Duration::from_secs(7))
}
impl Run<'_> {
    pub async fn article(&self, value: &Value) -> Result<Arc<Article>> {
        let body = value["body"].as_str().unwrap_or("").to_owned();
        let title = value["title"].as_str().unwrap_or("").to_owned();
        let html = value["media_type"].as_str().unwrap_or("").contains("html");
        self.bounded(crate::cpu::run(&self.cancel, move || {
            let mut article = if html {
                Article::html(&body)?
            } else {
                Article::markdown(&title, &body)?
            };
            if article.title.is_empty() {
                article.title = title;
            }
            Ok(Arc::new(article))
        }))
        .await
    }
    pub fn article_length(&self, call: &str, chars: u64) {
        if let Some(c) = self.journal.lock().unwrap().call(call)
            && c["kind"] == "reader"
        {
            c["retained_chars"] = json!(chars);
        }
    }
    pub fn material(
        &self,
        call: &str,
        url: &str,
        value: &Value,
        article: Option<&Article>,
        source: Option<&str>,
    ) {
        let media = value["media_type"].as_str().unwrap_or("text/markdown");
        let mut material = json!({"material_id":id(),"call_id":call,"kind":"webpage","state":"complete","url":url,"media_type":media,"body":value["archive_body"].as_str().or(value["body"].as_str()).unwrap_or("")});
        if let Some(source) = source {
            material["source_id"] = json!(source);
        }
        if value["archive_incomplete"] == true {
            material["state"] = json!("incomplete");
            material["reason"] = json!("source_byte_limit");
        }
        if let Some(final_url) = value["final_url"].as_str().filter(|s| !s.is_empty()) {
            material["final_url"] = json!(final_url);
        }
        if media.contains("html") {
            material["layout_state"] =
                json!(value["layout"]["state"].as_str().unwrap_or("unavailable"));
            if value["layout"].is_object() {
                material["_layout"] = value["layout"].clone();
            }
        }
        if let Some(article) = article {
            let data = article.data(
                url,
                value["final_url"].as_str(),
                self.snapshot.project.body_limit,
            );
            for key in ["text", "markdown", "lengths", "truncated"] {
                material[key] = data[key].clone();
            }
            material["text"] = json!(article.text());
            material["markdown"] = json!(article.markdown_text());
            material["segment_version"] = json!(oas_domain::model::SEGMENT_VERSION);
        } else {
            material["state"] = json!("incomplete");
            material["reason"] = json!("no_readable_article");
        }
        self.journal.lock().unwrap().materials.push(material);
        if let Some(html) = value["original_html"].as_str().filter(|s| !s.is_empty()) {
            let layout = oas_domain::archive::native_layout(html);
            let mut raw = json!({"material_id":id(),"call_id":call,"kind":"webpage","state":"complete","url":url,"media_type":"text/html","body":html,"layout_state":layout["state"],"_layout":layout});
            if let Some(source) = source {
                raw["source_id"] = json!(source);
            }
            self.journal.lock().unwrap().materials.push(raw);
        }
    }
    pub async fn pool(
        &self,
        kind: &str,
        stage: &str,
        input: Value,
        command: &Command,
    ) -> Result<CallOutput> {
        let mut tried = HashSet::new();
        let mut minimum = 0;
        let mut last = Error::unavailable();
        let mut queued = Instant::now();
        let wait_until = tokio::time::Instant::now() + Duration::from_secs(3);
        let language = command.language.as_deref().unwrap_or_default();
        let query = input["query"].as_str().unwrap_or("");
        loop {
            if self.cancel.is_cancelled() {
                return Err(Error::cancelled());
            }
            if tokio::time::Instant::now() >= self.deadline {
                return Err(self.deadline_error());
            }
            let selection = Selection {
                kind,
                language,
                range: command.time_range.as_deref(),
                query,
                tried: &tried,
                minimum,
            };
            let Some((endpoint, pool, lease)) =
                self.engine.scheduler.choose(self.snapshot, selection)
            else {
                if self.engine.scheduler.eligible(self.snapshot, selection) {
                    if tokio::time::Instant::now() >= wait_until {
                        return Err(oas_runtime::capacity());
                    }
                    self.bounded(async {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        Ok(())
                    })
                    .await?;
                    continue;
                }
                break;
            };
            minimum = pool;
            tried.insert(endpoint.id.clone());
            match self
                .call(
                    &endpoint,
                    stage,
                    &input,
                    Some(pool),
                    lease,
                    queued.elapsed().as_millis() as u64,
                )
                .await
            {
                Ok(mut output) => {
                    if kind == "reader" {
                        match self.article(&output.value).await {
                            Ok(article) => output.article = Some(article),
                            Err(error) => {
                                self.journal
                                    .lock()
                                    .unwrap()
                                    .fail_call(&output.call_id, &error.code);
                                self.material(
                                    &output.call_id,
                                    input["url"].as_str().unwrap_or(""),
                                    &output.value,
                                    None,
                                    None,
                                );
                                if terminal(&error) || error.code == "STAGE_BUDGET_EXCEEDED" {
                                    return Err(error);
                                }
                                last = error;
                                queued = Instant::now();
                                continue;
                            }
                        }
                    }
                    return Ok(output);
                }
                Err(error) => {
                    if terminal(&error)
                        || matches!(
                            error.code.as_str(),
                            "ACCESS_DENIED" | "URL_NOT_ALLOWED" | "STAGE_BUDGET_EXCEEDED"
                        )
                    {
                        return Err(error);
                    }
                    if error.code == "ENDPOINT_RISK_CONTROL"
                        && let Some(until) = self.engine.scheduler.mark_risk(&endpoint)
                    {
                        let _ = self.engine.transport.risk(&endpoint.id, until).await;
                    }
                    last = error;
                    queued = Instant::now();
                }
            }
        }
        if tried.is_empty() && kind == "search" {
            let first = Scheduler::starting_pool(
                &self.snapshot.project,
                &self.snapshot.routes,
                kind,
                language,
            );
            let configured = self
                .snapshot
                .project
                .search_pools
                .iter()
                .skip(first)
                .flatten()
                .filter_map(|id| self.snapshot.endpoints.iter().find(|e| &e.id == id))
                .collect::<Vec<_>>();
            if !configured.is_empty() && configured.iter().all(|e| !e.supports(None, query)) {
                return Err(Error::new(
                    "QUERY_UNSUPPORTED",
                    400,
                    "接入点不支持该问题长度。",
                    "No eligible search endpoint supports the query length.",
                ));
            }
            if command.time_range.is_some()
                && !configured.is_empty()
                && configured
                    .iter()
                    .all(|e| !e.supports(command.time_range.as_deref(), query))
            {
                return Err(Error::new(
                    "TIME_RANGE_UNSUPPORTED",
                    400,
                    "接入点不支持该时间范围。",
                    "No source supports this time range.",
                ));
            }
        }
        Err(last)
    }
    pub async fn call(
        &self,
        endpoint: &Endpoint,
        task: &str,
        input: &Value,
        pool: Option<usize>,
        lease: Lease,
        queue_ms: u64,
    ) -> Result<CallOutput> {
        let browser = endpoint.browser().then(|| self.browser_slot());
        let outcome = async {
            let mut window = AttemptWindow {
                deadline: self.deadline,
                queue_ms,
                retry_engine: false,
                browser: browser.clone(),
            };
            let mut lease = lease;
            loop {
                window.retry_engine = false;
                let outcome = self
                    .call_attempt(endpoint, task, input, pool, lease, &mut window)
                    .await;
                let retry_proxy = outcome
                    .as_ref()
                    .err()
                    .is_some_and(|e| e.details["retry_proxy"] == true);
                if !window.retry_engine && !retry_proxy {
                    return outcome;
                }
                if tokio::time::Instant::now() >= window.deadline {
                    return outcome;
                }
                let queued = Instant::now();
                lease = tokio::time::timeout_at(
                    window.deadline,
                    self.bounded(self.engine.scheduler.endpoint_wait(endpoint, &self.cancel)),
                )
                .await
                .map_err(|_| protocol("UPSTREAM_TIMEOUT"))??;
                window.queue_ms = queued.elapsed().as_millis() as u64;
            }
        }
        .await;
        if let Some(browser) = browser {
            self.close_browser_slot(&browser).await;
        }
        outcome
    }
    async fn call_attempt(
        &self,
        endpoint: &Endpoint,
        task: &str,
        input: &Value,
        pool: Option<usize>,
        lease: Lease,
        window: &mut AttemptWindow,
    ) -> Result<CallOutput> {
        let mut queue_ms = window.queue_ms;
        let (span, started) = self.begin(task, input.clone());
        let prepared = match self
            .bounded(async {
                self.engine.transport.validate(endpoint).await?;
                self.engine.transport.preflight(endpoint, task, input).await
            })
            .await
        {
            Ok(prepared) => prepared,
            Err(error) => {
                self.end(&span, "error", json!({"code":error.code}), started);
                return Err(error);
            }
        };
        let context_wait = Instant::now();
        let mut browser_guard = if let Some(browser) = window.browser.as_ref() {
            match self.bounded(async { Ok(browser.lock().await) }).await {
                Ok(guard) => Some(guard),
                Err(error) => {
                    self.end(&span, "error", json!({"code":error.code}), started);
                    return Err(error);
                }
            }
        } else {
            None
        };
        if endpoint.browser() {
            queue_ms += context_wait.elapsed().as_millis() as u64;
        }
        if endpoint.browser()
            && self
                .browser_blocked
                .load(std::sync::atomic::Ordering::SeqCst)
        {
            let error = oas_runtime::proxy_error();
            self.end(&span, "error", json!({"code":error.code}), started);
            return Err(error);
        }
        let reused_context = browser_guard.as_ref().is_some_and(|g| g.is_some());
        if let Some(guard) = browser_guard.as_mut()
            && guard.is_none()
        {
            let allocation = Instant::now();
            let offset = self.start.elapsed().as_millis() as u64;
            let allocated = self
                .bounded(self.allocate_browser(endpoint.kind == "search"))
                .await;
            let (node, proxy, probe, browser_lease) = match allocated {
                Ok(value) => value,
                Err(error) => {
                    self.end(&span, "error", json!({"code":error.code}), started);
                    return Err(error);
                }
            };
            let waiting = allocation.elapsed().as_millis() as u64;
            queue_ms += waiting;
            let context = Instant::now();
            let job = id();
            self.browser_active
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            **guard = Some(Browser {
                value: json!({"node":node,"job_id":job,"request_id":self.request}),
                lease: Some(browser_lease),
                scheduler: self.engine.scheduler.clone(),
                active: self.browser_active.clone(),
            });
            match self
                .bounded(self.engine.transport.open_browser(BrowserOpen {
                    deadline: self.total_deadline,
                    node: &node,
                    proxy: proxy.as_ref(),
                    probe: probe.as_ref(),
                    snapshot: self.snapshot,
                    request: self.request,
                    job: &job,
                    cancel: &self.cancel,
                }))
                .await
            {
                Ok(value) => {
                    guard.as_mut().unwrap().value = value;
                    guard.as_mut().unwrap().value["diagnostics"]["phases"] = json!([
                        {"stage":"allocate","start_offset_ms":offset,"duration_ms":waiting,"status":"success","source":"api","scope":"job"},
                        {"stage":"context","start_offset_ms":offset+waiting,"duration_ms":context.elapsed().as_millis()as u64,"status":"success","source":"api","scope":"job"}
                    ]);
                }
                Err(error) => {
                    guard.take();
                    self.end(
                        &span,
                        if error.code == "CANCELLED" {
                            "cancelled"
                        } else {
                            "error"
                        },
                        json!({"code":error.code}),
                        started,
                    );
                    return Err(error);
                }
            }
        }
        let session = browser_guard
            .as_ref()
            .and_then(|g| g.as_ref().map(|b| &b.value));
        if endpoint.browser()
            && task == "search"
            && let Some(range) = input["time_range"].as_str()
            && session
                .and_then(|s| s["diagnostics"]["search_engine"].as_str())
                .is_none_or(|engine| {
                    oas_domain::worker::SearchTimeFilter::resolve(engine, range).is_none()
                })
        {
            let error = Error::new(
                "TIME_RANGE_UNSUPPORTED",
                400,
                "所选搜索引擎不支持该时间范围。",
                "The selected engine does not support this time range.",
            );
            self.end(&span, "error", json!({"code":error.code}), started);
            return Err(error);
        }
        let mut record = call_record(
            endpoint,
            self.request,
            &self.snapshot.project.id,
            task,
            input,
        );
        record["queue_ms"] = json!(queue_ms);
        if let Some(pool) = pool {
            record["pool_priority"] = json!(pool + 1);
            record["reason"] = json!(route_reason(
                pool,
                Scheduler::preferred_pool(
                    &self.snapshot.project,
                    &self.snapshot.routes,
                    &endpoint.kind,
                    input["language"].as_str().unwrap_or_default()
                )
            ));
        }
        if let Some(session) = session {
            let mut diagnostics = session["diagnostics"].clone();
            if endpoint.kind == "reader" {
                diagnostics.as_object_mut().unwrap().remove("google_probe");
                diagnostics.as_object_mut().unwrap().remove("search_engine");
                diagnostics
                    .as_object_mut()
                    .unwrap()
                    .remove("engine_fallback");
                diagnostics
                    .as_object_mut()
                    .unwrap()
                    .remove("engine_selection");
            }
            diagnostics["reused_context"] = json!(reused_context);
            record["browser_job"] = diagnostics;
        }
        if let Some(tokens) = prepared.input_tokens {
            record["estimated_input_tokens"] = json!(tokens);
        }
        let dispatch = Dispatch::new(
            self.journal.clone(),
            lease,
            record,
            span.clone(),
            self.cancel.clone(),
        )
        .with_model_input(
            prepared.model_request.clone(),
            (endpoint.kind == "model").then(|| {
                endpoint.options["tokenizer"]
                    .as_str()
                    .unwrap_or("cl100k_base")
                    .to_owned()
            }),
        );
        let now = tokio::time::Instant::now();
        let endpoint_deadline = window
            .deadline
            .min(now + Duration::from_millis(endpoint.timeout_ms));
        let google = task == "search"
            && session.is_some_and(|s| s["diagnostics"]["search_engine"] == "google");
        let available = endpoint_deadline.saturating_duration_since(now);
        let remaining = if google {
            google_budget(available)
        } else {
            available
        };
        let invocation_offset = self.start.elapsed().as_millis() as u64;
        let outcome = if remaining.is_zero() {
            Err(if now >= self.deadline {
                self.deadline_error()
            } else {
                protocol("UPSTREAM_TIMEOUT")
            })
        } else {
            self.bounded(async {
                tokio::time::timeout(
                    remaining,
                    self.engine.transport.invoke(Invocation {
                        timeout: remaining,
                        endpoint,
                        task,
                        prepared: &prepared,
                        snapshot: self.snapshot,
                        session,
                        cancel: &self.cancel,
                        dispatch: &dispatch,
                    }),
                )
                .await
                .unwrap_or_else(|_| {
                    Err(if tokio::time::Instant::now() >= self.deadline {
                        self.deadline_error()
                    } else {
                        protocol("UPSTREAM_TIMEOUT")
                    })
                })
            })
            .await
        };
        let mut outcome = outcome.and_then(|value| {
            if endpoint.kind == "search" {
                oas_domain::search_cards::parse(&value)?;
                let hits: Vec<Hit> = serde_json::from_value(value["hits"].clone())
                    .map_err(|_| protocol("SEARCH_FAILED"))?;
                if !hits.is_empty() && hits.iter().all(|h| canonical_url(&h.url).is_none()) {
                    return Err(protocol("SEARCH_FAILED"));
                }
            }
            Ok(value)
        });
        let status = match &outcome {
            Ok(value)
                if endpoint.kind == "search"
                    && !value["engine_answer"].is_object()
                    && value["cards"].as_array().is_none_or(Vec::is_empty)
                    && value["hits"].as_array().is_some_and(Vec::is_empty) =>
            {
                "empty"
            }
            Ok(value) if value["_partial"] == true => "partial",
            Ok(_) => "success",
            Err(error) if error.code == "CANCELLED" => "cancelled",
            _ => "error",
        };
        dispatch.finish(status, outcome.as_ref().ok());
        if let Err(error) = &outcome {
            dispatch.failure(&error.code);
        }
        if endpoint.browser() && dispatch.was_sent() {
            let raw = match &mut outcome {
                Ok(value) => value
                    .as_object_mut()
                    .and_then(|v| v.remove("_phases"))
                    .unwrap_or(Value::Null),
                Err(error) => error
                    .details
                    .as_object_mut()
                    .and_then(|v| v.remove("_worker_phases"))
                    .unwrap_or(Value::Null),
            };
            self.browser_timing(&dispatch.call_id, invocation_offset, status, &raw);
        }
        let mut projection = outcome
            .as_ref()
            .cloned()
            .unwrap_or_else(|error| json!({"code":error.code}));
        if let Some(object) = projection.as_object_mut() {
            for key in [
                "_model_input",
                "_model_output",
                "archive_body",
                "layout",
                "original_html",
                "_egress",
            ] {
                object.remove(key);
            }
        }
        self.end(&span, status, projection, started);
        let mut outcome = outcome;
        if endpoint.browser() {
            let proxy = session.and_then(|value| {
                value["diagnostics"]["proxy_id"].as_str().map(|id| {
                    (
                        id.to_owned(),
                        value["diagnostics"]["proxy_version"].as_i64().unwrap_or(1),
                    )
                })
            });
            if let Some((proxy, version)) = proxy {
                let successful = outcome
                    .as_ref()
                    .ok()
                    .is_some_and(|v| v["_egress"]["proxy_connected"] == true)
                    || outcome.as_ref().err().is_some_and(|e| {
                        e.details["proxy_connected"] == true && e.details["proxy_failure"].is_null()
                    });
                let state = if successful {
                    self.engine.scheduler.proxy_success(&proxy, version)
                } else if let Err(error) = &outcome
                    && error.code == "PROXY_CONNECTION_FAILED"
                {
                    self.engine.scheduler.proxy_failure(
                        &proxy,
                        version,
                        error.details["proxy_failure"]
                            .as_str()
                            .unwrap_or("proxy_connect"),
                    )
                } else {
                    None
                };
                if let Some(state) = state {
                    let _ = tokio::time::timeout(
                        Duration::from_millis(100),
                        self.engine.transport.proxy_state(&proxy, version, &state),
                    )
                    .await;
                }
                if let Err(error) = &mut outcome
                    && error.code == "PROXY_CONNECTION_FAILED"
                    && error.details["target_submitted"] == false
                {
                    self.excluded_proxies.lock().unwrap().insert(proxy);
                    if self
                        .reselections
                        .fetch_update(
                            std::sync::atomic::Ordering::SeqCst,
                            std::sync::atomic::Ordering::SeqCst,
                            |v| (v < 1).then_some(v + 1),
                        )
                        .is_ok()
                    {
                        error.details["retry_proxy"] = json!(true);
                        if let Some(guard) = browser_guard.as_mut()
                            && let Some(mut browser) = guard.take()
                        {
                            let timeout = self
                                .deadline
                                .saturating_duration_since(tokio::time::Instant::now())
                                .min(Duration::from_secs(3));
                            if matches!(
                                tokio::time::timeout(
                                    timeout,
                                    self.engine.transport.close_browser(&browser.value)
                                )
                                .await,
                                Ok(Ok(()))
                            ) {
                                browser.lease.take();
                            } else {
                                self.browser_blocked
                                    .store(true, std::sync::atomic::Ordering::SeqCst);
                                error.details["retry_proxy"] = json!(false);
                            }
                        }
                    }
                }
            }
        }
        if google
            && dispatch.was_sent()
            && !self.cancel.is_cancelled()
            && let Err(error) = &outcome
            && matches!(
                error.code.as_str(),
                "ENDPOINT_RISK_CONTROL"
                    | "SEARCH_ENGINE_UNAVAILABLE"
                    | "SEARCH_RESULTS_UNAVAILABLE"
                    | "UPSTREAM_TIMEOUT"
            )
            && let Some(browser) = browser_guard.as_mut().and_then(|guard| guard.as_mut())
        {
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                self.engine
                    .transport
                    .search_engine_failed(&browser.value, &error.code),
            )
            .await;
            // The logical query retains its job and egress across engine fallback;
            // sibling queries use independent jobs and can run concurrently.
            let diagnostics = &mut browser.value["diagnostics"];
            diagnostics["search_engine"] = json!("baidu");
            diagnostics["engine_fallback"] =
                json!({"from":"google","reason":error.code,"call_id":dispatch.call_id});
            window.deadline = endpoint_deadline;
            window.retry_engine = true;
        }
        outcome.map(|value| CallOutput {
            value,
            call_id: dispatch.call_id.clone(),
            article: None,
        })
    }
}

#[cfg(test)]
mod engine_budget_tests {
    use super::*;
    #[test]
    fn google_leaves_time_for_baidu_within_the_same_deadline() {
        for (available, expected) in [
            (0, 0),
            (500, 250),
            (4000, 2000),
            (8000, 4000),
            (30000, 7000),
        ] {
            assert_eq!(
                google_budget(Duration::from_millis(available)),
                Duration::from_millis(expected)
            );
        }
    }
}

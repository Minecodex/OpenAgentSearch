use crate::repository::Repository;
use async_trait::async_trait;
use oas_application::{BrowserOpen, Dispatch, Invocation, PreparedInvocation, Transport};
use oas_domain::{Endpoint, Error, Hit, Result, Snapshot, WorkerNode, id, worker::WorkerCommand};
use reqwest::{Client, Response};
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Clone)]
pub struct Providers {
    pub client: Client,
    pub repo: Repository,
    pub worker_key: String,
    pub owner: String,
}
impl Providers {
    pub async fn cleanup_job(&self, node: &WorkerNode, job: &str, owner: &str) -> Result<()> {
        let command = WorkerCommand {
            job_id: job.into(),
            request_id: job.into(),
            owner: owner.into(),
            pod_uid: node.uid.clone(),
            action: "cancel".into(),
            deadline_ms: 5000,
            url: None,
            query: None,
            language: None,
            time_range: None,
            engine: None,
            count: 0,
            proxy: None,
        };
        if let Err(error) = self.worker(&node.address, &command).await
            && !crate::discovery::pod_gone(node).await
        {
            return Err(error);
        }
        sqlx::query("DELETE FROM browser_jobs WHERE id=$1 AND owner=$2")
            .bind(uuid::Uuid::parse_str(job).map_err(|_| Error::internal())?)
            .bind(owner)
            .execute(&self.repo.pool)
            .await
            .map_err(|_| Error::internal())?;
        Ok(())
    }
    pub async fn recover(&self, scheduler: &oas_runtime::Scheduler) -> Result<()> {
        use sqlx::Row;
        let rows = sqlx::query("SELECT id,owner,body FROM browser_jobs")
            .fetch_all(&self.repo.pool)
            .await
            .map_err(|_| Error::internal())?;
        for row in rows {
            let body: Value = row.get("body");
            let node: WorkerNode =
                serde_json::from_value(body["node"].clone()).map_err(|_| Error::internal())?;
            scheduler.recover_job(
                node,
                row.get::<uuid::Uuid, _>("id").to_string(),
                row.get("owner"),
                body["proxy_id"].as_str(),
            );
        }
        Ok(())
    }
    pub fn new(repo: Repository, key: String) -> Result<Self> {
        let client = Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(45))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| Error::internal())?;
        Ok(Self {
            client,
            repo,
            worker_key: key,
            owner: id(),
        })
    }
    pub async fn worker(&self, node: &str, command: &WorkerCommand) -> Result<Value> {
        self.worker_dispatch(node, command, None).await
    }
    async fn worker_dispatch(
        &self,
        node: &str,
        command: &WorkerCommand,
        dispatch: Option<&Dispatch>,
    ) -> Result<Value> {
        let request = self
            .client
            .post(format!("{}/internal/jobs", node.trim_end_matches('/')))
            .timeout(Duration::from_millis(
                command.deadline_ms.saturating_add(1000).min(45000),
            ))
            .bearer_auth(&self.worker_key)
            .json(command)
            .build()
            .map_err(|_| Error::internal())?;
        if let Some(dispatch) = dispatch {
            dispatch.sent()?;
        }
        let response = self
            .client
            .execute(request)
            .await
            .map_err(|_| upstream("SERVICE_UNAVAILABLE", 503))?;
        decode_observed(response, 64 * 1024 * 1024, None, true).await
    }
    async fn native(
        &self,
        e: &Endpoint,
        task: &str,
        input: &Value,
        snapshot: &Snapshot,
        prepared: &PreparedInvocation,
        dispatch: &Dispatch,
    ) -> Result<Value> {
        let base = e
            .base_url
            .as_deref()
            .ok_or_else(Error::unavailable)?
            .trim_end_matches('/');
        let base = if e.provider == "deepseek" {
            base.strip_suffix("/v1").unwrap_or(base)
        } else {
            base
        };
        let key = snapshot
            .secrets
            .get(&e.id)
            .and_then(|s| s["api_key"].as_str())
            .unwrap_or("");
        let query = input["query"].as_str().unwrap_or("");
        let url = input["url"].as_str().unwrap_or("");
        let count = input["count"].as_u64().unwrap_or(10).min(10);
        let inline_body =
            e.adapter == "integrated_search" && !snapshot.project.summary_snippets_only;
        let mut request=match(e.provider.as_str(),task){
            ("tavily","search")=>{
                let mut data=json!({"query":query,"max_results":count,"include_raw_content":inline_body,"include_answer":false});
                if input["time_range"].is_string(){data["time_range"]=input["time_range"].clone();}
                self.client.post(format!("{base}/search")).json(&data)
            },
            ("tavily","extract")=>self.client.post(format!("{base}/extract")).json(&json!({"urls":[url],"format":"markdown"})),
            ("anysearch","search")=>{
                let mut body=json!({"query":query,"max_results":count});
                if let Some(language)=input["language"].as_str(){body["language"]=json!(language);}
                self.client.post(format!("{base}/v1/search")).json(&body)
            },
            ("anysearch","extract")=>self.client.post(format!("{base}/v1/extract")).json(&json!({"url":url})),
            ("deepseek","search")=>self.client.post(format!("{base}/v1/tools/search")).json(&json!({"query":query,"count":count,"need_content":inline_body})),
            ("deepseek","extract")=>self.client.post(format!("{base}/v1/tools/fetch")).json(&json!({"url":url})),
            ("searxng","search")=>{
                let mut req=self.client.get(format!("{base}/search")).query(&[("q",query),("format","json")]);
                for param in ["language","time_range"]{if let Some(value)=input[param].as_str(){req=req.query(&[(param,value)]);}}
                if let Some(engines)=e.options["engines"].as_array().filter(|engines|!engines.is_empty()){req=req.query(&[("engines",engines.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(","))]);}req
            },
            ("crawl4ai","extract")=>self.client.post(format!("{base}/crawl")).json(&json!({"urls":[url],"browser_config":{"type":"BrowserConfig","params":{}},"crawler_config":{"type":"CrawlerRunConfig","params":{"cache_mode":"bypass"}}})),
            ("openai_compatible",_)=>return self.model(e,prepared,key,dispatch).await,
            _=>return Err(upstream("SERVICE_UNAVAILABLE",503))
        };
        if !key.is_empty() {
            request = request.bearer_auth(key);
        }
        let request = request
            .timeout(Duration::from_millis(e.timeout_ms))
            .build()
            .map_err(|_| Error::invalid("base_url"))?;
        dispatch.sent()?;
        let response = self.client.execute(request).await.map_err(|_| {
            upstream(
                if task == "search" {
                    "SEARCH_FAILED"
                } else {
                    "CONTENT_UNAVAILABLE"
                },
                502,
            )
        })?;
        if task == "extract" && e.provider == "deepseek" && response.status().as_u16() == 403 {
            return Err(upstream("ACCESS_DENIED", 502));
        }
        let data = decode(response).await?;
        if data["code"].as_i64().is_some_and(|n| n != 0) {
            return Err(upstream("UPSTREAM_BUSINESS_ERROR", 502));
        }
        if task == "search" {
            let searx_incomplete = e.provider == "searxng"
                && data["unresponsive_engines"]
                    .as_array()
                    .is_some_and(|v| !v.is_empty());
            if searx_incomplete && data["results"].as_array().is_some_and(Vec::is_empty) {
                return Err(upstream("SEARCH_FAILED", 502));
            }
            let rows = match e.provider.as_str() {
                "anysearch" => &data["data"]["results"],
                _ => &data["results"],
            };
            let rows = rows
                .as_array()
                .ok_or_else(|| upstream("SEARCH_FAILED", 502))?;
            let hits = rows
                .iter()
                .take(count as usize)
                .filter_map(|row| {
                    let url = row["url"].as_str()?.to_owned();
                    let content = if inline_body {
                        row["raw_content"]
                            .as_str()
                            .or(row["content"].as_str())
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned)
                    } else {
                        None
                    };
                    Some(Hit {
                        url,
                        title: row["title"].as_str().unwrap_or("").into(),
                        snippet: row["snippet"]
                            .as_str()
                            .or(row["content"].as_str())
                            .or(row["summary"].as_str())
                            .unwrap_or("")
                            .into(),
                        content,
                        rank: 0,
                        variant_id: String::new(),
                        call_id: String::new(),
                    })
                })
                .collect::<Vec<_>>();
            if !rows.is_empty() && hits.is_empty() {
                return Err(upstream("SEARCH_FAILED", 502));
            }
            Ok(
                json!({"hits":hits,"_partial":searx_incomplete||hits.len()<rows.len().min(count as usize)}),
            )
        } else {
            if e.provider == "tavily" && data["results"].as_array().is_none_or(Vec::is_empty) {
                let denied = data["failed_results"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|row| {
                        let reason = row["error"].as_str().unwrap_or("").to_ascii_lowercase();
                        reason.contains("403")
                            || reason.contains("access denied")
                            || reason.contains("blocked by site")
                    });
                if denied {
                    return Err(upstream("ACCESS_DENIED", 502));
                }
            }
            let row = match e.provider.as_str() {
                "tavily" => data["results"]
                    .as_array()
                    .and_then(|a| a.first())
                    .cloned()
                    .ok_or_else(|| upstream("CONTENT_UNAVAILABLE", 502))?,
                "anysearch" => data["data"].clone(),
                "crawl4ai" => {
                    let row = data["results"]
                        .as_array()
                        .and_then(|a| a.first())
                        .cloned()
                        .ok_or_else(|| upstream("CONTENT_UNAVAILABLE", 502))?;
                    if row["status_code"] == 401 || row["status_code"] == 403 {
                        return Err(upstream("ACCESS_DENIED", 502));
                    }
                    if row["success"] != true {
                        return Err(upstream("CONTENT_UNAVAILABLE", 502));
                    }
                    row
                }
                _ => data.clone(),
            };
            let body = row["raw_content"]
                .as_str()
                .or(row["content"].as_str())
                .or(row["markdown"].as_str())
                .or(row["markdown"]["raw_markdown"].as_str())
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| upstream("CONTENT_UNAVAILABLE", 502))?;
            let media = if e.provider == "anysearch"
                && (e.options["format"] == "html"
                    || (body.trim_start().starts_with('<')
                        && !body
                            .trim_start()
                            .split('>')
                            .next()
                            .unwrap_or("")
                            .contains("://")))
            {
                "text/html"
            } else {
                "text/markdown"
            };
            let mut output = json!({"body":body,"media_type":media,"title":row["title"].as_str().or(row["metadata"]["title"].as_str()).unwrap_or("")});
            if media == "text/html" {
                output["layout"] = oas_domain::archive::native_layout(body);
            } else if let Some(html) = row["html"].as_str().filter(|s| !s.is_empty()) {
                output["original_html"] = json!(html);
                output["layout"] = oas_domain::archive::native_layout(html);
            }
            if let Some(final_url) = row["redirected_url"].as_str().or(row["final_url"].as_str()) {
                output["final_url"] = json!(final_url);
            }
            Ok(output)
        }
    }
    async fn model(
        &self,
        e: &Endpoint,
        prepared: &PreparedInvocation,
        key: &str,
        dispatch: &Dispatch,
    ) -> Result<Value> {
        let payload = prepared
            .model_request
            .as_ref()
            .ok_or_else(Error::internal)?;
        let mut req = self
            .client
            .post(format!(
                "{}/chat/completions",
                e.base_url.as_ref().unwrap().trim_end_matches('/')
            ))
            .json(&payload);
        if !key.is_empty() {
            req = req.bearer_auth(key);
        }
        let request = req
            .timeout(Duration::from_millis(e.timeout_ms))
            .build()
            .map_err(|_| Error::invalid("base_url"))?;
        dispatch.sent()?;
        let raw = decode_observed(
            self.client
                .execute(request)
                .await
                .map_err(|_| upstream("MODEL_FAILED", 502))?,
            16 * 1024 * 1024,
            Some(dispatch),
            false,
        )
        .await?;
        let text = raw["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| upstream("MODEL_FORMAT_INVALID", 502))?;
        let parsed = serde_json::from_str::<Value>(
            text.trim()
                .trim_start_matches("```json")
                .trim_end_matches("```")
                .trim(),
        );
        let mut parsed = parsed
            .ok()
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({"_format_error":true}));
        parsed["_model_input"] = payload.clone();
        parsed["_usage"] = json!({"input_tokens":raw["usage"]["prompt_tokens"],"output_tokens":raw["usage"]["completion_tokens"]});
        parsed["_model_output"] = raw;
        Ok(parsed)
    }
}
#[async_trait]
impl Transport for Providers {
    async fn validate(&self, e: &Endpoint) -> Result<()> {
        let current = self.repo.resource("endpoints", &e.id).await?;
        if current["version"].as_i64() != Some(e.version)
            || (!e.browser() && current["availability"] != "available")
        {
            return Err(Error::new(
                "ENDPOINT_CONFIGURATION_CHANGED",
                503,
                "接入点配置已变化，请重试。",
                "The endpoint configuration changed. Retry with a new snapshot.",
            ));
        }
        Ok(())
    }
    async fn preflight(
        &self,
        e: &Endpoint,
        task: &str,
        input: &Value,
    ) -> Result<PreparedInvocation> {
        if task == "extract" {
            validate_target(input["url"].as_str().unwrap_or("")).await?;
        }
        oas_application::prepare(e, task, input).await
    }
    async fn invoke(&self, invocation: Invocation<'_>) -> Result<Value> {
        let Invocation {
            timeout,
            endpoint: e,
            task,
            prepared,
            snapshot,
            session,
            cancel,
            dispatch,
        } = invocation;
        let input = &prepared.input;
        if e.browser() {
            let session = session.ok_or_else(Error::unavailable)?;
            let command = WorkerCommand {
                job_id: session["job_id"].as_str().unwrap().into(),
                request_id: session["request_id"].as_str().unwrap().into(),
                owner: self.owner.clone(),
                pod_uid: session["node"]["uid"].as_str().unwrap().into(),
                action: task.into(),
                // Reserve control-channel time to deliver the worker's terminal receipt.
                deadline_ms: (timeout - (timeout / 10).min(Duration::from_millis(250))).as_millis()
                    as u64,
                url: input["url"].as_str().map(str::to_owned),
                query: input["query"].as_str().map(str::to_owned),
                language: input["language"].as_str().map(str::to_owned),
                time_range: input["time_range"].as_str().map(str::to_owned),
                engine: session["diagnostics"]["search_engine"]
                    .as_str()
                    .map(str::to_owned),
                count: input["count"].as_u64().unwrap_or(10) as usize,
                proxy: None,
            };
            tokio::select! {_=cancel.cancelled()=>Err(Error::cancelled()),r=self.worker_dispatch(session["node"]["address"].as_str().unwrap(),&command,Some(dispatch))=>r}
        } else {
            tokio::select! {_=cancel.cancelled()=>Err(Error::cancelled()),value=self.native(e,task,input,snapshot,prepared,dispatch)=>value}
        }
    }
    async fn open_browser(&self, open: BrowserOpen<'_>) -> Result<Value> {
        let BrowserOpen {
            node,
            proxy,
            probe,
            snapshot,
            request,
            job,
            deadline,
            ..
        } = open;
        let job = job.to_owned();
        let mut proxy = proxy.cloned();
        if let Some(p) = &proxy {
            let current = self
                .repo
                .resource("proxies", p["id"].as_str().unwrap())
                .await?;
            if current["enabled"] != true || current["version"] != p["version"] {
                return Err(oas_runtime::proxy_error());
            }
        }
        if let Some(p) = &mut proxy
            && let Some(secret) = snapshot.secrets.get(p["id"].as_str().unwrap())
        {
            p["secret"] = secret.clone();
        }
        let engine_selection = if probe.is_some_and(|p| p["reachable"] == true) {
            self.google_cooldown(proxy.as_ref()).await?
        } else {
            None
        };
        let command = WorkerCommand {
            job_id: job.clone(),
            request_id: request.into(),
            owner: self.owner.clone(),
            pod_uid: node.uid.clone(),
            action: "open".into(),
            deadline_ms: deadline
                .saturating_duration_since(tokio::time::Instant::now())
                .as_millis()
                .min(45_000) as u64,
            url: None,
            query: None,
            language: None,
            time_range: None,
            engine: probe.and_then(|p| p["reachable"].as_bool()).map(|ok| {
                if ok && engine_selection.is_none() {
                    "google".into()
                } else {
                    "baidu".into()
                }
            }),
            count: 0,
            proxy: proxy.clone(),
        };
        sqlx::query("INSERT INTO browser_jobs(id,pod_uid,owner,body,state) VALUES($1,$2,$3,$4,'opening') ON CONFLICT DO NOTHING")
            .bind(uuid::Uuid::parse_str(&job).map_err(|_|Error::internal())?).bind(&node.uid).bind(&self.owner).bind(json!({"node":node,"request_id":request,"proxy_id":proxy.as_ref().and_then(|p|p["id"].as_str())})).execute(&self.repo.pool).await.map_err(|_|Error::internal())?;
        self.worker(&node.address, &command).await?;
        sqlx::query("UPDATE browser_jobs SET state='open' WHERE id=$1 AND owner=$2")
            .bind(uuid::Uuid::parse_str(&job).unwrap())
            .bind(&self.owner)
            .execute(&self.repo.pool)
            .await
            .map_err(|_| Error::internal())?;
        let mut diagnostics = json!({"job_id":job,"pod_name":node.name,"pod_uid":node.uid,"egress_mode":if proxy.is_some(){"proxy"}else{"default_network"},"phases":[]});
        if let Some(p) = &proxy {
            if let Some(pool) = snapshot
                .pools
                .iter()
                .find(|p| snapshot.project.browser_proxy_pool_id.as_deref() == p["id"].as_str())
            {
                diagnostics["pool_id"] = pool["id"].clone();
                diagnostics["pool_name"] = pool["name"].clone();
            }
            for (field, value) in [
                ("proxy_id", p["id"].clone()),
                ("proxy_name", p["name"].clone()),
                ("proxy_version", p["version"].clone()),
                ("scheme", p["scheme"].clone()),
            ] {
                diagnostics[field] = value;
            }
        }
        if let Some(probe) = probe.filter(|p| p["reachable"].is_boolean()) {
            diagnostics["google_probe"] = probe.clone();
            diagnostics["search_engine"] = json!(if probe["reachable"] == true {
                "google"
            } else {
                "baidu"
            });
        }
        if let Some(selection) = engine_selection {
            diagnostics["search_engine"] = json!("baidu");
            diagnostics["engine_selection"] = selection;
        }
        Ok(json!({"job_id":job,"request_id":request,"node":node,"diagnostics":diagnostics}))
    }
    async fn search_engine_failed(&self, session: &Value, reason: &str) -> Result<()> {
        self.remember_google_failure(session, reason).await
    }
    async fn close_browser(&self, session: &Value) -> Result<()> {
        let cmd = WorkerCommand {
            job_id: session["job_id"].as_str().unwrap().into(),
            request_id: session["request_id"].as_str().unwrap().into(),
            owner: self.owner.clone(),
            pod_uid: session["node"]["uid"].as_str().unwrap().into(),
            action: "close".into(),
            deadline_ms: 5000,
            url: None,
            query: None,
            language: None,
            time_range: None,
            engine: None,
            count: 0,
            proxy: None,
        };
        self.worker(session["node"]["address"].as_str().unwrap(), &cmd)
            .await?;
        sqlx::query("DELETE FROM browser_jobs WHERE id=$1 AND owner=$2")
            .bind(uuid::Uuid::parse_str(&cmd.job_id).map_err(|_| Error::internal())?)
            .bind(&self.owner)
            .execute(&self.repo.pool)
            .await
            .map_err(|_| Error::internal())?;
        Ok(())
    }
    async fn proxy_state(&self, id: &str, version: i64, state: &Value) -> Result<()> {
        self.repo.proxy_state(id, version, state).await
    }
    async fn risk(&self, id: &str, until: i64) -> Result<()> {
        self.repo.risk(id, until).await
    }
}
pub async fn decode(response: Response) -> Result<Value> {
    decode_limit(response, 16 * 1024 * 1024).await
}
async fn decode_limit(response: Response, limit: usize) -> Result<Value> {
    decode_observed(response, limit, None, false).await
}
async fn decode_observed(
    response: Response,
    limit: usize,
    observer: Option<&Dispatch>,
    worker: bool,
) -> Result<Value> {
    use futures::StreamExt;
    let status = response.status().as_u16();
    let ok = response.status().is_success();
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => {
                if let Some(observer) = observer {
                    observer
                        .model_reply(json!({"raw_body":String::from_utf8_lossy(&bytes)}), false);
                }
                return Err(upstream("UPSTREAM_UNAVAILABLE", 502));
            }
        };
        if bytes.len() + chunk.len() > limit {
            if let Some(observer) = observer {
                observer.model_reply(json!({"raw_body":String::from_utf8_lossy(&bytes)}), false);
            }
            return Err(upstream("UPSTREAM_PAYLOAD_TOO_LARGE", 502));
        }
        bytes.extend_from_slice(&chunk);
    }
    let value = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
    if let Some(observer) = observer {
        observer.model_reply(
            if value.is_null() {
                json!({"raw_body":String::from_utf8_lossy(&bytes)})
            } else {
                value.clone()
            },
            true,
        );
    }
    let phases = value["details"]["phases"].clone();
    let worker_code = value["code"].as_str();
    let result = if worker
        && !ok
        && matches!(
            worker_code,
            Some(
                "SEARCH_ENGINE_UNAVAILABLE"
                    | "SEARCH_RESULTS_UNAVAILABLE"
                    | "CONTENT_UNAVAILABLE"
                    | "UPSTREAM_TIMEOUT"
                    | "CANCELLED"
            )
        ) {
        Err(if worker_code == Some("CANCELLED") {
            Error::cancelled()
        } else {
            upstream(worker_code.unwrap(), 502)
        })
    } else {
        classify(value, status, ok)
    };
    result.map_err(|mut error| {
        if worker && phases.is_array() {
            if !error.details.is_object() {
                error.details = Box::new(json!({}));
            }
            error.details["_worker_phases"] = phases;
            error.details.as_object_mut().unwrap().remove("phases");
        }
        error
    })
}
fn classify(value: Value, status: u16, ok: bool) -> Result<Value> {
    let code = value["error"]["code"]
        .as_str()
        .or(value["error_code"].as_str())
        .or(value["code"].as_str())
        .unwrap_or("");
    if [
        "risk_control",
        "ENDPOINT_RISK_CONTROL",
        "risk_controlled",
        "account_risk_control",
        "captcha_required",
    ]
    .contains(&code)
    {
        return Err(upstream("ENDPOINT_RISK_CONTROL", 502));
    }
    if ["PROXY_CONNECTION_FAILED", "URL_NOT_ALLOWED"].contains(&code) {
        let mut error = upstream(code, if code == "URL_NOT_ALLOWED" { 400 } else { 503 });
        error.details = Box::new(value["details"].clone());
        return Err(error);
    }
    if value["detail"]
        .as_str()
        .is_some_and(|v| v.starts_with("URL blocked"))
    {
        return Err(upstream("URL_NOT_ALLOWED", 400));
    }
    if code == "ACCESS_DENIED" {
        return Err(upstream("ACCESS_DENIED", 502));
    }
    if !ok {
        return Err(match status {
            429 => upstream("UPSTREAM_RATE_LIMITED", 502),
            401 | 402 => upstream("UPSTREAM_CREDENTIALS_INVALID", 502),
            403 => upstream("UPSTREAM_FORBIDDEN", 502),
            _ => upstream("UPSTREAM_UNAVAILABLE", 502),
        });
    }
    if value.is_null() {
        return Err(upstream("UPSTREAM_PROTOCOL_ERROR", 502));
    }
    Ok(value)
}
fn upstream(code: &str, status: u16) -> Error {
    Error::new(
        code,
        status,
        "上游服务未能完成本次调用。",
        "The upstream service could not complete this call.",
    )
}
async fn validate_target(raw: &str) -> Result<()> {
    let url = url::Url::parse(raw).map_err(|_| Error::invalid("url"))?;
    let host = url.host_str().ok_or_else(|| Error::invalid("url"))?;
    let allow = std::env::var("OAS_EGRESS_ALLOW_HOSTS").unwrap_or_default();
    if allow.split(',').any(|v| v == host) {
        return Ok(());
    }
    let deny = || {
        Error::new(
            "URL_NOT_ALLOWED",
            400,
            "该网页地址不在允许的公开网络范围内。",
            "The page is outside the allowed public network.",
        )
    };
    let mut addresses = tokio::net::lookup_host((host, url.port_or_known_default().unwrap_or(443)))
        .await
        .map_err(|_| deny())?;
    if addresses.any(|a| !oas_domain::validation::public_ip(a.ip())) {
        return Err(deny());
    }
    Ok(())
}

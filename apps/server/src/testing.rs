use crate::App;
use chrono::Utc;
use oas_adapters::repository::missing;
use oas_application::engine::{Execution, ExecutionContext};
use oas_domain::{Endpoint, Error, Project, RequestStart, Result, Snapshot, id};
use serde_json::{Value, json};
use std::{collections::HashMap, time::Instant};
use tokio_util::sync::CancellationToken;

pub async fn resource_test(
    app: &App,
    kind: &str,
    rid: &str,
    client_id: Option<&str>,
) -> Result<Value> {
    let request = client_id
        .filter(|s| uuid::Uuid::parse_str(s).is_ok())
        .map(str::to_owned)
        .unwrap_or_else(id);
    let token = CancellationToken::new();
    let _disconnect = token.clone().drop_guard();
    if !app.scheduler.register(&request, None, token.clone()) {
        return Err(Error::new(
            "REQUEST_CONFLICT",
            409,
            "请求标识已被使用。",
            "The request ID is already in use.",
        ));
    }
    let app = app.clone();
    let kind = kind.to_owned();
    let rid = rid.to_owned();
    tokio::spawn(async move {
        let _registration = crate::http::Registration {
            scheduler: app.scheduler.clone(),
            request: request.clone(),
        };
        inner(&app, &kind, &rid, &request, &token).await
    })
    .await
    .map_err(|_| Error::internal())?
}
async fn inner(
    app: &App,
    kind: &str,
    rid: &str,
    request: &str,
    cancel: &CancellationToken,
) -> Result<Value> {
    if !["endpoints", "proxies"].contains(&kind) {
        return Err(missing());
    }
    let (resource, frozen_secret) = app.repo.test_snapshot(kind, rid).await?;
    if resource["availability"]
        .as_str()
        .is_some_and(|v| v != "available" && v != "no_ready_pods")
    {
        return Err(Error::unavailable());
    }
    if kind == "proxies" {
        let _ = app.scheduler.proxy_view(&resource);
    }
    let operation = match resource["kind"].as_str() {
        Some("reader") => "content",
        Some("model") => "summary",
        _ if kind == "proxies" => "content",
        _ => "list",
    };
    let language = "en";
    let draft = RequestStart {
        id: request.into(),
        project: None,
        operation: operation.into(),
        origin: if kind == "proxies" {
            "proxy_test"
        } else {
            "endpoint_test"
        }
        .into(),
        language: Some(language.to_owned()),
        input: json!({"resource_id":rid,"resource_name":resource["name"]}),
        started_at: Utc::now(),
        retention_days: 7,
        retention_version: 1,
        snapshot: Value::Null,
    };
    let start = app.repo.start(&draft).await?;
    let before = Instant::now();
    let mut secrets = HashMap::new();
    if let Some(secret) = frozen_secret {
        secrets.insert(rid.to_owned(), secret);
    }
    let mut execution = if kind == "endpoints" {
        let endpoint: Endpoint =
            serde_json::from_value(resource.clone()).map_err(|_| Error::internal())?;
        let project: Project = serde_json::from_value(
            json!({"id":id(),"name":"Capability test","search_pools":[],"reader_pools":[]}),
        )
        .unwrap();
        let mut probes = HashMap::new();
        if let Some(probe) = sqlx::query_scalar::<_, Value>(
            "SELECT body-'_next_due_at' FROM probes WHERE egress_id='default_network'",
        )
        .fetch_optional(&app.repo.pool)
        .await
        .map_err(|_| Error::internal())?
        {
            probes.insert("default_network".into(), probe);
        }
        let snapshot = Snapshot {
            project,
            endpoints: vec![endpoint.clone()],
            proxies: vec![],
            pools: vec![],
            routes: json!({"entries":[]}),
            secrets,
            probes,
            retention_days: start.retention_days,
            retention_version: start.retention_version,
        };
        let (task, input) = match endpoint.kind.as_str() {
            "reader" => (
                "extract",
                json!({"url":std::env::var("OAS_CAPABILITY_TEST_URL").unwrap_or_else(|_|"https://example.com/".into()),"language":language}),
            ),
            "model" => (
                "segments",
                json!({"query":"test","language":language,"source_id":"s1","segment_id":"p1","text":"A rain gauge measures rainfall."}),
            ),
            _ => (
                "search",
                json!({"query":"weather","language":language,"count":1}),
            ),
        };
        app.engine
            .test(
                endpoint,
                task,
                input,
                snapshot,
                ExecutionContext {
                    request_id: request.into(),
                    ui_language: language.into(),
                    cancel: cancel.clone(),
                    deadline: tokio::time::Instant::now()
                        + std::time::Duration::from_secs(match operation {
                            "list" => 15,
                            "content" => 15,
                            _ => 45,
                        }),
                },
            )
            .await
    } else {
        proxy_execution(app, &resource, &secrets, rid, &start, cancel, before).await
    };
    let reason = execution.response["error"]["code"].as_str();
    let mut receipt = json!({"resource_version":resource["version"],"status":if reason.is_none(){"success"}else{"error"},"started_at":start.started_at,"tested_at":Utc::now(),"elapsed_ms":before.elapsed().as_millis()as u64,"reason":reason,"trace_request_id":request});
    if resource["adapter"] == "browser_search" {
        receipt["search_attempts"] = json!(
            execution
                .calls
                .iter()
                .filter(|c| c["sent"] == true)
                .filter_map(|c| {
                    c["browser_job"]["search_engine"].as_str().map(|engine|json!({
                "engine":engine,"status":c["status"],"reason":c["error_code"],"call_id":c["call_id"]
            }))
                })
                .collect::<Vec<_>>()
        );
    }
    if let Some(details) = execution
        .spans
        .iter()
        .find_map(|s| s["diagnostics"].get("probe"))
        .cloned()
    {
        receipt["diagnostics"] = details;
    }
    let _=sqlx::query("UPDATE resources SET body=jsonb_set(body,'{last_test}',$3) WHERE id=$1 AND version=$2 AND (body->'last_test'->>'started_at' IS NULL OR (body->'last_test'->>'started_at')::timestamptz<=$4)").bind(uuid::Uuid::parse_str(rid).unwrap()).bind(resource["version"].as_i64().unwrap()).bind(&receipt).bind(start.started_at).execute(&app.repo.pool).await;
    if kind == "proxies" {
        let state = match receipt["diagnostics"]["proxy_healthy"].as_bool() {
            Some(true) => app
                .scheduler
                .proxy_success(rid, resource["version"].as_i64().unwrap()),
            Some(false) => app.scheduler.proxy_failure(
                rid,
                resource["version"].as_i64().unwrap(),
                receipt["diagnostics"]["failure_kind"]
                    .as_str()
                    .unwrap_or("proxy_protocol"),
            ),
            None => None,
        };
        if let Some(state) = state {
            let _ = app
                .repo
                .proxy_state(rid, resource["version"].as_i64().unwrap(), &state)
                .await;
        }
    }
    execution.response = oas_domain::success(request, receipt.clone());
    app.repo
        .finish(&start, execution, before.elapsed().as_millis() as u64)
        .await?;
    Ok(receipt)
}

async fn proxy_execution(
    app: &App,
    resource: &Value,
    secrets: &HashMap<String, Value>,
    rid: &str,
    start: &RequestStart,
    cancel: &CancellationToken,
    before: Instant,
) -> Execution {
    let request = start.id.as_str();
    let language = start.language.as_deref().unwrap_or("en");
    let outcome=async{
        let _permit=app.scheduler.admission(cancel).await?;
        let node=app.scheduler.workers().first().cloned().ok_or_else(Error::unavailable)?;
        let mut proxy=resource.clone();if let Some(secret)=secrets.get(rid){proxy["secret"]=secret.clone();}
        let response=app.providers.client.post(format!("{}/internal/probe",node.address)).bearer_auth(&app.providers.worker_key).json(&json!({"proxy":proxy,"capability_test":true})).timeout(std::time::Duration::from_secs(7)).send();
        let response=tokio::select!{_=cancel.cancelled()=>return Err(Error::cancelled()),result=response=>result.map_err(|_|Error::unavailable())?};
        if !response.status().is_success(){return Err(Error::unavailable());}
        let value:oas_domain::observation::ProxyTest=response.json().await.map_err(|_|Error::new("PROXY_TEST_PROTOCOL_INVALID",502,"代理测试返回了无效诊断。","The proxy test returned invalid diagnostics."))?;
        if value.probe_pod_uid!=node.uid{return Err(Error::unavailable());}Ok::<_,Error>(value)
    }.await;
    let details = outcome.as_ref().ok().map(|v| json!(v));
    let response = match outcome {
        Ok(value) if value.passed => oas_domain::success(request, json!({"tested":true})),
        Ok(value) => Error::new(
            if value
                .failure_kind
                .as_deref()
                .is_some_and(|r| matches!(r, "target_response" | "target_body"))
            {
                "PROXY_TEST_RESPONSE_MISMATCH"
            } else {
                "PROXY_UNAVAILABLE"
            },
            503,
            "代理测试未达到预期，请查看各阶段诊断。",
            "The proxy test did not meet expectations. Inspect its phase diagnostics.",
        )
        .envelope(request, language),
        Err(error) => error.envelope(request, language),
    };
    let status = if cancel.is_cancelled() {
        "cancelled"
    } else if response["error"].is_object() {
        "error"
    } else {
        "success"
    };
    Execution {
        response,
        calls: vec![],
        spans: vec![
            json!({"span":{"span_id":"probe","parent_id":null,"stage":"test","status":status,"start_offset_ms":0,"duration_ms":before.elapsed().as_millis()as u64},"input":{"resource_id":rid,"version":resource["version"]},"output":{"elapsed_ms":before.elapsed().as_millis()as u64},"diagnostics":if let Some(probe)=details{json!({"probe":probe})}else{json!({})},"replay":[]}),
        ],
        evidence: json!({"variants":[],"candidates":[],"sources":[],"segments":[]}),
        materials: vec![],
    }
}

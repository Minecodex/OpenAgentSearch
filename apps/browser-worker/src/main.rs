mod egress;
#[cfg(unix)]
mod native;
#[cfg(not(unix))]
#[path = "native_unsupported.rs"]
mod native;
#[cfg(unix)]
mod native_protocol;
mod pool;
mod probe;
#[cfg(unix)]
mod process;
#[cfg(test)]
#[path = "../../../tests/rust_proof.rs"]
mod proof;
mod registry;
mod search;
mod timing;
use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use chrono::Utc;
use oas_domain::{id, worker::WorkerCommand};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    process::Command,
    sync::{Mutex, OwnedSemaphorePermit, Semaphore},
};

#[derive(Clone)]
struct App {
    jobs: Arc<Mutex<HashMap<String, Arc<Mutex<Job>>>>>,
    slots: Arc<Semaphore>,
    pages: Arc<pool::Pages>,
    key: String,
    uid: String,
    boot: String,
    registry: Arc<registry::Registry>,
}
struct Job {
    owner: String,
    page: tokio::sync::OwnedMutexGuard<pool::Slot>,
    _slot: OwnedSemaphorePermit,
}
struct Session {
    browser: native::Browser,
    egress: egress::Egress,
}
fn main() -> Result<()> {
    #[cfg(unix)]
    if let Some(manifest) = std::env::args().nth(1)
        && std::path::Path::new(&manifest)
            .file_name()
            .is_some_and(|name| name == "oas.native.json")
    {
        return tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(native_protocol::host(std::path::Path::new(&manifest)));
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(serve())
}
async fn serve() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();
    for binary in ["firefox", "curl"] {
        let status = tokio::time::timeout(
            Duration::from_secs(5),
            Command::new(binary)
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true)
                .status(),
        )
        .await
        .context("browser prerequisite timed out")??;
        if !status.success() {
            bail!("browser prerequisite unavailable: {binary}");
        }
    }
    let key = std::env::var("OAS_WORKER_KEY").context("OAS_WORKER_KEY is required")?;
    let slots = std::env::var("OAS_WORKER_SLOTS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(oas_domain::worker::DEFAULT_BROWSER_SLOTS);
    let app = App {
        jobs: Arc::new(Mutex::new(HashMap::new())),
        slots: Arc::new(Semaphore::new(slots)),
        pages: Arc::new(pool::Pages::new(slots)),
        key,
        uid: std::env::var("POD_UID").unwrap_or_else(|_| "local-worker".into()),
        boot: id(),
        registry: Arc::new(registry::Registry::default()),
    };
    let maintenance = tokio::spawn(pool::maintain(app.clone()));
    let cleanup = app.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            use futures::StreamExt;
            let expired = cleanup.registry.expired().await;
            futures::stream::iter(expired)
                .for_each_concurrent(4, |id| {
                    let cleanup = &cleanup;
                    async move {
                        let _ = close(cleanup, &id).await;
                    }
                })
                .await;
        }
    });
    let shutdown = app.clone();
    let router = Router::new()
        .route(
            "/health/live",
            get(|| async { Json(json!({"status":"ok"})) }),
        )
        .route("/health/ready", get(ready))
        .route("/internal/jobs", post(jobs))
        .route("/internal/probe", post(probe::handle))
        .route("/internal/search-pages", post(pool::configure))
        .with_state(app);
    let addr = std::env::var("OAS_WORKER_BIND").unwrap_or_else(|_| "0.0.0.0:8090".into());
    axum::serve(tokio::net::TcpListener::bind(addr).await?, router)
        .with_graceful_shutdown(async move {
            oas_runtime::shutdown_signal().await;
            maintenance.abort();
            let _ = maintenance.await;
            shutdown.registry.shutdown().await;
            let ids = shutdown
                .jobs
                .lock()
                .await
                .keys()
                .cloned()
                .collect::<Vec<_>>();
            for id in ids {
                let _ = close(&shutdown, &id).await;
            }
        })
        .await?;
    Ok(())
}
async fn ready(State(app): State<App>) -> Json<Value> {
    Json(
        json!({"status":"ready","pod_uid":app.uid,"boot_id":app.boot,"free_slots":app.slots.available_permits(),"warm_slots":app.pages.warm_count(),"refreshes":app.pages.refresh_count()}),
    )
}
fn authorized(headers: &HeaderMap, key: &str) -> bool {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.strip_prefix("Bearer ") == Some(key))
}
async fn jobs(
    State(app): State<App>,
    headers: HeaderMap,
    Json(cmd): Json<WorkerCommand>,
) -> std::result::Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !authorized(&headers, &app.key) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"code":"UNAUTHORIZED"})),
        ));
    }
    if cmd.pod_uid != app.uid {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({"code":"WORKER_REPLACED"})),
        ));
    }
    if !["open", "close", "cancel", "search", "extract"].contains(&cmd.action.as_str()) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"code":"INVALID_ACTION"})),
        ));
    }
    let control = app
        .registry
        .enter(&cmd.job_id, &cmd.owner, &cmd.action, cmd.deadline_ms)
        .await
        .map_err(|error| {
            (
                StatusCode::from_u16(error.status).unwrap(),
                Json(json!({"code":error.code})),
            )
        })?;
    let _gate = control.gate.lock().await;
    let token = control.cancel;
    let job_id = cmd.job_id.clone();
    let closing = cmd.action == "close" || cmd.action == "cancel";
    let trace = timing::Trace::new(token.clone());
    let search_budget = (cmd.action == "search").then(|| Duration::from_millis(cmd.deadline_ms));
    let outcome = if closing {
        perform(&app, cmd, &trace).await
    } else {
        tokio::select! {
            biased;
            _=token.cancelled()=>Err(anyhow::anyhow!("CANCELLED")),
            outcome=async {
                if let Some(budget)=search_budget {
                    tokio::time::timeout(budget,perform(&app,cmd,&trace)).await.unwrap_or_else(|_|Err(anyhow::anyhow!("UPSTREAM_TIMEOUT")))
                } else {perform(&app,cmd,&trace).await}
            }=>outcome
        }
    };
    match outcome {
        Ok(mut value) => {
            value["_phases"] = json!(trace.snapshot());
            if let Some(job) = lookup(&app, &job_id).await {
                value["_egress"] = job
                    .lock()
                    .await
                    .page
                    .session
                    .as_ref()
                    .map(|s| s.egress.diagnostics())
                    .unwrap_or_default();
            }
            Ok(Json(value))
        }
        Err(e) => {
            tracing::warn!(error=%e,"browser operation failed");
            let mut diagnostics = if let Some(job) = lookup(&app, &job_id).await {
                job.lock()
                    .await
                    .page
                    .session
                    .as_ref()
                    .map(|s| s.egress.diagnostics())
                    .unwrap_or_default()
            } else {
                json!({})
            };
            diagnostics["phases"] = json!(trace.snapshot());
            let raw = e.to_string();
            let code = if raw == "CANCELLED" {
                "CANCELLED"
            } else if diagnostics["policy_blocked"] == true
                || raw == "policy"
                || raw == "URL_NOT_ALLOWED"
            {
                "URL_NOT_ALLOWED"
            } else if diagnostics["proxy_failure"].is_string() {
                "PROXY_CONNECTION_FAILED"
            } else if matches!(
                raw.as_str(),
                "ACCESS_DENIED"
                    | "ENDPOINT_RISK_CONTROL"
                    | "CONTENT_UNAVAILABLE"
                    | "UPSTREAM_TIMEOUT"
                    | "SEARCH_ENGINE_UNAVAILABLE"
            ) || (search_budget.is_some()
                && matches!(
                    raw.as_str(),
                    "SEARCH_ENGINE_UNAVAILABLE" | "SEARCH_RESULTS_UNAVAILABLE" | "UPSTREAM_TIMEOUT"
                ))
            {
                raw.as_str()
            } else {
                "BROWSER_FAILED"
            };
            let status = match code {
                "ACCESS_DENIED" => StatusCode::FORBIDDEN,
                "URL_NOT_ALLOWED" => StatusCode::BAD_REQUEST,
                "ENDPOINT_RISK_CONTROL" => StatusCode::TOO_MANY_REQUESTS,
                _ => StatusCode::BAD_GATEWAY,
            };
            Err((status, Json(json!({"code":code,"details":diagnostics}))))
        }
    }
}
async fn perform(app: &App, cmd: WorkerCommand, trace: &timing::Trace) -> Result<Value> {
    if cmd.action == "close" || cmd.action == "cancel" {
        if let Some(job) = lookup(app, &cmd.job_id).await
            && job.lock().await.owner != cmd.owner
        {
            bail!("stale owner")
        }
        close(app, &cmd.job_id).await?;
        return Ok(json!({"closed":true}));
    }
    if cmd.action == "open" {
        if let Some(job) = lookup(app, &cmd.job_id).await {
            if job.lock().await.owner != cmd.owner {
                bail!("owner mismatch")
            }
            return Ok(json!({"opened":true}));
        }
        let slot = app.slots.clone().try_acquire_owned()?;
        let mut page = app
            .pages
            .acquire(app, cmd.proxy.as_ref(), cmd.engine.as_deref())
            .await?;
        page.session.as_ref().unwrap().egress.reset();
        page.dirty = false;
        app.jobs.lock().await.insert(
            cmd.job_id,
            Arc::new(Mutex::new(Job {
                owner: cmd.owner,
                page,
                _slot: slot,
            })),
        );
        return Ok(json!({"opened":true}));
    }
    let job = app
        .jobs
        .lock()
        .await
        .get(&cmd.job_id)
        .cloned()
        .context("unknown browser job")?;
    let mut job = job.lock().await;
    if job.owner != cmd.owner {
        bail!("stale owner")
    }
    if cmd.action == "search"
        && cmd.engine.as_deref() == Some("google")
        && let Some(reason) = &job.page.google_failure
    {
        bail!(reason.clone());
    }
    job.page.dirty = true;
    let session = job.page.session.as_ref().context("missing search page")?;
    let result = if cmd.action == "search" {
        search::run(app, session, &cmd, trace).await
    } else {
        match read_in_tab(app, session, &cmd, trace).await {
            Ok(read) => {
                job.page.dirty = false;
                read
            }
            Err(e) => Err(e),
        }
    };
    if cmd.action == "search"
        && let Err(e) = &result
        && matches!(
            e.to_string().as_str(),
            "ENDPOINT_RISK_CONTROL" | "SEARCH_ENGINE_UNAVAILABLE" | "SEARCH_RESULTS_UNAVAILABLE"
        )
    {
        job.page.dirty = false;
    }
    if result.is_ok() {
        job.page.dirty = false;
        if cmd.action == "search" {
            job.page.searched(cmd.engine.as_deref().unwrap_or("baidu"));
        }
    }
    result
}
async fn start_session(_app: &App, proxy: Option<Value>) -> Result<Session> {
    let egress = egress::Egress::open(proxy).await?;
    let browser = native::Browser::start(egress.port).await?;
    Ok(Session { browser, egress })
}
async fn read_in_tab(
    app: &App,
    session: &Session,
    cmd: &WorkerCommand,
    trace: &timing::Trace,
) -> Result<Result<Value>> {
    let read = read_article(app, session, cmd, trace).await;
    session
        .browser
        .call("close_readers", json!({}), Duration::from_secs(2))
        .await?;
    Ok(read)
}
async fn read_article(
    _app: &App,
    session: &Session,
    cmd: &WorkerCommand,
    trace: &timing::Trace,
) -> Result<Value> {
    let target = cmd.url.as_deref().context("URL required")?;
    let url = url::Url::parse(target)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        bail!("URL_NOT_ALLOWED")
    }
    let host = url.host_str().context("host")?;
    let port = url.port_or_known_default().context("port")?;
    session.egress.track(host, port);
    trace
        .measure("validate", egress::validate_host(host, port))
        .await?;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(cmd.deadline_ms);
    let remaining = || deadline.saturating_duration_since(tokio::time::Instant::now());
    let opened = trace
        .measure(
            "navigate",
            session
                .browser
                .call("open_reader", json!({"url":target}), remaining()),
        )
        .await?;
    let args = json!({"tab":opened["tab"]});
    let mut value = trace
        .measure(
            "extract",
            session
                .browser
                .call("reader_article", args.clone(), remaining()),
        )
        .await?;
    let mut layout = trace
        .measure(
            "archive",
            session.browser.call("reader_layout", args, remaining()),
        )
        .await?;
    if layout["reason"] == "layout_byte_limit"
        || layout["srcdoc"].as_str().unwrap_or("").len() > 16 * 1024 * 1024
    {
        layout = oas_domain::archive::native_layout(value["archive_body"].as_str().unwrap_or(""));
        layout["reason"] = json!("layout_byte_limit");
    }
    value["layout"] = layout;
    Ok(value)
}
fn search_url(cmd: &WorkerCommand) -> Result<String> {
    let google = cmd.engine.as_deref() == Some("google");
    let origin = search::origin(if google { "google" } else { "baidu" });
    let mut u = url::Url::parse(&format!(
        "{}/{}",
        origin.trim_end_matches('/'),
        if google { "search" } else { "s" }
    ))?;
    {
        let mut q = u.query_pairs_mut();
        q.append_pair(
            if google { "q" } else { "wd" },
            cmd.query.as_deref().context("query required")?,
        );
        q.append_pair(
            if google { "num" } else { "rn" },
            &cmd.count.min(10).to_string(),
        );
        if let Some(language) = &cmd.language {
            q.append_pair(
                if google { "hl" } else { "ie" },
                if google { language } else { "utf-8" },
            );
        }
        if let Some(range) = &cmd.time_range {
            let (key, value) = oas_domain::worker::SearchTimeFilter::resolve(
                cmd.engine.as_deref().unwrap_or("baidu"),
                range,
            )
            .context("unsupported range")?
            .parameter(Utc::now().timestamp());
            q.append_pair(key, &value);
        }
    }
    Ok(u.to_string())
}
async fn lookup(app: &App, id: &str) -> Option<Arc<Mutex<Job>>> {
    let jobs = app.jobs.lock().await;
    jobs.get(id).cloned()
}
async fn close(app: &App, id: &str) -> Result<()> {
    app.registry.mark_closed(id).await;
    let removed = { app.jobs.lock().await.remove(id) };
    if let Some(job) = removed {
        let mut job = job.lock().await;
        if job.page.dirty {
            job.page.discard();
        }
    }
    Ok(())
}

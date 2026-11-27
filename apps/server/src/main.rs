mod admin;
mod administrator;
mod cache_api;
mod cache_worker;
mod health;
mod http;
mod testing;
mod traces;
use anyhow::{Context, Result};
use axum::{
    Router, middleware,
    routing::{get, post},
};
use oas_adapters::{discovery, providers::Providers, repository::Repository};
use oas_application::engine::Engine;
use oas_runtime::Scheduler;
use sqlx::{Connection, Row, postgres::PgConnection};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

#[derive(Clone)]
pub struct App {
    cache: Arc<oas_application::cache::CacheService>,
    repo: Repository,
    providers: Providers,
    scheduler: Scheduler,
    engine: Arc<Engine>,
    ready: Arc<AtomicBool>,
    origin: String,
    traces: tokio::sync::mpsc::Sender<traces::Message>,
    diagnostic_counters: Arc<traces::Counters>,
    login: Arc<tokio::sync::Semaphore>,
}
#[tokio::main]
async fn main() -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    if std::env::args().any(|a| a == "diagnostics") {
        let value: serde_json::Value = reqwest::Client::new()
            .get("http://127.0.0.1:8080/internal/status")
            .bearer_auth(std::env::var("OAS_WORKER_KEY")?)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        println!("{}", serde_json::to_string(&value)?);
        return Ok(());
    }
    if std::env::args().any(|a| a == "healthcheck") {
        let body = reqwest_health().await?;
        if !body {
            anyhow::bail!("API is not ready")
        }
        return Ok(());
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let db = database_options()?;
    let key = std::env::var("OAS_MASTER_KEY")
        .context("OAS_MASTER_KEY is required (64 hexadecimal digits)")?;
    let worker_key = std::env::var("OAS_WORKER_KEY").context("OAS_WORKER_KEY is required")?;
    let repo = Repository::connect(db.clone(), &key).await?;
    if std::env::args().skip(1).eq(["reset-admin-password"]) {
        return administrator::reset(&repo).await;
    }
    if std::env::args().any(|a| a == "schema") {
        let version: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(version),0) FROM _sqlx_migrations WHERE success",
        )
        .fetch_one(&repo.pool)
        .await?;
        println!("schema_version={version}");
        return Ok(());
    }
    repo.migrate().await?;
    if std::env::args().any(|a| a == "migrate") {
        return Ok(());
    }
    repo.bootstrap(
        &std::env::var("OAS_ADMIN_USERNAME")
            .unwrap_or_else(|_| oas_domain::administrator::DEFAULT_USERNAME.into()),
        &std::env::var("OAS_ADMIN_PASSWORD")
            .unwrap_or_else(|_| oas_domain::administrator::DEFAULT_PASSWORD.into()),
    )
    .await?;
    let mut owner = PgConnection::connect_with(&db).await?;
    let owns: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock(77183002)")
        .fetch_one(&mut owner)
        .await?;
    if !owns {
        anyhow::bail!("another scheduler owns this database")
    }
    repo.reconcile_abandoned().await?;
    let scheduler = Scheduler::default();
    for row in sqlx::query(
        "SELECT endpoint_id,blocked_until FROM endpoint_risk_cooldowns WHERE blocked_until>now()",
    )
    .fetch_all(&repo.pool)
    .await?
    {
        scheduler.risk(
            &row.get::<uuid::Uuid, _>("endpoint_id").to_string(),
            row.get::<chrono::DateTime<chrono::Utc>, _>("blocked_until")
                .timestamp_millis(),
        );
    }
    let providers = Providers::new(repo.clone(), worker_key)?;
    providers.recover(&scheduler).await?;
    let diagnostic_counters = Arc::new(traces::Counters::default());
    let traces = traces::writer(repo.clone(), diagnostic_counters.clone());
    scheduler.proxy_policy(oas_runtime::ProxyPolicy {
        failures: std::env::var("OAS_PROXY_FAILURE_THRESHOLD")
            .unwrap_or_else(|_| "3".into())
            .parse::<u32>()?
            .clamp(1, 100),
        cooldown_ms: std::env::var("OAS_PROXY_COOLDOWN_SECONDS")
            .unwrap_or_else(|_| "30".into())
            .parse::<i64>()?
            .clamp(1, 1800)
            * 1000,
        maximum_ms: 1_800_000,
    });
    let cache = oas_adapters::cache::build(repo.clone()).await?;
    let app = App {
        cache: cache.clone(),
        login: Arc::new(tokio::sync::Semaphore::new(3)),
        traces: traces.clone(),
        diagnostic_counters,
        engine: Arc::new(Engine {
            cache: Some(cache),
            background: false,
            transport: Arc::new(providers.clone()),
            scheduler: scheduler.clone(),
        }),
        repo: repo.clone(),
        providers: providers.clone(),
        scheduler: scheduler.clone(),
        ready: Arc::new(AtomicBool::new(true)),
        origin: std::env::var("OAS_PUBLIC_ORIGIN")
            .unwrap_or_else(|_| "http://localhost:8080".into()),
    };
    tokio::spawn(cache_worker::supervise(app.clone()));
    let check = app.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            if sqlx::query("SELECT 1").execute(&mut owner).await.is_err() {
                check.ready.store(false, Ordering::SeqCst);
                check.scheduler.shutdown();
                break;
            }
        }
    });
    tokio::spawn(discovery::supervise(repo, providers, scheduler));
    let admin = admin::router().layer(middleware::from_fn_with_state(
        app.clone(),
        http::authenticate,
    ));
    let static_dir = std::env::var("OAS_WEB_DIR").unwrap_or_else(|_| "web/dist".into());
    let shutdown = app.clone();
    let check_scheduler = app.scheduler.clone();
    let router = Router::new()
        .route("/health/live", get(http::live))
        .route("/health/ready", get(http::ready))
        .route("/internal/status", get(health::internal))
        .route("/v1/search/{operation}", post(http::business))
        .route(
            "/admin/v1/session",
            post(http::login).get(http::session).delete(http::logout),
        )
        .nest("/admin/v1", admin)
        .fallback_service(
            ServeDir::new(&static_dir)
                .not_found_service(ServeFile::new(format!("{static_dir}/index.html"))),
        )
        .layer(axum::extract::DefaultBodyLimit::max(65536))
        .layer(middleware::from_fn(http::api_errors))
        .layer(TraceLayer::new_for_http())
        .with_state(app);
    let address = std::env::var("OAS_BIND").unwrap_or_else(|_| "0.0.0.0:8080".into());
    axum::serve(tokio::net::TcpListener::bind(address).await?, router)
        .with_graceful_shutdown(async move {
            tokio::select! {_=oas_runtime::shutdown_signal()=>{},_=shutdown.scheduler.stopped()=>{}}
            shutdown.ready.store(false, Ordering::SeqCst);
            shutdown.scheduler.shutdown();
        })
        .await?;
    let wait_started = std::time::Instant::now();
    while check_scheduler.active_requests() > 0
        && wait_started.elapsed() < std::time::Duration::from_secs(6)
    {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let (done, drained) = tokio::sync::oneshot::channel();
    let _ = traces.send(traces::Message::Flush(done)).await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), drained).await;
    Ok(())
}
async fn reqwest_health() -> Result<bool> {
    let data = tokio::process::Command::new("curl")
        .args([
            "--fail",
            "--silent",
            "--max-time",
            "5",
            "http://127.0.0.1:8080/health/ready",
        ])
        .status()
        .await?;
    Ok(data.success())
}

fn database_options() -> Result<sqlx::postgres::PgConnectOptions> {
    if let Ok(url) = std::env::var("DATABASE_URL") {
        return url.parse().context("invalid DATABASE_URL");
    }
    Ok(sqlx::postgres::PgConnectOptions::new()
        .host(&std::env::var("PGHOST").context("DATABASE_URL or PGHOST is required")?)
        .port(
            std::env::var("PGPORT")
                .unwrap_or_else(|_| "5432".into())
                .parse()
                .context("invalid PGPORT")?,
        )
        .username(&std::env::var("PGUSER").unwrap_or_else(|_| "oas".into()))
        .password(&std::env::var("PGPASSWORD").context("PGPASSWORD is required")?)
        .database(&std::env::var("PGDATABASE").unwrap_or_else(|_| "oas".into())))
}

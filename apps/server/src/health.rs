use crate::{
    App,
    http::{lang, reply},
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

pub async fn snapshot(app: &App) -> Value {
    let schema = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(MAX(version),0) FROM _sqlx_migrations WHERE success",
    )
    .fetch_one(&app.repo.pool)
    .await
    .ok();
    let components = app
        .repo
        .resources("endpoints")
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e["managed_by"] == "helm")
        .map(|e| json!({"name":e["provider"],"availability":e["availability"]}))
        .collect::<Vec<_>>();
    json!({"ready":app.ready.load(Ordering::SeqCst)&&schema.is_some(),"schema_version":schema,"scheduler":app.scheduler.diagnostics(),"components":components,
        "diagnostics":{"dropped":app.diagnostic_counters.dropped.load(Ordering::Relaxed),"failed":app.diagnostic_counters.failed.load(Ordering::Relaxed),"stored":app.diagnostic_counters.stored.load(Ordering::Relaxed),"queue_remaining":app.traces.capacity()}})
}
pub async fn internal(
    State(app): State<App>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    if headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        != Some(app.providers.worker_key.as_str())
    {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(Json(snapshot(&app).await))
}
pub async fn admin(State(app): State<App>, headers: HeaderMap) -> axum::response::Response {
    reply(
        Ok(snapshot(&app).await),
        &oas_domain::id(),
        lang(&headers),
        200,
    )
}

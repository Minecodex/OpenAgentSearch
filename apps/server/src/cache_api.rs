use crate::{
    App,
    http::{lang, parse, reply},
};
use axum::{
    Router,
    body::Bytes,
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::get,
};
use oas_adapters::cache::management;
use oas_domain::{Result, id};
use serde_json::{Value, json};
use std::collections::HashMap;

pub fn router() -> Router<App> {
    Router::new()
        .route("/cache/overview", get(overview))
        .route("/cache/tasks", get(tasks))
        .route("/cache/tasks/{id}", get(task))
        .route(
            "/settings/cache-concurrency",
            get(get_concurrency).put(put_concurrency),
        )
        .route("/settings/cache-policy", get(get_policy).put(put_policy))
        .route(
            "/settings/cache-model-budgets",
            get(get_models).put(put_models),
        )
}
fn optional<'a>(query: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    query.get(key).map(String::as_str).filter(|s| !s.is_empty())
}
fn filters(query: &HashMap<String, String>) -> Result<management::Filters<'_>> {
    let now = chrono::Utc::now().timestamp_millis();
    let since = optional(query, "since")
        .map(str::parse::<i64>)
        .transpose()
        .map_err(|_| oas_domain::Error::invalid("since"))?
        .unwrap_or(now - 86400000);
    let until = optional(query, "until")
        .map(str::parse::<i64>)
        .transpose()
        .map_err(|_| oas_domain::Error::invalid("until"))?
        .unwrap_or(now + 1);
    if since >= until {
        return Err(oas_domain::Error::invalid("since"));
    }
    Ok(management::Filters {
        scope: optional(query, "project"),
        origin: optional(query, "origin"),
        operation: optional(query, "operation"),
        kind: optional(query, "kind"),
        since,
        until,
    })
}
async fn overview(
    State(app): State<App>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let result=async {
        let filters=filters(&query)?;
        let mut data=management::overview(&app.repo,&app.cache.binding.namespace,&filters).await?;
        data["browser"]=app.scheduler.cache_capacity();
        data["binding"]=json!(app.cache.binding);
        data["embedding"]=json!({"configured":app.cache.embedding.configured(),"version":app.cache.embedding.version(),"ready":app.cache.metadata.index_ready(&app.cache.binding,app.cache.embedding.version()).await.unwrap_or(false)});
        if let Some(matcher)=app.cache.handler.matcher() {
            data["matcher"]=json!({"configured":!matcher.profile().is_empty(),"profile":matcher.profile()});
        }
        data["objects"]=json!({"configured":app.cache.objects.configured()});
        data["queue"]["capacity"]=json!(app.cache.settings.queue_capacity);
        Ok::<_,oas_domain::Error>(data)
    }.await;
    reply(result, &id(), lang(&headers), 200)
}
async fn tasks(
    State(app): State<App>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let result = async {
        management::tasks(
            &app.repo,
            &filters(&query)?,
            optional(&query, "state"),
            optional(&query, "cursor").and_then(|v| v.parse().ok()),
            optional(&query, "limit")
                .and_then(|v| v.parse().ok())
                .unwrap_or(25),
        )
        .await
    }
    .await;
    reply(result, &id(), lang(&headers), 200)
}
async fn task(
    State(app): State<App>,
    Path(task): Path<String>,
    headers: HeaderMap,
) -> axum::response::Response {
    reply(
        management::task(&app.repo, &task).await,
        &id(),
        lang(&headers),
        200,
    )
}
async fn config(app: &App, name: &str) -> Result<Value> {
    let mut result = management::settings(&app.repo, name).await?;
    if name == "cache-concurrency" {
        let capacity = app.scheduler.cache_capacity();
        for (key, value) in capacity.as_object().unwrap() {
            if key != "configured_limit" {
                result[key] = value.clone();
            }
        }
    }
    Ok(result)
}
async fn save(app: &App, name: &str, bytes: &Bytes) -> Result<Value> {
    let capacity = app.scheduler.cache_capacity();
    let tabs = capacity["ready_tabs"].as_u64().unwrap_or(0) as usize;
    management::save_settings(&app.repo, name, parse(bytes)?, tabs).await?;
    let browser = management::settings(&app.repo, "cache-concurrency").await?;
    let model = management::settings(&app.repo, "cache-model-budgets").await?;
    app.scheduler.configure_cache(
        browser["configured_limit"].as_u64().unwrap_or(1) as usize,
        model["concurrency"].as_u64().unwrap_or(1) as usize,
        model["rpm"].as_u64().unwrap_or(10) as usize,
    );
    config(app, name).await
}
macro_rules! settings_routes {
    ($get:ident,$put:ident,$name:literal) => {
        async fn $get(State(app): State<App>, headers: HeaderMap) -> axum::response::Response {
            reply(config(&app, $name).await, &id(), lang(&headers), 200)
        }
        async fn $put(
            State(app): State<App>,
            headers: HeaderMap,
            bytes: Bytes,
        ) -> axum::response::Response {
            reply(save(&app, $name, &bytes).await, &id(), lang(&headers), 200)
        }
    };
}
settings_routes!(get_concurrency, put_concurrency, "cache-concurrency");
settings_routes!(get_policy, put_policy, "cache-policy");
settings_routes!(get_models, put_models, "cache-model-budgets");

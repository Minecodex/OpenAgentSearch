use crate::{
    App,
    http::{execute, lang, parse, reply},
};
use axum::{
    Extension, Router,
    body::Bytes,
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::{get, post},
};
use oas_adapters::repository::missing;
use oas_domain::{Error, Result, id, unknown_probe};
use serde_json::{Value, json};
use sqlx::Row;
use std::collections::HashMap;
pub fn router() -> Router<App> {
    Router::new()
        .route("/diagnostics", get(crate::health::admin))
        .route("/settings/retention", get(get_retention).put(put_retention))
        .route("/language-routes", get(get_routes).put(put_routes))
        .route("/projects/{id}/key", post(rotate))
        .route("/projects/{id}/debug/{operation}", post(debug))
        .route("/requests/aggregates", get(aggregates))
        .route("/requests/{id}/cancel", post(cancel))
        .route("/requests/{id}/evidence", get(evidence))
        .route("/requests/{id}/spans/{span}", get(span))
        .route("/requests/{id}/export", get(export))
        .route("/requests/{id}/replay/{material}/layout", get(layout))
        .route("/requests/{id}", get(detail))
        .route("/requests", get(requests))
        .route("/endpoint-calls", get(calls))
        .route("/endpoint-calls/{id}", get(call))
        .route("/endpoint-statistics", get(stats))
        .route("/{kind}/{id}/test", post(test))
        .route("/{kind}/{id}", get(resource).put(update).delete(archive))
        .route("/{kind}", get(list).post(create))
}
fn response(result: Result<Value>, headers: &HeaderMap, status: u16) -> axum::response::Response {
    reply(result, &id(), lang(headers), status)
}
fn resource_kind(kind: &str) -> Result<()> {
    if ["projects", "endpoints", "proxies", "proxy-pools"].contains(&kind) {
        Ok(())
    } else {
        Err(missing())
    }
}
async fn views(app: &App, kind: &str) -> Result<Vec<Value>> {
    let mut rows = app.repo.resources(kind).await?;
    let probes = sqlx::query("SELECT egress_id,version,body-'_next_due_at' AS body FROM probes")
        .fetch_all(&app.repo.pool)
        .await
        .map_err(|_| Error::internal())?;
    let count = app.scheduler.workers().len();
    for row in &mut rows {
        let rid = row["id"].as_str().unwrap_or("").to_owned();
        if row["provider"] == "browser" {
            row["ready_pods"] = json!(count);
            row["availability"] = json!(if count == 0 {
                "no_ready_pods"
            } else {
                "available"
            });
            if row["adapter"] == "browser_search" {
                row["default_network_google_probe"] = probes
                    .iter()
                    .find(|r| {
                        r.get::<String, _>("egress_id") == "default_network"
                            && r.get::<i64, _>("version") == oas_adapters::probes::default_version()
                    })
                    .map(|r| r.get("body"))
                    .unwrap_or_else(unknown_probe);
            }
        }
        if kind == "proxies" {
            let view = app.scheduler.proxy_view(row);
            for (k, v) in view.as_object().unwrap() {
                row[k] = v.clone();
            }
        }
        if kind == "proxies" {
            row["active_leases"] = json!(app.scheduler.active(&format!("proxy:{rid}")));
            row["google_probe"] = probes
                .iter()
                .find(|r| {
                    r.get::<String, _>("egress_id") == rid
                        && Some(r.get::<i64, _>("version")) == row["version"].as_i64()
                })
                .map(|r| r.get("body"))
                .unwrap_or_else(unknown_probe);
        }
    }
    Ok(rows)
}
fn page(mut rows: Vec<Value>, q: &HashMap<String, String>) -> Result<Value> {
    if let Some(text) = q.get("q").filter(|s| !s.is_empty()) {
        let needle = text.to_lowercase();
        rows.retain(|r| r.to_string().to_lowercase().contains(&needle));
    }
    if let Some(kind) = q.get("kind").filter(|s| !s.is_empty()) {
        rows.retain(|r| r["kind"] == *kind);
    }
    let start = if let Some(cursor) = q.get("cursor") {
        rows.iter()
            .position(|r| {
                r["id"]
                    .as_str()
                    .or(r["call_id"].as_str())
                    .or(r["request_id"].as_str())
                    == Some(cursor)
            })
            .map(|i| i + 1)
            .ok_or_else(|| Error::invalid("cursor"))?
    } else {
        0
    };
    let size = q
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(20)
        .clamp(1, 100);
    let items = rows
        .iter()
        .skip(start)
        .take(size)
        .cloned()
        .collect::<Vec<_>>();
    let next = if start + items.len() < rows.len() {
        items
            .last()
            .and_then(|r| {
                r["id"]
                    .as_str()
                    .or(r["call_id"].as_str())
                    .or(r["request_id"].as_str())
            })
            .map(str::to_owned)
    } else {
        None
    };
    Ok(json!({"items":items,"next_cursor":next}))
}
async fn list(
    State(app): State<App>,
    Path(kind): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    h: HeaderMap,
) -> axum::response::Response {
    response(
        async {
            resource_kind(&kind)?;
            page(views(&app, &kind).await?, &q)
        }
        .await,
        &h,
        200,
    )
}
async fn resource(
    State(app): State<App>,
    Path((kind, rid)): Path<(String, String)>,
    h: HeaderMap,
) -> axum::response::Response {
    response(
        async {
            resource_kind(&kind)?;
            views(&app, &kind)
                .await?
                .into_iter()
                .find(|r| r["id"] == rid)
                .ok_or_else(missing)
        }
        .await,
        &h,
        200,
    )
}
async fn create(
    State(app): State<App>,
    Path(kind): Path<String>,
    h: HeaderMap,
    body: Bytes,
) -> axum::response::Response {
    response(
        async {
            resource_kind(&kind)?;
            app.repo.save(&kind, None, parse(&body)?).await
        }
        .await,
        &h,
        201,
    )
}
async fn update(
    State(app): State<App>,
    Path((kind, rid)): Path<(String, String)>,
    h: HeaderMap,
    body: Bytes,
) -> axum::response::Response {
    response(
        async {
            resource_kind(&kind)?;
            app.repo.save(&kind, Some(&rid), parse(&body)?).await
        }
        .await,
        &h,
        200,
    )
}
async fn archive(
    State(app): State<App>,
    Path((kind, rid)): Path<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
    h: HeaderMap,
) -> axum::response::Response {
    response(
        async {
            resource_kind(&kind)?;
            let version = q
                .get("expected_version")
                .and_then(|s| s.parse().ok())
                .ok_or_else(|| Error::invalid("expected_version"))?;
            if kind == "projects" {
                return Err(missing());
            }
            app.repo.archive(&kind, &rid, version).await
        }
        .await,
        &h,
        200,
    )
}
async fn rotate(
    State(app): State<App>,
    Path(rid): Path<String>,
    h: HeaderMap,
    body: Bytes,
) -> axum::response::Response {
    response(
        async {
            let v = parse(&body)?;
            let version = v["expected_version"]
                .as_i64()
                .ok_or_else(|| Error::invalid("expected_version"))?;
            app.repo.rotate(&rid, version).await
        }
        .await,
        &h,
        200,
    )
}
async fn get_retention(State(app): State<App>, h: HeaderMap) -> axum::response::Response {
    response(app.repo.setting("retention").await, &h, 200)
}
async fn put_retention(
    State(app): State<App>,
    h: HeaderMap,
    body: Bytes,
) -> axum::response::Response {
    response(
        async { app.repo.update_setting("retention", parse(&body)?).await }.await,
        &h,
        200,
    )
}
async fn get_routes(State(app): State<App>, h: HeaderMap) -> axum::response::Response {
    response(app.repo.setting("language-routes").await, &h, 200)
}
async fn put_routes(State(app): State<App>, h: HeaderMap, body: Bytes) -> axum::response::Response {
    response(
        async {
            app.repo
                .update_setting("language-routes", parse(&body)?)
                .await
        }
        .await,
        &h,
        200,
    )
}
async fn debug(
    State(app): State<App>,
    Extension(arrival): Extension<crate::http::Arrival>,
    Path((rid, operation)): Path<(String, String)>,
    h: HeaderMap,
    body: Bytes,
) -> axum::response::Response {
    execute(app, rid, operation, h, body, "debug", arrival).await
}
async fn cancel(
    State(app): State<App>,
    Path(rid): Path<String>,
    h: HeaderMap,
) -> axum::response::Response {
    response(
        async {
            if app.scheduler.cancel(&rid) {
                return Ok(json!({"cancelled":true}));
            }
            app.repo.detail(&rid).await?;
            Ok(json!({"cancelled":false}))
        }
        .await,
        &h,
        200,
    )
}
async fn requests(
    State(app): State<App>,
    Query(q): Query<HashMap<String, String>>,
    h: HeaderMap,
) -> axum::response::Response {
    response(app.repo.records_page("requests", &q).await, &h, 200)
}
async fn aggregates(
    State(app): State<App>,
    Query(q): Query<HashMap<String, String>>,
    h: HeaderMap,
) -> axum::response::Response {
    response(
        async { app.repo.request_aggregates(&q).await }.await,
        &h,
        200,
    )
}
fn public_detail(mut value: Value) -> Value {
    value.as_object_mut().unwrap().remove("evidence");
    if let Some(spans) = value["spans"].as_array() {
        value["spans"] = json!(spans.iter().map(|s| s["span"].clone()).collect::<Vec<_>>());
    }
    value
}
async fn detail(
    State(app): State<App>,
    Path(rid): Path<String>,
    h: HeaderMap,
) -> axum::response::Response {
    response(app.repo.public_detail(&rid).await, &h, 200)
}
async fn evidence(
    State(app): State<App>,
    Path(rid): Path<String>,
    h: HeaderMap,
) -> axum::response::Response {
    response(app.repo.evidence(&rid).await, &h, 200)
}
async fn span(
    State(app): State<App>,
    Path((rid, sid)): Path<(String, String)>,
    h: HeaderMap,
) -> axum::response::Response {
    response(async { app.repo.span(&rid, &sid).await }.await, &h, 200)
}
async fn layout(
    State(app): State<App>,
    Path((rid, material)): Path<(String, String)>,
    h: HeaderMap,
) -> axum::response::Response {
    response(app.repo.layout(&rid, &material).await, &h, 200)
}
async fn export(
    State(app): State<App>,
    Path(rid): Path<String>,
    h: HeaderMap,
) -> axum::response::Response {
    response(async{let value=app.repo.detail(&rid).await?;let calls=app.repo.list_records("endpoint_calls",&HashMap::from([("request_id".into(),rid)])).await?;
        Ok(json!({"request":public_detail(value.clone()),"evidence":value["evidence"],"calls":calls,"payloads":value["spans"]}))}.await,&h,200)
}
async fn calls(
    State(app): State<App>,
    Query(q): Query<HashMap<String, String>>,
    h: HeaderMap,
) -> axum::response::Response {
    response(app.repo.records_page("endpoint_calls", &q).await, &h, 200)
}
async fn call(
    State(app): State<App>,
    Path(cid): Path<String>,
    h: HeaderMap,
) -> axum::response::Response {
    response(app.repo.endpoint_call(&cid).await, &h, 200)
}
async fn stats(
    State(app): State<App>,
    Query(q): Query<HashMap<String, String>>,
    h: HeaderMap,
) -> axum::response::Response {
    response(
        async { app.repo.endpoint_statistics(&q).await }.await,
        &h,
        200,
    )
}
async fn test(
    State(app): State<App>,
    Path((kind, rid)): Path<(String, String)>,
    h: HeaderMap,
) -> axum::response::Response {
    response(
        crate::testing::resource_test(
            &app,
            &kind,
            &rid,
            h.get("x-request-id").and_then(|v| v.to_str().ok()),
        )
        .await,
        &h,
        200,
    )
}

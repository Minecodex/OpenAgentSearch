use crate::App;
use axum::{
    Extension, Json,
    body::Bytes,
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use chrono::Utc;
use oas_domain::{Command, Error, RequestStart, Result, id, success};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;
use tokio_util::sync::CancellationToken;

pub fn lang(headers: &HeaderMap) -> &str {
    headers
        .get("accept-language")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("zh")
}
#[derive(Clone, Copy)]
pub struct Arrival {
    pub monotonic: tokio::time::Instant,
    pub utc: chrono::DateTime<Utc>,
}
pub fn reply(result: Result<Value>, request: &str, language: &str, status: u16) -> Response {
    match result {
        Ok(data) => (
            StatusCode::from_u16(status).unwrap_or(StatusCode::OK),
            Json(success(request, data)),
        )
            .into_response(),
        Err(e) => (
            StatusCode::from_u16(e.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(e.envelope(request, language)),
        )
            .into_response(),
    }
}
pub fn cookie(headers: &HeaderMap) -> String {
    headers
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .find_map(|v| {
            v.trim()
                .strip_prefix("oas_admin_session=")
                .map(str::to_owned)
        })
        .unwrap_or_default()
}
pub fn origin(app: &App, headers: &HeaderMap) -> Result<()> {
    if headers.get("origin").and_then(|v| v.to_str().ok()) != Some(app.origin.as_str()) {
        return Err(Error::new(
            "ORIGIN_INVALID",
            403,
            "请求来源无效。",
            "Invalid request origin.",
        ));
    }
    Ok(())
}
pub async fn api_errors(headers: HeaderMap, mut request: Request, next: Next) -> Response {
    request.extensions_mut().insert(Arrival {
        monotonic: tokio::time::Instant::now(),
        utc: Utc::now(),
    });
    let is_api =
        request.uri().path().starts_with("/admin/") || request.uri().path().starts_with("/v1/");
    let json_body = matches!(
        *request.method(),
        axum::http::Method::POST | axum::http::Method::PUT
    );
    if is_api
        && json_body
        && !headers
            .get(header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|h| {
                h.split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .eq_ignore_ascii_case("application/json")
            })
    {
        return reply(
            Err(Error::new(
                "UNSUPPORTED_MEDIA_TYPE",
                415,
                "请求需要 JSON 内容类型。",
                "Use the JSON content type.",
            )),
            &id(),
            lang(&headers),
            200,
        );
    }
    let response = next.run(request).await;
    if is_api
        && !response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("application/json"))
    {
        let error = if response.status() == StatusCode::METHOD_NOT_ALLOWED {
            Error::new(
                "METHOD_NOT_ALLOWED",
                405,
                "该接口不支持此方法。",
                "This method is not allowed.",
            )
        } else if response.status().is_success() || response.status() == StatusCode::NOT_FOUND {
            oas_adapters::repository::missing()
        } else if response.status() == StatusCode::PAYLOAD_TOO_LARGE {
            Error::new(
                "PAYLOAD_TOO_LARGE",
                413,
                "请求体超过字节上限。",
                "The request body exceeds its byte limit.",
            )
        } else {
            Error::internal()
        };
        return reply(Err(error), &id(), lang(&headers), 200);
    }
    if is_api && response.status() == StatusCode::PAYLOAD_TOO_LARGE {
        return reply(
            Err(Error::new(
                "PAYLOAD_TOO_LARGE",
                413,
                "请求体超过字节上限。",
                "The request body exceeds its byte limit.",
            )),
            &id(),
            lang(&headers),
            200,
        );
    }
    response
}
pub async fn authenticate(
    State(app): State<App>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Response {
    let writes = !matches!(
        *request.method(),
        axum::http::Method::GET | axum::http::Method::HEAD
    );
    let check = async {
        let session = app.repo.session(&cookie(&headers)).await?;
        if writes {
            origin(&app, &headers)?;
            if headers.get("x-csrf-token").and_then(|v| v.to_str().ok())
                != session["csrf_token"].as_str()
            {
                return Err(Error::new(
                    "CSRF_INVALID",
                    403,
                    "会话校验失败，请重载。",
                    "Session validation failed. Reload the page.",
                ));
            }
        }
        Ok::<_, Error>(())
    }
    .await;
    if let Err(e) = check {
        return reply(Err(e), &id(), lang(&headers), 200);
    }
    next.run(request).await
}
pub async fn login(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Response {
    let request = id();
    let result = async {
        origin(&app, &headers)?;
        app.scheduler.login_attempt()?;
        let _slot = app
            .login
            .clone()
            .try_acquire_owned()
            .map_err(|_| oas_runtime::capacity())?;
        let v = parse(&body)?;
        oas_domain::validation::allowed_fields(&v, &["username", "password"])?;
        app.repo
            .login(
                v["username"].as_str().unwrap_or(""),
                v["password"].as_str().unwrap_or(""),
            )
            .await
    }
    .await;
    match result {
        Ok((raw, session)) => {
            let mut response = reply(Ok(session), &request, lang(&headers), 200);
            let secure = if app.origin.starts_with("https:") {
                "; Secure"
            } else {
                ""
            };
            response.headers_mut().insert(header::SET_COOKIE,format!("oas_admin_session={raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200{secure}").parse().unwrap());
            response
        }
        Err(e) => reply(Err(e), &request, lang(&headers), 200),
    }
}
pub async fn session(State(app): State<App>, headers: HeaderMap) -> Response {
    reply(
        app.repo.session(&cookie(&headers)).await,
        &id(),
        lang(&headers),
        200,
    )
}
pub async fn logout(State(app): State<App>, headers: HeaderMap) -> Response {
    let result = async {
        origin(&app, &headers)?;
        let s = app.repo.session(&cookie(&headers)).await?;
        if headers.get("x-csrf-token").and_then(|v| v.to_str().ok()) != s["csrf_token"].as_str() {
            return Err(Error::new(
                "CSRF_INVALID",
                403,
                "会话校验失败。",
                "Session validation failed.",
            ));
        }
        app.repo.logout(&cookie(&headers)).await?;
        Ok(Value::Null)
    }
    .await;
    let mut response = reply(result, &id(), lang(&headers), 200);
    response.headers_mut().insert(
        header::SET_COOKIE,
        "oas_admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
            .parse()
            .unwrap(),
    );
    response
}
pub async fn live() -> Json<Value> {
    Json(json!({"status":"ok"}))
}
pub async fn ready(State(app): State<App>) -> Response {
    let up = app.ready.load(Ordering::SeqCst)
        && sqlx::query("SELECT 1")
            .execute(&app.repo.pool)
            .await
            .is_ok();
    (if up{StatusCode::OK}else{StatusCode::SERVICE_UNAVAILABLE},Json(json!({"status":if up{"ready"}else{"not_ready"},"components":{"database":if up{"ok"}else{"unavailable"},"scheduler":if up{"ok"}else{"unavailable"},"browser":if app.scheduler.workers().is_empty(){"degraded"}else{"ok"}}}))).into_response()
}
pub fn parse(bytes: &[u8]) -> Result<Value> {
    use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
    struct Strict(Value);
    impl<'de> Deserialize<'de> for Strict {
        fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
            struct V;
            impl<'de> Visitor<'de> for V {
                type Value = Strict;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                    f.write_str("valid JSON")
                }
                fn visit_map<M: MapAccess<'de>>(
                    self,
                    mut a: M,
                ) -> std::result::Result<Strict, M::Error> {
                    let mut obj = serde_json::Map::new();
                    while let Some(k) = a.next_key::<String>()? {
                        if obj.contains_key(&k) {
                            return Err(serde::de::Error::custom("duplicate field"));
                        }
                        obj.insert(k, a.next_value::<Strict>()?.0);
                    }
                    Ok(Strict(Value::Object(obj)))
                }
                fn visit_seq<A: SeqAccess<'de>>(
                    self,
                    mut a: A,
                ) -> std::result::Result<Strict, A::Error> {
                    let mut out = Vec::new();
                    while let Some(v) = a.next_element::<Strict>()? {
                        out.push(v.0)
                    }
                    Ok(Strict(json!(out)))
                }
                fn visit_bool<E: serde::de::Error>(
                    self,
                    v: bool,
                ) -> std::result::Result<Strict, E> {
                    Ok(Strict(json!(v)))
                }
                fn visit_str<E: serde::de::Error>(self, v: &str) -> std::result::Result<Strict, E> {
                    Ok(Strict(json!(v)))
                }
                fn visit_string<E: serde::de::Error>(
                    self,
                    v: String,
                ) -> std::result::Result<Strict, E> {
                    Ok(Strict(json!(v)))
                }
                fn visit_i64<E: serde::de::Error>(self, v: i64) -> std::result::Result<Strict, E> {
                    Ok(Strict(json!(v)))
                }
                fn visit_u64<E: serde::de::Error>(self, v: u64) -> std::result::Result<Strict, E> {
                    Ok(Strict(json!(v)))
                }
                fn visit_f64<E: serde::de::Error>(self, v: f64) -> std::result::Result<Strict, E> {
                    Ok(Strict(json!(v)))
                }
                fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Strict, E> {
                    Ok(Strict(Value::Null))
                }
            }
            d.deserialize_any(V)
        }
    }
    serde_json::from_slice::<Strict>(bytes)
        .map(|s| s.0)
        .map_err(|_| Error::invalid("body"))
}
pub async fn business(
    State(app): State<App>,
    Extension(arrival): Extension<Arrival>,
    Path(operation): Path<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    execute(
        app,
        String::new(),
        operation,
        headers,
        bytes,
        "business",
        arrival,
    )
    .await
}
pub(crate) struct Registration {
    pub(crate) scheduler: oas_runtime::Scheduler,
    pub(crate) request: String,
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.scheduler.unregister(&self.request);
    }
}
pub async fn execute(
    app: App,
    project: String,
    operation: String,
    headers: HeaderMap,
    bytes: Bytes,
    origin: &str,
    arrival: Arrival,
) -> Response {
    let request = headers
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .filter(|v| uuid::Uuid::parse_str(v).is_ok())
        .map(str::to_owned)
        .unwrap_or_else(id);
    let language = lang(&headers).to_owned();
    let prepared = (|| {
        if !app.ready.load(Ordering::SeqCst) {
            return Err(Error::unavailable());
        }
        if !["list", "content", "summary"].contains(&operation.as_str()) {
            return Err(oas_adapters::repository::missing());
        }
        let input = parse(&bytes)?;
        if input
            .as_object()
            .is_some_and(|obj| obj.values().any(Value::is_null))
        {
            return Err(Error::invalid("body"));
        }
        let mut command: Command =
            serde_json::from_value(input.clone()).map_err(|_| Error::invalid("body"))?;
        command.language = command
            .language
            .as_deref()
            .map(oas_domain::validation::language_tag)
            .transpose()?;
        Ok((input, command))
    })();
    let (input, command) = match prepared {
        Ok(values) => values,
        Err(error) => return reply(Err(error), &request, &language, 200),
    };
    let token = CancellationToken::new();
    let _disconnect = token.clone().drop_guard();
    if !app.scheduler.register(
        &request,
        if project.is_empty() {
            None
        } else {
            Some(project.clone())
        },
        token.clone(),
    ) {
        return reply(
            Err(Error::new(
                "REQUEST_CONFLICT",
                409,
                "请求标识已被使用。",
                "The request ID is already in use.",
            )),
            &request,
            &language,
            200,
        );
    }
    let key = if origin == "business" {
        Some(
            headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "))
                .unwrap_or("")
                .to_owned(),
        )
    } else {
        None
    };
    let origin = origin.to_owned();
    let run_id = request.clone();
    let run_language = language.clone();
    let failure_repo = app.repo.clone();
    let task = tokio::spawn(async move {
        let _registration = Registration {
            scheduler: app.scheduler.clone(),
            request: run_id.clone(),
        };
        let deadline = arrival.monotonic
            + std::time::Duration::from_secs(match operation.as_str() {
                "list" => 15,
                "content" => 15,
                _ => 45,
            });
        let draft = RequestStart {
            id: run_id.clone(),
            project: if project.is_empty() {
                None
            } else {
                Some(project)
            },
            operation: operation.clone(),
            origin,
            language: command.language.clone(),
            input,
            started_at: arrival.utc,
            retention_days: 7,
            retention_version: 1,
            snapshot: serde_json::Value::Null,
        };
        let prepared = tokio::time::timeout_at(deadline, app.repo.prepare(draft, key.as_deref()))
            .await
            .map_err(|_| Error::timeout())?;
        let (mut snapshot, start) = prepared?;
        let nodes = app.scheduler.workers();
        for endpoint in &mut snapshot.endpoints {
            if endpoint.browser() {
                endpoint.ready_pods = Some(nodes.len());
                endpoint.availability = if nodes.is_empty() {
                    "no_ready_pods"
                } else {
                    "available"
                }
                .into();
            }
        }
        let execution = app
            .engine
            .run(
                &operation,
                command,
                snapshot,
                oas_application::engine::ExecutionContext {
                    request_id: run_id.clone(),
                    ui_language: run_language,
                    cancel: token,
                    deadline,
                },
            )
            .await;
        let response = execution.response.clone();
        let duration = arrival.monotonic.elapsed().as_millis() as u64;
        let allowance = deadline
            .saturating_duration_since(tokio::time::Instant::now())
            .min(std::time::Duration::from_millis(250));
        let _ =
            tokio::time::timeout(allowance, app.repo.terminal(&start, &execution, duration)).await;
        if let Err(error) = app.traces.try_send(crate::traces::Message::Record(Box::new(
            crate::traces::Record {
                start,
                execution,
                duration,
            },
        ))) {
            app.diagnostic_counters
                .dropped
                .fetch_add(1, Ordering::Relaxed);
            tracing::warn!(request_id=%run_id,"diagnostic queue is full");
            if let crate::traces::Message::Record(record) = error.into_inner() {
                let crate::traces::Record {
                    start,
                    mut execution,
                    duration,
                } = *record;
                execution.materials.clear();
                execution.spans.clear();
                let repo = app.repo.clone();
                tokio::spawn(async move {
                    let _ = repo.terminal(&start, &execution, duration).await;
                    let _ = repo
                        .recording_failed(&start.id, "diagnostic_queue_full")
                        .await;
                });
            }
        }
        Ok::<Value, Error>(response)
    });
    match task.await {
        Ok(Ok(value)) => {
            let code = value["error"]["code"].as_str().unwrap_or("");
            let status = match code {
                "" => 200,
                "INTERNAL_ERROR" => 500,
                "CANCELLED" => 499,
                "INVALID_ARGUMENT"
                | "CONTENT_LIMIT_TOO_SMALL"
                | "LIMIT_EXCEEDED"
                | "URL_NOT_ALLOWED"
                | "QUERY_UNSUPPORTED"
                | "TIME_RANGE_UNSUPPORTED" => 400,
                "DEADLINE_EXCEEDED" | "STAGE_BUDGET_EXCEEDED" => 504,
                "SERVICE_UNAVAILABLE"
                | "PROXY_UNAVAILABLE"
                | "ENDPOINT_CONFIGURATION_CHANGED"
                | "ORIGIN_RETRY_LATER" => 503,
                "CAPACITY_EXHAUSTED" | "RATE_LIMITED" => 429,
                _ => 502,
            };
            (StatusCode::from_u16(status).unwrap(), Json(value)).into_response()
        }
        Ok(Err(error)) => reply(Err(error), &request, &language, 200),
        Err(error) => {
            tracing::error!(request_id=%request,error=%error,"request supervisor failed");
            let _ = failure_repo.interrupted(&request).await;
            reply(Err(Error::internal()), &request, &language, 200)
        }
    }
}

use crate::{App, Session, egress, search_url, timing};
use anyhow::{Context, Result};
use oas_domain::worker::WorkerCommand;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::time::Instant;

pub fn origin(engine: &str) -> String {
    if engine == "google" {
        std::env::var("OAS_TEST_GOOGLE_ORIGIN").unwrap_or_else(|_| "https://www.google.com".into())
    } else {
        std::env::var("OAS_TEST_BAIDU_ORIGIN").unwrap_or_else(|_| "https://www.baidu.com".into())
    }
}
pub async fn home(_app: &App, session: &Session, engine: &str) -> Result<()> {
    let home = origin(engine);
    let url = url::Url::parse(&home)?;
    egress::validate_host(
        url.host_str().context("home host")?,
        url.port_or_known_default().context("port")?,
    )
    .await?;
    session
        .browser
        .call(
            "home",
            json!({"engine":engine,"home":home}),
            Duration::from_secs(10),
        )
        .await?;
    Ok(())
}
pub async fn run(
    _app: &App,
    session: &Session,
    cmd: &WorkerCommand,
    trace: &timing::Trace,
) -> Result<Value> {
    let engine = cmd.engine.as_deref().unwrap_or("baidu");
    let target = search_url(cmd)?;
    let url = url::Url::parse(&target)?;
    let host = url.host_str().context("search host")?;
    let port = url.port_or_known_default().context("port")?;
    trace
        .measure("validate", egress::validate_host(host, port))
        .await?;
    session.egress.track(host, port);
    let deadline = Instant::now() + Duration::from_millis(cmd.deadline_ms);
    let remaining = || deadline.saturating_duration_since(Instant::now());
    let mut input = json!({"engine":engine,"home":origin(engine),"target":target,"query":cmd.query,"count":cmd.count});
    let prepared = trace
        .measure(
            "navigate",
            session
                .browser
                .call("prepare_search", input.clone(), remaining()),
        )
        .await?;
    for (key, value) in prepared.as_object().context("native submission receipt")? {
        input[key] = value.clone();
    }
    trace
        .measure(
            "extract",
            session.browser.call("search_results", input, remaining()),
        )
        .await
}

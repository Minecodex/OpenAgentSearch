use crate::{App, authorized};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use chrono::Utc;
use oas_domain::observation::{Phase, ProxyTest};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{process::Stdio, time::Instant};
use tokio::{io::AsyncWriteExt, process::Command};

const MARKER: &str = "\nOAS_CURL_METRICS:";
#[derive(Default, Deserialize)]
struct Metrics {
    #[serde(deserialize_with = "http_code")]
    http: u16,
    #[serde(deserialize_with = "http_code")]
    connect_http: u16,
    connect: f64,
    pretransfer: f64,
    first_byte: f64,
    total: f64,
    proxy_verify: i64,
}
fn http_code<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u16, D::Error> {
    String::deserialize(d)?
        .parse()
        .map_err(serde::de::Error::custom)
}
pub async fn handle(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    if !authorized(&headers, &app.key) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let manual = input["capability_test"] == true;
    let target = if manual {
        std::env::var("OAS_PROXY_TEST_URL").unwrap_or_else(|_| "https://example.com/".into())
    } else {
        std::env::var("OAS_TEST_GOOGLE_PROBE_URL").unwrap_or_else(|_| "https://google.com/".into())
    };
    let expected = std::env::var("OAS_PROXY_TEST_EXPECTED_STATUS")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .filter(|n| (100..=599).contains(n))
        .unwrap_or(200);
    let needle = std::env::var("OAS_PROXY_TEST_EXPECTED_BODY")
        .ok()
        .filter(|v| !v.is_empty());
    let format = format!(
        "{MARKER}{{\"http\":\"%{{response_code}}\",\"connect_http\":\"%{{http_connect}}\",\"connect\":%{{time_connect}},\"pretransfer\":%{{time_pretransfer}},\"first_byte\":%{{time_starttransfer}},\"total\":%{{time_total}},\"proxy_verify\":%{{proxy_ssl_verify_result}}}}"
    );
    let mut command = Command::new("curl");
    command
        .args([
            "--disable",
            "--silent",
            "--show-error",
            "--proxytunnel",
            "--max-time",
            "5",
            "--max-filesize",
            "1048576",
            "--output",
            if manual { "-" } else { "/dev/null" },
            "--write-out",
            &format,
            "--config",
            "-",
            &target,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let proxy = &input["proxy"];
    let config = config(proxy);
    let started = Instant::now();
    let result = async {
        let mut child = command.spawn()?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(config.as_bytes()).await?;
        }
        child.wait_with_output().await
    }
    .await;
    let elapsed = started.elapsed().as_millis() as u64;
    let (metrics, exit, stderr, body) = match result {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let (body, raw) = stdout.rsplit_once(MARKER).unwrap_or(("", "{}"));
            (
                serde_json::from_str::<Metrics>(raw).unwrap_or_default(),
                output.status.code().unwrap_or(1),
                String::from_utf8_lossy(&output.stderr).into_owned(),
                body.to_owned(),
            )
        }
        Err(_) => (Metrics::default(), 1, String::new(), String::new()),
    };
    let settings = Settings {
        proxy: proxy.is_object(),
        https_proxy: proxy["scheme"] == "https",
        expected,
        needle: if manual { needle.as_deref() } else { None },
        uid: &app.uid,
    };
    let diagnostic = evaluate(&metrics, exit, &stderr, &body, &settings, elapsed);
    if manual {
        Ok(Json(serde_json::to_value(diagnostic).unwrap()))
    } else {
        Ok(Json(
            json!({"reachable":diagnostic.reachable,"checked_at":diagnostic.checked_at,"probe_pod_uid":app.uid}),
        ))
    }
}
fn escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace(['\r', '\n'], "")
}
fn config(proxy: &Value) -> String {
    let mut config = "noproxy = \"\"\n".to_owned();
    if proxy.is_object() {
        let scheme = if proxy["scheme"] == "socks5" {
            "socks5h"
        } else {
            "https"
        };
        let host = proxy["host"].as_str().unwrap_or("");
        let host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.into()
        };
        config.push_str(&format!(
            "proxy = \"{scheme}://{}:{}\"\n",
            escape(&host),
            proxy["port"].as_u64().unwrap_or(0)
        ));
        if let Ok(ca) = std::env::var("SSL_CERT_FILE") {
            config.push_str(&format!(
                "proxy-cacert = \"{}\"\ncacert = \"{}\"\n",
                escape(&ca),
                escape(&ca)
            ));
        }
        if proxy["auth_mode"] == "password" {
            config.push_str(&format!(
                "proxy-user = \"{}:{}\"\n",
                escape(proxy["secret"]["username"].as_str().unwrap_or("")),
                escape(proxy["secret"]["password"].as_str().unwrap_or(""))
            ));
        }
    } else {
        config.push_str("proxy = \"\"\n");
    }
    config
}
fn ms(seconds: f64) -> u64 {
    if seconds.is_finite() && seconds > 0.0 {
        (seconds * 1000.0).round() as u64
    } else {
        0
    }
}
struct Settings<'a> {
    proxy: bool,
    https_proxy: bool,
    expected: u16,
    needle: Option<&'a str>,
    uid: &'a str,
}
fn evaluate(
    m: &Metrics,
    exit: i32,
    error: &str,
    body: &str,
    settings: &Settings<'_>,
    elapsed: u64,
) -> ProxyTest {
    let Settings {
        proxy,
        https_proxy,
        expected,
        needle,
        uid,
    } = *settings;
    let http = (100..=599).contains(&m.http).then_some(m.http);
    let reachable = http.is_some()
        && matches!(m.connect_http, 0 | 200)
        && !matches!(exit, 51 | 58 | 60 | 77 | 83 | 90 | 91)
        && m.proxy_verify == 0;
    let body_matches = needle.map(|text| body.contains(text));
    let passed = reachable && exit == 0 && http == Some(expected) && body_matches != Some(false);
    let lower = error.to_ascii_lowercase();
    let auth = m.connect_http == 407
        || lower.contains("authentication")
        || lower.contains("user was rejected");
    let target_unreachable = lower.contains("host unreachable")
        || lower.contains("network unreachable")
        || lower.contains("cannot complete socks5 connection")
            && ["(3)", "(4)", "(5)", "(6)"]
                .iter()
                .any(|code| lower.contains(code));
    let failure = if passed {
        None
    } else {
        Some(
            if auth {
                "proxy_auth"
            } else if m.proxy_verify != 0 || https_proxy && m.connect_http == 0 && exit == 60 {
                "proxy_tls"
            } else if m.connect_http == 403 {
                "proxy_refused"
            } else if target_unreachable {
                "target_connect"
            } else {
                match exit {
                    5 => "proxy_dns",
                    6 => "target_dns",
                    7 => {
                        if proxy {
                            "proxy_connect"
                        } else {
                            "target_connect"
                        }
                    }
                    28 => "timeout",
                    51 | 58 | 60 | 77 | 83 | 90 | 91 => "target_tls",
                    63 => "body_limit",
                    97 => "proxy_protocol",
                    0 if http != Some(expected) => "target_response",
                    0 if body_matches == Some(false) => "target_body",
                    _ => "response_incomplete",
                }
            }
            .to_owned(),
        )
    };
    let proxy_healthy = if !proxy {
        None
    } else if reachable
        || m.pretransfer > 0.0
        || m.connect_http == 200 && m.proxy_verify == 0
        || target_unreachable
    {
        Some(true)
    } else if failure.as_deref().is_some_and(|f| {
        matches!(
            f,
            "proxy_auth" | "proxy_tls" | "proxy_dns" | "proxy_connect" | "proxy_protocol"
        )
    }) {
        Some(false)
    } else {
        None
    };
    let total = if m.total > 0.0 { ms(m.total) } else { elapsed };
    let connect = ms(m.connect).min(total);
    let pretransfer = ms(m.pretransfer).clamp(connect, total);
    let connected = m.connect > 0.0 || m.pretransfer > 0.0 || reachable;
    let mut phases = Vec::new();
    let mut phase = |stage: &str, offset, duration, success| {
        phases.push(Phase {
            stage: stage.into(),
            start_offset_ms: offset,
            duration_ms: duration,
            status: if success { "success" } else { "error" }.into(),
            source: "worker".into(),
            scope: "call".into(),
            parent_stage: None,
        })
    };
    phase(
        "connect",
        0,
        if connected { connect } else { total },
        connected,
    );
    if connected {
        phase(
            "handshake",
            connect,
            if m.pretransfer > 0.0 || reachable {
                pretransfer - connect
            } else {
                total - connect
            },
            m.pretransfer > 0.0 || reachable,
        );
    }
    if m.pretransfer > 0.0 || reachable {
        phase("response", pretransfer, total - pretransfer, passed);
    }
    ProxyTest {
        reachable,
        passed,
        proxy_healthy,
        expected_status: expected,
        http_status: http,
        body_matches,
        failure_kind: failure,
        total_ms: total,
        first_byte_ms: (m.first_byte > 0.0).then(|| ms(m.first_byte)),
        phases,
        checked_at: Utc::now(),
        probe_pod_uid: uid.into(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn curl_zero_padded_codes_are_parseable_on_success_and_failure() {
        for (http, connect) in [("200", "000"), ("000", "407")] {
            let output = format!(
                r#"{{"http":"{http}","connect_http":"{connect}","connect":0.001,"pretransfer":0.002,"first_byte":0.003,"total":0.004,"proxy_verify":0}}"#
            );
            let metrics: Metrics = serde_json::from_str(&output).unwrap();
            assert_eq!(metrics.http, http.parse::<u16>().unwrap());
            assert_eq!(metrics.connect_http, connect.parse::<u16>().unwrap());
        }
    }
    #[test]
    fn submillisecond_handshake_is_not_replaced_by_the_entire_response_duration() {
        let value = evaluate(
            &Metrics {
                http: 200,
                connect: 0.0001,
                pretransfer: 0.0002,
                first_byte: 0.0004,
                total: 0.001,
                ..Default::default()
            },
            0,
            "",
            "",
            &Settings {
                proxy: true,
                https_proxy: false,
                expected: 200,
                needle: None,
                uid: "pod",
            },
            5,
        );
        crate::proof::check(
            "A09.phase_diagnostics",
            value.phases.iter().map(|p| p.duration_ms).sum::<u64>() == value.total_ms
                && value.phases[1].duration_ms == 0,
        );
    }
    #[test]
    fn manual_response_expectations_do_not_change_network_reachability() {
        for status in [200, 404, 500] {
            let m = Metrics {
                http: status,
                connect_http: 200,
                connect: 0.0002,
                pretransfer: 0.005,
                first_byte: 0.01,
                total: 0.02,
                proxy_verify: 0,
            };
            let value = evaluate(
                &m,
                0,
                "",
                "oas-probe-ok",
                &Settings {
                    proxy: true,
                    https_proxy: true,
                    expected: 200,
                    needle: Some("oas-probe-ok"),
                    uid: "pod",
                },
                20,
            );
            crate::proof::check(
                match status {
                    200 => "A09.expected_200",
                    404 => "A09.unexpected_404",
                    _ => "A09.unexpected_500",
                },
                value.reachable
                    && value.passed == (status == 200)
                    && value.proxy_healthy == Some(true),
            );
            crate::proof::check(
                "A09.phase_diagnostics",
                value.phases.len() == 3
                    && value.phases[0].status == "success"
                    && value.phases.iter().map(|p| p.duration_ms).sum::<u64>() == value.total_ms,
            );
        }
        let m = Metrics {
            http: 200,
            connect_http: 200,
            pretransfer: 0.01,
            total: 0.03,
            ..Default::default()
        };
        let value = evaluate(
            &m,
            0,
            "",
            "wrong",
            &Settings {
                proxy: true,
                https_proxy: true,
                expected: 200,
                needle: Some("expected"),
                uid: "pod",
            },
            30,
        );
        crate::proof::check(
            "A09.body_mismatch",
            !value.passed
                && value.failure_kind.as_deref() == Some("target_body")
                && value.proxy_healthy == Some(true),
        );
    }
    #[test]
    fn proxy_auth_and_tls_are_distinct_from_target_errors() {
        let auth = evaluate(
            &Metrics {
                connect_http: 407,
                connect: 0.001,
                total: 0.02,
                ..Default::default()
            },
            56,
            "",
            "",
            &Settings {
                proxy: true,
                https_proxy: true,
                expected: 200,
                needle: None,
                uid: "pod",
            },
            20,
        );
        crate::proof::check(
            "A09.auth_failure",
            !auth.passed
                && auth.failure_kind.as_deref() == Some("proxy_auth")
                && auth.proxy_healthy == Some(false),
        );
        let tls = evaluate(
            &Metrics {
                proxy_verify: 20,
                connect: 0.001,
                total: 0.02,
                ..Default::default()
            },
            60,
            "",
            "",
            &Settings {
                proxy: true,
                https_proxy: true,
                expected: 200,
                needle: None,
                uid: "pod",
            },
            20,
        );
        crate::proof::check(
            "A09.tls_failure",
            !tls.passed
                && tls.failure_kind.as_deref() == Some("proxy_tls")
                && tls.proxy_healthy == Some(false),
        );
    }
}

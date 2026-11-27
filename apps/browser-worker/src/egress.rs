use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use oas_domain::validation::public_ip;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::{JoinHandle, JoinSet},
};
use tokio_rustls::{
    TlsConnector,
    rustls::{ClientConfig, RootCertStore, pki_types::ServerName},
};
use tokio_util::sync::CancellationToken;

trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Duplex for T {}
type Stream = Box<dyn Duplex>;

#[derive(Default, Clone)]
struct Flow {
    tracking: bool,
    epoch: u64,
    target: Option<(String, u16)>,
    submitted: bool,
    connected: bool,
    failure: Option<&'static str>,
    policy: bool,
}
#[derive(Debug)]
struct Failure(&'static str);
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Failure {}
fn fault(reason: &'static str) -> anyhow::Error {
    anyhow::Error::new(Failure(reason))
}
pub struct Egress {
    pub port: u16,
    flow: Arc<Mutex<Flow>>,
    task: Option<JoinHandle<()>>,
    cancel: CancellationToken,
}
impl Egress {
    pub async fn open(proxy: Option<Value>) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let flow = Arc::new(Mutex::new(Flow::default()));
        let tracking = flow.clone();
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    _=stop.cancelled()=>break,
                    _=connections.join_next(),if !connections.is_empty()=>{},
                    accepted=listener.accept()=>{
                        let Ok((client,_))=accepted else{break};
                        let proxy=proxy.clone();let tracking=tracking.clone();
                        connections.spawn(async move{if let Err(error)=forward(client,proxy,tracking).await{tracing::warn!(error=%error,"browser egress connection failed");}});
                    }
                }
            }
            connections.abort_all();
            while connections.join_next().await.is_some() {}
        });
        Ok(Self {
            port,
            flow,
            task: Some(task),
            cancel,
        })
    }
    pub fn reset(&self) {
        let mut flow = self.flow.lock().unwrap();
        let epoch = flow.epoch + 1;
        *flow = Flow {
            epoch,
            ..Flow::default()
        };
    }
    pub fn track(&self, host: &str, port: u16) {
        let mut flow = self.flow.lock().unwrap();
        flow.tracking = true;
        flow.epoch += 1;
        flow.target = Some((host.to_ascii_lowercase(), port));
        flow.policy = false;
        flow.failure = None;
    }
    pub fn diagnostics(&self) -> Value {
        let flow = self.flow.lock().unwrap();
        serde_json::json!({"target_submitted":flow.submitted,"proxy_connected":flow.connected,"proxy_failure":flow.failure,"policy_blocked":flow.policy})
    }
}
impl Drop for Egress {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
pub async fn validate_host(host: &str, port: u16) -> Result<Vec<std::net::SocketAddr>> {
    let allowed = std::env::var("OAS_EGRESS_ALLOW_HOSTS").unwrap_or_default();
    let ips = tokio::net::lookup_host((host, port))
        .await?
        .collect::<Vec<_>>();
    if ips.is_empty() {
        bail!("destination has no addresses")
    }
    if !allowed.split(',').any(|s| s == host) && ips.iter().any(|ip| !public_ip(ip.ip())) {
        return Err(fault("policy"));
    }
    Ok(ips)
}
async fn header(stream: &mut (impl AsyncRead + Unpin + ?Sized)) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    loop {
        let n = stream.read_u8().await?;
        bytes.push(n);
        if bytes.ends_with(b"\r\n\r\n") {
            return Ok(bytes);
        }
        if bytes.len() > 16 * 1024 {
            bail!("header too large")
        }
    }
}
async fn upstream(proxy: Option<&Value>, host: &str, port: u16) -> Result<Stream> {
    let addresses = validate_host(host, port).await?;
    let Some(p) = proxy else {
        return Ok(Box::new(TcpStream::connect(addresses.as_slice()).await?));
    };
    let ph = p["host"].as_str().context("missing proxy host")?;
    let pp = p["port"].as_u64().context("missing proxy port")? as u16;
    if p["scheme"] == "socks5" {
        let stream = if p["auth_mode"] == "password" {
            tokio_socks::tcp::Socks5Stream::connect_with_password(
                (ph, pp),
                (host, port),
                p["secret"]["username"].as_str().unwrap_or(""),
                p["secret"]["password"].as_str().unwrap_or(""),
            )
            .await
        } else {
            tokio_socks::tcp::Socks5Stream::connect((ph, pp), (host, port)).await
        }
        .map_err(|error| {
            use tokio_socks::Error::*;
            fault(match error {
                PasswordAuthFailure(_)
                | NoAcceptableAuthMethods
                | AuthorizationRequired
                | InvalidAuthValues(_) => "proxy_auth",
                ConnectionNotAllowedByRuleset => "policy",
                NetworkUnreachable | HostUnreachable | ConnectionRefused | TtlExpired => {
                    "target_unreachable"
                }
                _ => "proxy_connect",
            })
        })?;
        return Ok(Box::new(stream));
    }
    let mut roots = RootCertStore::empty();
    for cert in rustls_native_certs::load_native_certs().certs {
        let _ = roots.add(cert);
    }
    let config = ClientConfig::builder_with_provider(Arc::new(
        tokio_rustls::rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_root_certificates(roots)
    .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(config));
    let socket = TcpStream::connect((ph, pp))
        .await
        .map_err(|_| fault("proxy_connect"))?;
    let mut stream = connector
        .connect(
            ServerName::try_from(ph.to_owned()).map_err(|_| fault("proxy_tls"))?,
            socket,
        )
        .await
        .map_err(|_| fault("proxy_tls"))?;
    let authority = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if p["auth_mode"] == "password" {
        let auth = STANDARD.encode(format!(
            "{}:{}",
            p["secret"]["username"].as_str().unwrap_or(""),
            p["secret"]["password"].as_str().unwrap_or("")
        ));
        request.push_str(&format!("Proxy-Authorization: Basic {auth}\r\n"));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|_| fault("proxy_io"))?;
    let response = header(&mut stream).await.map_err(|_| fault("proxy_io"))?;
    if !String::from_utf8_lossy(&response)
        .lines()
        .next()
        .is_some_and(|v| v.contains(" 200 "))
    {
        let code = String::from_utf8_lossy(&response)
            .lines()
            .next()
            .and_then(|s| s.split_whitespace().nth(1))
            .unwrap_or("")
            .to_owned();
        return Err(fault(match code.as_str() {
            "407" => "proxy_auth",
            "403" => "policy",
            "502" | "503" | "504" => "target_unreachable",
            _ => "proxy_protocol",
        }));
    }
    Ok(Box::new(stream))
}
async fn forward(
    mut client: TcpStream,
    proxy: Option<Value>,
    tracking: Arc<Mutex<Flow>>,
) -> Result<()> {
    let request = header(&mut client).await?;
    let text = std::str::from_utf8(&request)?;
    let line = text.lines().next().context("missing request")?;
    let mut parts = line.split_whitespace();
    let method = parts.next().context("method")?;
    let target = parts.next().context("target")?;
    let (host, port, url) = if method == "CONNECT" {
        let u = url::Url::parse(&format!("https://{target}"))?;
        (
            u.host_str().context("host")?.to_owned(),
            u.port_or_known_default().unwrap_or(443),
            None,
        )
    } else {
        let u = url::Url::parse(target)?;
        if u.scheme() != "http" {
            bail!("unsupported proxy request")
        }
        (
            u.host_str().context("host")?.to_owned(),
            u.port_or_known_default().unwrap_or(80),
            Some(u),
        )
    };
    let (epoch, primary) = {
        let flow = tracking.lock().unwrap();
        (
            flow.epoch,
            flow.tracking
                && flow
                    .target
                    .as_ref()
                    .is_some_and(|(h, p)| h.eq_ignore_ascii_case(&host) && *p == port),
        )
    };
    let mut remote = match upstream(proxy.as_ref(), &host, port).await {
        Ok(s) => s,
        Err(e) => {
            if let Some(failure) = e.downcast_ref::<Failure>() {
                let mut flow = tracking.lock().unwrap();
                if flow.tracking && flow.epoch == epoch {
                    match failure.0 {
                        "policy" => flow.policy = true,
                        "target_unreachable" if primary => {
                            flow.submitted = true;
                            flow.connected = proxy.is_some();
                        }
                        reason => {
                            if primary && proxy.is_some() && reason != "target_unreachable" {
                                flow.failure = Some(reason);
                            }
                        }
                    }
                }
            }
            client
                .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                .await?;
            return Err(e);
        }
    };
    {
        let mut flow = tracking.lock().unwrap();
        if primary && flow.epoch == epoch {
            flow.submitted = true;
            flow.connected = proxy.is_some();
            flow.failure = None;
        }
    }
    if let Some(url) = url {
        let path = if let Some(q) = url.query() {
            format!("{}?{q}", url.path())
        } else {
            url.path().to_owned()
        };
        let mut rewritten = format!("{method} {path} HTTP/1.1\r\n");
        for h in text.lines().skip(1).filter(|l| {
            !l.is_empty()
                && !l.to_ascii_lowercase().starts_with("proxy-")
                && !l.to_ascii_lowercase().starts_with("connection:")
        }) {
            rewritten.push_str(h);
            rewritten.push_str("\r\n");
        }
        rewritten.push_str("Connection: close\r\n\r\n");
        remote.write_all(rewritten.as_bytes()).await?;
    } else {
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await?;
    }
    tokio::io::copy_bidirectional(&mut client, &mut remote).await?;
    Ok(())
}

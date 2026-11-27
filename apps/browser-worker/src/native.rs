use crate::{
    native_protocol::{REQUEST_LIMIT, RESPONSE_LIMIT, read_frame, write_frame},
    process::BrowserProcess,
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{Cursor, Write},
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    net::UnixListener,
    process::Command,
    sync::{mpsc, oneshot},
};
use zip::{ZipWriter, write::SimpleFileOptions};

const HOST: &str = "oas.native";
const EXTENSION: &str = "native@openagentsearch.local";
type Replies = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

pub struct Browser {
    _process: BrowserProcess,
    _profile: tempfile::TempDir,
    tx: mpsc::Sender<Value>,
    replies: Replies,
    next: AtomicU64,
    task: tokio::task::JoinHandle<()>,
}

fn extension() -> Result<Vec<u8>> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let manifest = json!({"manifest_version":2,"name":"OpenAgentSearch browser controller","version":"1.0.0",
        "browser_specific_settings":{"gecko":{"id":EXTENSION}},
        "permissions":["nativeMessaging","tabs","contextualIdentities","cookies","webRequest","webRequestBlocking","<all_urls>"],
        "background":{"scripts":["config.js","search-state.js","search-readiness.js","resources.js","background.js"]},
        "content_scripts":[{"matches":["<all_urls>"],"js":["search-state.js","dom-text.js","search-material.js","google.js","baidu.js","form.js","search.js","layout.js","content.js"],"run_at":"document_start"}]});
    let files = [
        ("manifest.json", manifest.to_string()),
        (
            "config.js",
            format!(
                "const OAS_ALLOWED_HOSTS={};const OAS_NATIVE_DEBUG={};",
                json!(
                    std::env::var("OAS_EGRESS_ALLOW_HOSTS")
                        .unwrap_or_default()
                        .split(',')
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                ),
                std::env::var("OAS_NATIVE_DEBUG").as_deref() == Ok("1")
            ),
        ),
        ("resources.js", include_str!("native/resources.js").into()),
        ("background.js", include_str!("native/background.js").into()),
        ("form.js", include_str!("native/form.js").into()),
        ("dom-text.js", include_str!("native/dom-text.js").into()),
        (
            "search-material.js",
            include_str!("native/search-material.js").into(),
        ),
        ("google.js", include_str!("native/google.js").into()),
        ("baidu.js", include_str!("native/baidu.js").into()),
        (
            "search-readiness.js",
            include_str!("native/search-readiness.js").into(),
        ),
        (
            "search-state.js",
            include_str!("native/search-state.js").into(),
        ),
        ("content.js", include_str!("native/content.js").into()),
        (
            "search.js",
            format!(
                "function oasReadSearch(){{\n{}\n}}",
                include_str!("search.js")
            ),
        ),
        (
            "layout.js",
            format!(
                "function oasBuildLayout(){{\n{}\n}}",
                include_str!("layout.js")
            ),
        ),
    ];
    for (name, content) in files {
        zip.start_file(name, SimpleFileOptions::default())?;
        zip.write_all(content.as_bytes())?;
    }
    Ok(zip.finish()?.into_inner())
}

fn prepare(root: &Path, proxy_port: u16, socket: &Path, token: &str) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let profile = root.join("profile");
    let hosts = root.join("home/.mozilla/native-messaging-hosts");
    std::fs::create_dir_all(profile.join("extensions"))?;
    std::fs::create_dir_all(&hosts)?;
    std::fs::write(
        profile.join("extensions").join(format!("{EXTENSION}.xpi")),
        extension()?,
    )?;
    std::fs::write(
        hosts.join(format!("{HOST}.json")),
        json!({"name":HOST,"description":"Private OpenAgentSearch Native Messaging host",
        "path":std::env::current_exe()?,"type":"stdio","allowed_extensions":[EXTENSION]})
        .to_string(),
    )?;
    let config = hosts.join("bridge.json");
    std::fs::write(&config, json!({"socket":socket,"token":token}).to_string())?;
    std::fs::set_permissions(config, std::fs::Permissions::from_mode(0o600))?;
    let prefs = json!({
        "xpinstall.signatures.required":false,"extensions.autoDisableScopes":0,"extensions.enabledScopes":15,"extensions.startupScanScopes":15,
        "browser.startup.page":0,"browser.startup.homepage":"about:blank","browser.sessionstore.resume_from_crash":false,
        "browser.shell.checkDefaultBrowser":false,"browser.aboutwelcome.enabled":false,"browser.newtabpage.enabled":false,
        "browser.cache.disk.enable":true,"browser.cache.memory.enable":true,"browser.cache.disk.capacity":32768,
        "browser.cache.disk.parent_directory":profile.join("http-cache"),
        "network.proxy.type":1,"network.proxy.http":"127.0.0.1","network.proxy.http_port":proxy_port,
        "network.proxy.ssl":"127.0.0.1","network.proxy.ssl_port":proxy_port,"network.proxy.no_proxies_on":"","network.proxy.failover_direct":false,"network.proxy.allow_hijacking_localhost":true,
        "network.dns.disablePrefetch":true,"network.prefetch-next":false,"network.trr.mode":5,"network.http.http3.enable":false,
        "media.peerconnection.enabled":false,"media.autoplay.default":5,"media.volume_scale":"0.0",
        "dom.ipc.processCount":1,"dom.ipc.processPrelaunch.enabled":false,"dom.ipc.processCount.webIsolated":1,
        "privacy.userContext.enabled":true,"privacy.userContext.ui.enabled":true,
        "intl.accept_languages":"zh-CN,zh,en-US,en","devtools.console.stdout.content":std::env::var("OAS_NATIVE_DEBUG").as_deref()==Ok("1")
    });
    let lines = prefs
        .as_object()
        .unwrap()
        .iter()
        .map(|(key, value)| format!("user_pref({},{});", json!(key), value))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(profile.join("user.js"), lines)?;
    Ok(())
}

struct Pending {
    id: u64,
    replies: Replies,
}
impl Drop for Pending {
    fn drop(&mut self) {
        self.replies.lock().unwrap().remove(&self.id);
    }
}

impl Browser {
    pub async fn start(proxy_port: u16) -> Result<Self> {
        let root = tempfile::Builder::new().prefix("oas-native-").tempdir()?;
        let socket = root.path().join("bridge.sock");
        let listener = UnixListener::bind(&socket)?;
        let token = format!("{}{}", oas_domain::id(), oas_domain::id());
        prepare(root.path(), proxy_port, &socket, &token)?;
        let mut command =
            Command::new(std::env::var("FIREFOX_BINARY").unwrap_or_else(|_| "firefox".into()));
        let debug = std::env::var("OAS_NATIVE_DEBUG").as_deref() == Ok("1");
        command
            .args(["-headless", "-no-remote", "-profile"])
            .arg(root.path().join("profile"))
            .args(["--width", "1440", "--height", "1000", "about:blank"])
            .env("HOME", root.path().join("home"))
            .env("XDG_CONFIG_HOME", root.path().join("home/.config"))
            .env("XDG_CACHE_HOME", root.path().join("home/.cache"))
            .stdout(if debug {
                std::process::Stdio::inherit()
            } else {
                std::process::Stdio::null()
            })
            .stderr(if debug {
                std::process::Stdio::inherit()
            } else {
                std::process::Stdio::null()
            });
        let process = BrowserProcess::spawn(&mut command)?;
        let connection = tokio::time::timeout(Duration::from_secs(12), async {
            loop {
                let (mut connection, _) = listener.accept().await?;
                let hello =
                    tokio::time::timeout(Duration::from_secs(1), read_frame(&mut connection, 1024))
                        .await;
                if hello.is_ok_and(|value| value.is_ok_and(|v| v["token"] == token)) {
                    return Ok::<_, anyhow::Error>(connection);
                }
            }
        })
        .await
        .context("native host connection timed out")??;
        let (mut read, mut write) = connection.into_split();
        let (tx, mut rx) = mpsc::channel::<Value>(16);
        let replies: Replies = Arc::new(Mutex::new(HashMap::new()));
        let pending = replies.clone();
        let task = tokio::spawn(async move {
            let receive = async {
                loop {
                    let value = read_frame(&mut read, RESPONSE_LIMIT).await?;
                    if let Some(id) = value["id"].as_u64()
                        && let Some(reply) = pending.lock().unwrap().remove(&id)
                    {
                        let _ = reply.send(value);
                    }
                }
                #[allow(unreachable_code)]
                Ok::<(), anyhow::Error>(())
            };
            let send = async {
                while let Some(value) = rx.recv().await {
                    write_frame(&mut write, &value, REQUEST_LIMIT).await?;
                }
                Ok::<(), anyhow::Error>(())
            };
            tokio::select! {_=receive=>{},_=send=>{}}
            pending.lock().unwrap().clear();
        });
        let browser = Self {
            _process: process,
            _profile: root,
            tx,
            replies,
            next: AtomicU64::new(1),
            task,
        };
        let state = browser
            .call("health", json!({}), Duration::from_secs(3))
            .await?;
        if state["driver"] != "native_messaging" || state["webdriver"] != false {
            bail!("native browser automation state invalid")
        }
        Ok(browser)
    }

    pub async fn call(&self, op: &str, args: Value, timeout: Duration) -> Result<Value> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.replies.lock().unwrap().insert(id, tx);
        let _pending = Pending {
            id,
            replies: self.replies.clone(),
        };
        self.tx.send(json!({"id":id,"op":op,"args":args,"timeout_ms":timeout.as_millis().min(45000) as u64})).await.context("native host disconnected")?;
        let value = tokio::time::timeout(timeout, rx)
            .await
            .map_err(|_| anyhow::anyhow!("UPSTREAM_TIMEOUT"))?
            .context("native host disconnected")?;
        if let Some(code) = value["error"].as_str() {
            if let Some(status) = value["details"]["source_status"]
                .as_u64()
                .filter(|s| (400..600).contains(s))
            {
                return Err(anyhow::Error::new(crate::SourceStatus {
                    code: code.into(),
                    status: status as u16,
                    retry_after_ms: value["details"]["retry_after_ms"].as_i64(),
                    url: value["details"]["source_url"]
                        .as_str()
                        .unwrap_or_default()
                        .into(),
                }));
            }
            bail!(
                "{}",
                match code {
                    "ENDPOINT_RISK_CONTROL"
                    | "ACCESS_DENIED"
                    | "UPSTREAM_TIMEOUT"
                    | "SEARCH_ENGINE_UNAVAILABLE"
                    | "SEARCH_RESULTS_UNAVAILABLE"
                    | "CONTENT_UNAVAILABLE"
                    | "URL_NOT_ALLOWED" => code,
                    _ => "BROWSER_FAILED",
                }
            );
        }
        Ok(value["result"].clone())
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        self.task.abort();
    }
}

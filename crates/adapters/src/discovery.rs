use crate::{providers::Providers, repository::Repository};
use oas_domain::WorkerNode;
use oas_runtime::Scheduler;
use serde_json::Value;
use std::{collections::HashMap, time::Duration};
pub async fn pod_gone(node: &WorkerNode) -> bool {
    let check = async {
        let token =
            tokio::fs::read_to_string("/var/run/secrets/kubernetes.io/serviceaccount/token")
                .await?;
        let ca = tokio::fs::read("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt").await?;
        let ns = std::env::var("POD_NAMESPACE")?;
        let host = std::env::var("KUBERNETES_SERVICE_HOST")?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .add_root_certificate(reqwest::Certificate::from_pem(&ca)?)
            .timeout(Duration::from_secs(3))
            .build()?;
        let response = client
            .get(format!(
                "https://{host}/api/v1/namespaces/{ns}/pods/{}",
                node.name
            ))
            .bearer_auth(token.trim())
            .send()
            .await?;
        if response.status().as_u16() == 404 {
            return Ok::<bool, anyhow::Error>(true);
        }
        let value: Value = response.error_for_status()?.json().await?;
        Ok(value["metadata"]["uid"]
            .as_str()
            .is_some_and(|uid| uid != node.uid))
    }
    .await;
    check.unwrap_or(false)
}

pub async fn supervise(repo: Repository, providers: Providers, scheduler: Scheduler) {
    let mut tasks = tokio::task::JoinSet::new();
    tasks.spawn(crate::probes::warm_pages(
        repo.clone(),
        providers.clone(),
        scheduler.clone(),
    ));
    tasks.spawn(crate::probes::supervise(
        repo.clone(),
        providers.clone(),
        scheduler.clone(),
    ));
    tasks.spawn(crate::components::supervise(
        repo.clone(),
        providers.clone(),
        scheduler.clone(),
    ));
    tasks.spawn(cleanup(providers.clone(), scheduler.clone()));
    tasks.spawn(expire(repo, scheduler.clone()));
    if std::env::var("OAS_WORKERS").is_err() {
        tasks.spawn(watch_discovery(providers, scheduler.clone()));
    } else {
        tasks.spawn(static_discovery(providers, scheduler.clone()));
    }
    tokio::select! {_=scheduler.stopped()=>{},result=tasks.join_next()=>{tracing::error!(result=?result,"runtime supervisor stopped unexpectedly");scheduler.shutdown();}}
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
}
async fn cleanup(providers: Providers, scheduler: Scheduler) {
    use futures::StreamExt;
    let mut ticks = tokio::time::interval(Duration::from_secs(2));
    loop {
        tokio::select! {_=scheduler.stopped()=>break,_=ticks.tick()=>{}}
        futures::stream::iter(scheduler.pending_cleanup())
            .for_each_concurrent(4, |pending| {
                let providers = &providers;
                let scheduler = &scheduler;
                async move {
                    if providers
                        .cleanup_job(
                            &pending.node,
                            &pending.job_id,
                            pending.owner.as_deref().unwrap_or(&providers.owner),
                        )
                        .await
                        .is_err()
                    {
                        scheduler.keep_pending(pending);
                    }
                }
            })
            .await;
    }
}
async fn expire(repo: Repository, scheduler: Scheduler) {
    let mut ticks = tokio::time::interval(Duration::from_secs(
        std::env::var("OAS_HISTORY_GC_SECONDS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(5)
            .clamp(1, 86400),
    ));
    loop {
        tokio::select! {_=scheduler.stopped()=>break,_=ticks.tick()=>{}}
        for table in ["endpoint_stats_hour", "endpoint_stats_day"] {
            let _ = sqlx::query(&format!("DELETE FROM {table} WHERE last_expiry<=now()"))
                .execute(&repo.pool)
                .await;
        }
        let _ = sqlx::query("DELETE FROM sessions WHERE expires_at<=now()")
            .execute(&repo.pool)
            .await;
        if let Err(error)=sqlx::query("DELETE FROM requests WHERE id IN(SELECT id FROM requests WHERE expires_at<=now() LIMIT 100)").execute(&repo.pool).await{tracing::warn!(error=%error,"history cleanup failed");}
    }
}
async fn static_discovery(providers: Providers, scheduler: Scheduler) {
    let mut ticks = tokio::time::interval(Duration::from_secs(2));
    loop {
        tokio::select! {_=scheduler.stopped()=>break,_=ticks.tick()=>{}}
        match discover(&providers).await {
            Ok((nodes, _)) => scheduler.set_workers(nodes),
            Err(error) => {
                tracing::warn!(error=%error,"worker discovery failed");
                scheduler.set_workers(vec![]);
            }
        }
    }
}
async fn watch_discovery(providers: Providers, scheduler: Scheduler) {
    use futures::StreamExt;
    loop {
        if scheduler.is_stopping() {
            return;
        }
        let watch = async {
            let (nodes, resource_version) = discover(&providers).await?;
            scheduler.set_workers(nodes);
            let token =
                tokio::fs::read_to_string("/var/run/secrets/kubernetes.io/serviceaccount/token")
                    .await?;
            let ca =
                tokio::fs::read("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt").await?;
            let ns = std::env::var("POD_NAMESPACE")?;
            let host = std::env::var("KUBERNETES_SERVICE_HOST")?;
            let service = std::env::var("OAS_BROWSER_SERVICE")?;
            let client = reqwest::Client::builder()
                .no_proxy()
                .add_root_certificate(reqwest::Certificate::from_pem(&ca)?)
                .timeout(Duration::from_secs(35))
                .build()?;
            let response = client
                .get(format!(
                    "https://{host}/apis/discovery.k8s.io/v1/namespaces/{ns}/endpointslices"
                ))
                .query(&[
                    (
                        "labelSelector",
                        format!("kubernetes.io/service-name={service}"),
                    ),
                    ("watch", "true".into()),
                    ("resourceVersion", resource_version),
                    ("allowWatchBookmarks", "true".into()),
                    ("timeoutSeconds", "30".into()),
                ])
                .bearer_auth(token.trim())
                .send()
                .await?
                .error_for_status()?;
            let mut stream = response.bytes_stream();
            let mut pending = Vec::new();
            while let Some(bytes) = stream.next().await {
                pending.extend_from_slice(&bytes?);
                while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                    let line = pending.drain(..=end).collect::<Vec<_>>();
                    let event: Value = serde_json::from_slice(&line)?;
                    if event["type"] != "BOOKMARK" {
                        let (nodes, _) = discover(&providers).await?;
                        scheduler.set_workers(nodes);
                    }
                }
                if pending.len() > 1024 * 1024 {
                    anyhow::bail!("discovery event exceeds limit")
                }
            }
            Ok::<(), anyhow::Error>(())
        }
        .await;
        if watch.is_err() {
            scheduler.set_workers(vec![]);
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }
}
async fn discover(p: &Providers) -> anyhow::Result<(Vec<WorkerNode>, String)> {
    if let Ok(raw) = std::env::var("OAS_WORKERS") {
        let nodes = serde_json::from_str::<Vec<WorkerNode>>(&raw)?;
        use futures::StreamExt;
        let ready = futures::stream::iter(nodes)
            .map(|mut node| async move {
                let response = p
                    .client
                    .get(format!("{}/health/ready", node.address))
                    .timeout(Duration::from_secs(2))
                    .send()
                    .await
                    .ok()?;
                if !response.status().is_success() {
                    return None;
                }
                let value: Value = response.json().await.ok()?;
                if value["status"] != "ready" || value["pod_uid"] != node.uid {
                    return None;
                }
                node.boot_id = value["boot_id"].as_str().unwrap_or("").into();
                Some(node)
            })
            .buffer_unordered(8)
            .filter_map(|n| async move { n })
            .collect()
            .await;
        return Ok((ready, String::new()));
    }
    let token =
        tokio::fs::read_to_string("/var/run/secrets/kubernetes.io/serviceaccount/token").await?;
    let ca = tokio::fs::read("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt").await?;
    let namespace = std::env::var("POD_NAMESPACE").unwrap_or_else(|_| "default".into());
    let service = std::env::var("OAS_BROWSER_SERVICE").unwrap_or_else(|_| "oas-browser".into());
    let host = std::env::var("KUBERNETES_SERVICE_HOST")?;
    let port = std::env::var("KUBERNETES_SERVICE_PORT_HTTPS").unwrap_or_else(|_| "443".into());
    let client = reqwest::Client::builder()
        .no_proxy()
        .add_root_certificate(reqwest::Certificate::from_pem(&ca)?)
        .timeout(Duration::from_secs(5))
        .build()?;
    let data: Value = client
        .get(format!(
            "https://{host}:{port}/apis/discovery.k8s.io/v1/namespaces/{namespace}/endpointslices"
        ))
        .query(&[(
            "labelSelector",
            format!("kubernetes.io/service-name={service}"),
        )])
        .bearer_auth(token.trim())
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let mut found: HashMap<String, WorkerNode> = HashMap::new();
    for slice in data["items"].as_array().into_iter().flatten() {
        for endpoint in slice["endpoints"].as_array().into_iter().flatten() {
            if endpoint["conditions"]["ready"] != true
                || endpoint["conditions"]["terminating"] == true
            {
                continue;
            }
            let uid = endpoint["targetRef"]["uid"].as_str().unwrap_or("");
            let name = endpoint["targetRef"]["name"].as_str().unwrap_or("");
            if let Some(ip) = endpoint["addresses"][0].as_str() {
                found.insert(
                    uid.into(),
                    WorkerNode {
                        uid: uid.into(),
                        name: name.into(),
                        address: format!("http://{}:8090", authority(ip)),
                        slots: std::env::var("OAS_BROWSER_SLOTS")
                            .ok()
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(oas_domain::worker::DEFAULT_BROWSER_SLOTS),
                        boot_id: String::new(),
                    },
                );
            }
        }
    }
    Ok((
        found.into_values().collect(),
        data["metadata"]["resourceVersion"]
            .as_str()
            .unwrap_or("")
            .into(),
    ))
}

fn authority(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.into()
    }
}

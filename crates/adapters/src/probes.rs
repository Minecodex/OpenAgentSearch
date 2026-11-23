use crate::{providers::Providers, repository::Repository};
use oas_domain::{Error, Result, WorkerNode};
use oas_runtime::{ProbePlanner, ProbeTicket, Scheduler, SystemClock};
use serde_json::{Value, json};
use sqlx::Row;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::task::{AbortHandle, JoinSet};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
enum Work {
    Google(ProbeTicket),
    Health {
        proxy: Value,
        node: WorkerNode,
        revision: i64,
    },
}
impl Work {
    fn id(&self) -> &str {
        match self {
            Self::Google(t) => &t.id,
            Self::Health { proxy, .. } => proxy["id"].as_str().unwrap(),
        }
    }
    fn version(&self) -> i64 {
        match self {
            Self::Google(t) => t.version,
            Self::Health { proxy, .. } => proxy["version"].as_i64().unwrap(),
        }
    }
    fn node(&self) -> &WorkerNode {
        match self {
            Self::Google(t) => &t.node,
            Self::Health { node, .. } => node,
        }
    }
    fn same(&self, other: &Work) -> bool {
        self.id() == other.id()
            && self.version() == other.version()
            && self.node().uid == other.node().uid
            && match (self, other) {
                (Self::Google(a), Self::Google(b)) => a.generation == b.generation,
                (Self::Health { revision: a, .. }, Self::Health { revision: b, .. }) => a == b,
                _ => false,
            }
    }
}
struct Active {
    work: Work,
    cancel: CancellationToken,
    abort: AbortHandle,
}
pub async fn supervise(repo: Repository, providers: Providers, scheduler: Scheduler) {
    let mut planner = ProbePlanner::new(Arc::new(SystemClock));
    let mut seeded = false;
    let mut active = HashMap::<String, Active>::new();
    let mut jobs = JoinSet::<(Work, Result<Value>)>::new();
    let mut ticks = tokio::time::interval(Duration::from_millis(500));
    loop {
        tokio::select! {
                _=scheduler.stopped()=>break,
                Some(result)=jobs.join_next(),if !jobs.is_empty()=>{
                 match result{
                  Ok((work,result))=>{
                   let current=active.get(work.id()).is_some_and(|a|a.work.same(&work)&&!a.cancel.is_cancelled());
                   if current{
                    match &work{
                     Work::Google(ticket)=>{let due=planner.next_due(ticket);let received=match result{Ok(value)if due.is_some()=>publish(&repo,ticket,&value,due.unwrap()).await.unwrap_or(false),_=>false};planner.complete_at(ticket,received,due);},
                     Work::Health{proxy,revision,..}=>{
                      let id=proxy["id"].as_str().unwrap();let version=work.version();
                      let state=match result{Ok(value)=>match value["proxy_healthy"].as_bool(){Some(healthy)=>scheduler.finish_health_probe(id,version,*revision,healthy),None=>{scheduler.abort_health_probe(id,version,*revision);None}},Err(_)=>{scheduler.abort_health_probe(id,version,*revision);None}};
                      if let Some(state)=state{let _=repo.proxy_state(id,version,&state).await;}
                     }
                    }
                    active.remove(work.id());
                   }
                  },Err(error)=>{
                   tracing::warn!(error=%error,"egress probe task failed");
                   let finished=active.iter().filter(|(_,a)|a.abort.is_finished()).map(|(id,_)|id.clone()).collect::<Vec<_>>();
                   for id in finished{if let Some(task)=active.remove(&id){cancel_work(&scheduler,&mut planner,&task.work);}}
                  }
                 }
                },
                _=ticks.tick()=>{
                 let Ok(proxies)=repo.resources("proxies").await else{continue};for proxy in &proxies{let _=scheduler.proxy_view(proxy);}
                 let nodes=scheduler.workers();let mut targets=vec![("default_network".into(),default_version())];targets.extend(proxies.iter().filter(|p|p["enabled"]==true).map(|p|(p["id"].as_str().unwrap().into(),p["version"].as_i64().unwrap())));planner.sync(&targets);
                 if !seeded
                  && let Ok(rows)=sqlx::query("SELECT egress_id,version,body FROM probes").fetch_all(&repo.pool).await{for row in rows{let value:Value=row.get("body");if let Some(checked)=value["checked_at"].as_str().and_then(|v|chrono::DateTime::parse_from_rfc3339(v).ok()){planner.seed_due(&row.get::<String,_>("egress_id"),row.get("version"),checked.timestamp_millis(),value["_next_due_at"].as_i64());}}seeded=true;}
                 let stale=active.iter().filter(|(id,a)|!targets.iter().any(|(current,version)|current==*id&&*version==a.work.version())||!nodes.iter().any(|n|n.uid==a.work.node().uid)).map(|(id,_)|id.clone()).collect::<Vec<_>>();
                 for id in stale{if let Some(task)=active.remove(&id){task.cancel.cancel();task.abort.abort();cancel_work(&scheduler,&mut planner,&task.work);}}
                 let excluded=active.keys().cloned().collect::<Vec<_>>();let capacity=4usize.saturating_sub(active.len());
                 for ticket in planner.due(&nodes,capacity,&excluded){launch(Work::Google(ticket),&repo,&providers,&mut jobs,&mut active);}
                 if let Some(node)=nodes.iter().min_by(|a,b|a.uid.cmp(&b.uid)){
                  for(id,version)in scheduler.health_due(&proxies){if active.len()>=4{break}
        if active.contains_key(&id){continue}
        if let Some(proxy)=proxies.iter().find(|p|p["id"]==id)&&let Some(state)=scheduler.begin_health_probe(&id,version){let _=repo.proxy_state(&id,version,&state).await;launch(Work::Health{proxy:proxy.clone(),node:node.clone(),revision:state["health_revision"].as_i64().unwrap()},&repo,&providers,&mut jobs,&mut active);}}
                 }
                }
               }
    }
    for task in active.into_values() {
        task.cancel.cancel();
        task.abort.abort();
    }
    jobs.abort_all();
    while jobs.join_next().await.is_some() {}
}
fn launch(
    work: Work,
    repo: &Repository,
    p: &Providers,
    jobs: &mut JoinSet<(Work, Result<Value>)>,
    active: &mut HashMap<String, Active>,
) {
    let repo = repo.clone();
    let p = p.clone();
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    let task = work.clone();
    let abort=jobs.spawn(async move{let result=tokio::select!{_=stop.cancelled()=>Err(Error::cancelled()),value=execute(&repo,&p,&task)=>value};(task,result)});
    active.insert(
        work.id().into(),
        Active {
            work,
            cancel,
            abort,
        },
    );
}
fn cancel_work(s: &Scheduler, planner: &mut ProbePlanner, work: &Work) {
    match work {
        Work::Google(t) => planner.cancel(t),
        Work::Health {
            proxy, revision, ..
        } => s.abort_health_probe(proxy["id"].as_str().unwrap(), work.version(), *revision),
    }
}
async fn execute(repo: &Repository, p: &Providers, work: &Work) -> Result<Value> {
    let mut proxy = if work.id() == "default_network" {
        None
    } else {
        let proxy = repo.resource("proxies", work.id()).await?;
        if proxy["version"].as_i64() != Some(work.version()) || proxy["enabled"] != true {
            return Err(Error::cancelled());
        }
        Some(proxy)
    };
    if let Some(proxy) = &mut proxy {
        let secret = sqlx::query_scalar::<_, Option<Vec<u8>>>(
            "SELECT secret FROM resources WHERE id=$1 AND version=$2 AND NOT archived",
        )
        .bind(uuid::Uuid::parse_str(work.id()).unwrap())
        .bind(work.version())
        .fetch_optional(&repo.pool)
        .await
        .map_err(|_| Error::internal())?
        .flatten();
        if let Some(secret) = secret {
            proxy["secret"] = repo.secrets.decrypt(&secret)?;
        }
    }
    let response = p
        .client
        .post(format!("{}/internal/probe", work.node().address))
        .bearer_auth(&p.worker_key)
        .json(&json!({"proxy":proxy,"capability_test":matches!(work,Work::Health{..})}))
        .timeout(Duration::from_secs(7))
        .send()
        .await
        .map_err(|_| Error::unavailable())?;
    if !response.status().is_success() {
        return Err(Error::unavailable());
    }
    let value: Value = response.json().await.map_err(|_| Error::unavailable())?;
    if !value["reachable"].is_boolean() || value["probe_pod_uid"] != work.node().uid {
        return Err(Error::unavailable());
    }
    Ok(value)
}
async fn publish(
    repo: &Repository,
    ticket: &ProbeTicket,
    value: &Value,
    next_due: i64,
) -> Result<bool> {
    let mut value = value.clone();
    value["_next_due_at"] = json!(next_due);
    let generation: i64 = sqlx::query_scalar("SELECT nextval('oas_probe_generation')")
        .fetch_one(&repo.pool)
        .await
        .map_err(|_| Error::internal())?;
    let result=sqlx::query("INSERT INTO probes(egress_id,version,body,generation) SELECT $1,$2,$3,$4 WHERE $1='default_network' OR EXISTS(SELECT 1 FROM resources WHERE id::text=$1 AND version=$2 AND NOT archived AND body->>'enabled'='true') ON CONFLICT(egress_id) DO UPDATE SET version=EXCLUDED.version,body=EXCLUDED.body,generation=EXCLUDED.generation WHERE probes.generation<EXCLUDED.generation AND (EXCLUDED.egress_id<>'default_network' OR probes.version<=EXCLUDED.version)")
  .bind(&ticket.id).bind(ticket.version).bind(value).bind(generation).execute(&repo.pool).await.map_err(|_|Error::internal())?;
    Ok(result.rows_affected() > 0)
}
pub fn default_version() -> i64 {
    std::env::var("OAS_DEFAULT_NETWORK_VERSION")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(1)
}

/// Publish current egress/probe pairs to every Pod, including those that did not run the shared probe.
pub async fn warm_pages(repo: Repository, providers: Providers, scheduler: Scheduler) {
    use futures::StreamExt;
    use sqlx::Row;
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    loop {
        tokio::select! {_=scheduler.stopped()=>break,_=interval.tick()=>{}}
        let nodes = scheduler.workers();
        if nodes.is_empty() {
            continue;
        }
        let rows=sqlx::query("SELECT p.body->'reachable' reachable,r.body proxy,r.secret,h.failure_code FROM probes p LEFT JOIN browser_engine_health h ON h.egress_id=p.egress_id AND h.version=p.version AND h.retry_at>clock_timestamp() LEFT JOIN resources r ON r.id::text=p.egress_id AND r.version=p.version AND r.kind='proxies' AND NOT r.archived AND r.body->>'enabled'='true' WHERE (p.egress_id='default_network' AND p.version=$1) OR r.id IS NOT NULL ORDER BY (p.egress_id='default_network') DESC,p.egress_id")
            .bind(default_version()).fetch_all(&repo.pool).await;
        let Ok(rows) = rows else { continue };
        let mut routes = Vec::new();
        for row in rows {
            let Some(ok) = row
                .get::<Option<Value>, _>("reachable")
                .and_then(|v| v.as_bool())
            else {
                continue;
            };
            let mut proxy = row.get::<Option<Value>, _>("proxy");
            if proxy.as_ref().is_some_and(|p| {
                matches!(
                    scheduler.proxy_view(p)["health"].as_str(),
                    Some("cooling" | "probing" | "disabled")
                )
            }) {
                continue;
            }
            if let (Some(p), Some(enc)) = (&mut proxy, row.get::<Option<Vec<u8>>, _>("secret")) {
                let Ok(secret) = repo.secrets.decrypt(&enc) else {
                    continue;
                };
                p["secret"] = secret;
            }
            routes.push(json!({"proxy":proxy,"engine":if ok && row.get::<Option<String>,_>("failure_code").is_none() {"google"}else{"baidu"}}));
        }
        futures::stream::iter(nodes)
            .for_each_concurrent(4, |node| {
                let req = providers
                    .client
                    .post(format!("{}/internal/search-pages", node.address))
                    .bearer_auth(&providers.worker_key)
                    .json(&routes)
                    .timeout(Duration::from_secs(2));
                async move {
                    let _ = req.send().await;
                }
            })
            .await;
    }
}

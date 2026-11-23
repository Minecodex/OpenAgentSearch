use crate::{providers::Providers, repository::Repository};
use futures::StreamExt;
use oas_runtime::Scheduler;
use std::time::Duration;

/// Availability is a direct component readiness signal, never an aggregate of
/// business observations. External instances are not managed by this loop.
pub async fn supervise(repo: Repository, providers: Providers, scheduler: Scheduler) {
    let mut ticks = tokio::time::interval(Duration::from_secs(10));
    loop {
        tokio::select! {_=scheduler.stopped()=>break,_=ticks.tick()=>{}}
        let Ok(endpoints) = repo.resources("endpoints").await else {
            continue;
        };
        futures::stream::iter(endpoints.into_iter().filter(|e|e["managed_by"]=="helm"&&e["availability"]!="component_disabled"))
        .for_each_concurrent(2,|endpoint|{let repo=&repo;let providers=&providers;async move {
            let path=if endpoint["provider"]=="searxng"{"/healthz"}else{"/health"};
            let mut request=providers.client.get(format!("{}{}",endpoint["base_url"].as_str().unwrap_or("").trim_end_matches('/'),path)).timeout(Duration::from_secs(3));
            if endpoint["provider"]=="crawl4ai"&&let Ok(Some(secret))=sqlx::query_scalar::<_,Option<Vec<u8>>>("SELECT secret FROM resources WHERE id::text=$1").bind(endpoint["id"].as_str().unwrap_or("")).fetch_one(&repo.pool).await&&let Ok(secret)=repo.secrets.decrypt(&secret)&&let Some(key)=secret["api_key"].as_str(){request=request.bearer_auth(key);}
            let available=request.send().await.is_ok_and(|r|r.status().is_success());
            let availability=if available{"available"}else{"component_unready"};
            if endpoint["availability"]!=availability {
                let _=sqlx::query("UPDATE resources SET body=jsonb_set(body,'{availability}',to_jsonb($3::text)) WHERE id::text=$1 AND version=$2 AND body->>'managed_by'='helm' AND body->>'availability'<>'component_disabled'").bind(endpoint["id"].as_str().unwrap_or("")).bind(endpoint["version"].as_i64().unwrap_or(1)).bind(availability).execute(&repo.pool).await;
            }
        }}).await;
    }
}

use super::{CacheMetadata, management};
use crate::repository::db;
use oas_application::cache::{CacheHandler, Metadata};
use oas_domain::{Result, cache::*};
use serde_json::{Value, json};
use sqlx::Row;
use std::collections::{BTreeMap, BTreeSet};

enum Valkey {
    Single(redis::aio::ConnectionManager),
    Cluster(redis::cluster_async::ClusterConnection),
}
impl Valkey {
    async fn connect() -> Option<Self> {
        let password = std::env::var("OAS_CACHE_VALKEY_PASSWORD").unwrap_or_default();
        let authenticated = |raw: &str| -> Option<String> {
            let mut url = url::Url::parse(raw).ok()?;
            if !password.is_empty() {
                url.set_password(Some(&password)).ok()?;
            }
            Some(url.to_string())
        };
        if let Ok(nodes) = std::env::var("OAS_CACHE_VALKEY_CLUSTER_NODES") {
            let nodes = nodes
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(authenticated)
                .collect::<Option<Vec<_>>>()?;
            let client = redis::cluster::ClusterClient::new(nodes).ok()?;
            Some(Self::Cluster(client.get_async_connection().await.ok()?))
        } else {
            let client =
                redis::Client::open(authenticated(&std::env::var("OAS_CACHE_VALKEY_URL").ok()?)?)
                    .ok()?;
            Some(Self::Single(client.get_connection_manager().await.ok()?))
        }
    }
    async fn pipeline(&mut self, pipe: &redis::Pipeline) -> bool {
        match self {
            Self::Single(c) => pipe.query_async::<()>(c).await.is_ok(),
            Self::Cluster(c) => pipe.query_async::<()>(c).await.is_ok(),
        }
    }
}
pub async fn refresh(
    metadata: &CacheMetadata,
    binding: &Binding,
    handler: &dyn CacheHandler,
) -> Result<()> {
    let defaults = management::settings(&metadata.repo, "cache-policy").await?;
    let projects=sqlx::query("SELECT id::text AS scope,body FROM resources WHERE kind='projects' AND NOT archived AND body->>'cache_enabled'='true' UNION ALL SELECT DISTINCT scope,'{}'::jsonb AS body FROM cache_registry WHERE scope LIKE 'admin:%'")
        .fetch_all(&metadata.repo.pool).await.map_err(db)?;
    let now = chrono::Utc::now().timestamp_millis();
    let mut valkey = tokio::time::timeout(std::time::Duration::from_secs(1), Valkey::connect())
        .await
        .ok()
        .flatten();
    for project in projects {
        let scope: String = project.get("scope");
        let body: Value = project.get("body");
        for kind in ["list", "content"] {
            let policy = body["cache_policy"][kind]
                .as_object()
                .map(|_| &body["cache_policy"][kind])
                .unwrap_or(&defaults[kind]);
            let policy: HotPolicy = serde_json::from_value(policy.clone())
                .map_err(|_| oas_domain::Error::invalid("cache_policy"))?;
            let total = sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM cache_registry WHERE scope=$1 AND kind=$2",
            )
            .bind(&scope)
            .bind(kind)
            .fetch_one(&metadata.repo.pool)
            .await
            .map_err(db)?;
            let ktotal = handler.hot_slots(&policy, total as usize, false) as i64;
            let krecent = handler.hot_slots(&policy, total as usize, true) as i64;
            let top=sqlx::query_scalar::<_,String>("SELECT object_id FROM cache_registry WHERE scope=$1 AND kind=$2 AND total>0 ORDER BY total DESC,object_id LIMIT $3")
                .bind(&scope).bind(kind).bind(ktotal).fetch_all(&metadata.repo.pool).await.map_err(db)?.into_iter().collect::<BTreeSet<_>>();
            let recent=sqlx::query_scalar::<_,String>("SELECT object_id FROM cache_heat_buckets WHERE scope=$1 AND kind=$2 AND bucket>=$3 AND bucket<$4 GROUP BY object_id HAVING sum(count)>0 ORDER BY sum(count) DESC,object_id LIMIT $5")
                .bind(&scope).bind(kind).bind(now-policy.recent_window_hours as i64*3600000).bind(now).bind(krecent).fetch_all(&metadata.repo.pool).await.map_err(db)?.into_iter().collect::<BTreeSet<_>>();
            let union = top.union(&recent).cloned().collect::<Vec<_>>();
            let entries=union.iter().map(|id|json!({"object_id":id,"total_hot":top.contains(id),"recent_hot":recent.contains(id)})).collect::<Vec<_>>();
            let mut tx = metadata.repo.pool.begin().await.map_err(db)?;
            sqlx::query("DELETE FROM cache_hot_members WHERE scope=$1 AND kind=$2")
                .bind(&scope)
                .bind(kind)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            sqlx::query("INSERT INTO cache_hot_members(scope,kind,object_id,total_hot,recent_hot,as_of) SELECT $1,$2,x.object_id,x.total_hot,x.recent_hot,$4 FROM jsonb_to_recordset($3::jsonb) AS x(object_id text,total_hot boolean,recent_hot boolean)")
                .bind(&scope).bind(kind).bind(json!(entries)).bind(now).execute(&mut *tx).await.map_err(db)?;
            sqlx::query("INSERT INTO cache_hot_boards(scope,kind,as_of) VALUES($1,$2,$3) ON CONFLICT(scope,kind) DO UPDATE SET as_of=$3")
                .bind(&scope).bind(kind).bind(now).execute(&mut *tx).await.map_err(db)?;
            tx.commit().await.map_err(db)?;
            if let Some(client) = &mut valkey {
                let mut shards = BTreeMap::<usize, Vec<&String>>::new();
                for id in &union {
                    let shard = usize::from_str_radix(&hash(id)[..4], 16).unwrap_or(0) % 16;
                    shards.entry(shard).or_default().push(id);
                }
                for (shard, ids) in shards {
                    let key = format!("oas:hot:{{{scope}:{kind}:{shard}}}:{now}");
                    let mut pipe = redis::pipe();
                    pipe.cmd("SADD")
                        .arg(&key)
                        .arg(ids)
                        .ignore()
                        .cmd("EXPIRE")
                        .arg(&key)
                        .arg(180)
                        .ignore();
                    if !client.pipeline(&pipe).await {
                        valkey = None;
                        break;
                    }
                }
            }
        }
    }
    schedule(metadata, binding, handler, now).await?;
    sqlx::query("DELETE FROM cache_heat_buckets WHERE bucket<$1")
        .bind(now - 2160 * 3600000)
        .execute(&metadata.repo.pool)
        .await
        .map_err(db)?;
    sqlx::query("DELETE FROM cache_usage WHERE at<$1")
        .bind(now - 7 * 86400000)
        .execute(&metadata.repo.pool)
        .await
        .map_err(db)?;
    sqlx::query("DELETE FROM cache_jobs WHERE finished_at<$1 AND state NOT IN ('waiting','retry','running')").bind(now-7*86400000).execute(&metadata.repo.pool).await.map_err(db)?;
    Ok(())
}
async fn schedule(
    metadata: &CacheMetadata,
    binding: &Binding,
    handler: &dyn CacheHandler,
    now: i64,
) -> Result<()> {
    let expired=sqlx::query("SELECT DISTINCT ON (s.scope,s.question) s.scope,s.body,s.collected_at,r.body AS project_body FROM cache_snapshots s JOIN cache_enabled_scopes a ON a.scope=s.scope AND a.access_epoch=s.access_epoch JOIN cache_hot_members h ON h.scope=s.scope AND h.kind='list' AND h.object_id=s.question LEFT JOIN resources r ON r.id::text=s.scope WHERE s.namespace=$1 AND s.expires_at<=$2 AND NOT EXISTS(SELECT FROM cache_snapshots newer WHERE newer.namespace=s.namespace AND newer.scope=s.scope AND newer.question=s.question AND newer.access_epoch=s.access_epoch AND newer.expires_at>$2) AND NOT EXISTS(SELECT 1 FROM cache_expiry_marks e WHERE e.namespace=s.namespace AND e.scope=s.scope AND e.kind='list' AND e.target=s.question AND e.generation=s.collected_at) ORDER BY s.scope,s.question,s.collected_at DESC LIMIT 256")
        .bind(&binding.namespace).bind(now).fetch_all(&metadata.repo.pool).await.map_err(db)?;
    for row in expired {
        let Ok(snapshot) = serde_json::from_value::<SearchSnapshot>(row.get("body")) else {
            continue;
        };
        let Some(scope) = scope(&row) else { continue };
        metadata
            .enqueue(
                &scope,
                binding,
                &handler.on_expired(
                    "list",
                    &snapshot.question,
                    0,
                    json!({"query":snapshot.query,"expired_generation":snapshot.collected_at}),
                ),
                "hot_expiry",
            )
            .await?;
    }
    let expired=sqlx::query("SELECT p.scope,p.body,p.collected_at,r.body AS project_body FROM cache_pages p JOIN cache_enabled_scopes a ON a.scope=p.scope AND a.access_epoch=p.access_epoch JOIN cache_hot_members h ON h.scope=p.scope AND h.kind='content' AND h.object_id=p.page_key LEFT JOIN resources r ON r.id::text=p.scope WHERE p.namespace=$1 AND p.expires_at<=$2 AND NOT EXISTS(SELECT 1 FROM cache_expiry_marks e WHERE e.namespace=p.namespace AND e.scope=p.scope AND e.kind='content' AND e.target=p.page_key AND e.generation=p.collected_at) AND NOT EXISTS(SELECT 1 FROM cache_page_states s WHERE s.scope=p.scope AND s.page_key=p.page_key AND s.status IN (-1,401,403,410)) ORDER BY p.expires_at LIMIT 256")
        .bind(&binding.namespace).bind(now).fetch_all(&metadata.repo.pool).await.map_err(db)?;
    for row in expired {
        let Ok(page) = serde_json::from_value::<Page>(row.get("body")) else {
            continue;
        };
        let Some(scope) = scope(&row) else { continue };
        metadata
            .enqueue(
                &scope,
                binding,
                &handler.on_expired(
                    "content",
                    &page.key,
                    page.object_epoch,
                    json!({"url":page.url,"expired_generation":page.collected_at}),
                ),
                "hot_expiry",
            )
            .await?;
    }
    Ok(())
}
fn scope(row: &sqlx::postgres::PgRow) -> Option<Scope> {
    if let Ok(body) = row.try_get::<Value, _>("project_body") {
        let project = serde_json::from_value::<oas_domain::Project>(body).ok()?;
        if project.cache_enabled {
            return Some(Scope::from_project(&project));
        }
    }
    let name: String = row.get("scope");
    name.starts_with("admin:").then(|| Scope {
        project: name,
        epoch: 0,
        access_epoch: -1,
        sources: [
            oas_domain::BROWSER_READER.into(),
            oas_domain::BROWSER_SEARCH.into(),
        ]
        .into(),
        lease: None,
        summary_version: None,
    })
}

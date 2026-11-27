pub(crate) mod access;
mod clients;
pub mod garbage;
pub mod hotness;
mod index_gc;
pub mod jobs;
pub mod management;
mod matcher;
mod metadata;
mod selection;
use crate::repository::{Repository, db};
pub use clients::{HttpEmbedding, QdrantIndex, S3Objects};
pub use metadata::CacheMetadata;
use oas_application::cache::{CacheHandler, CacheService, CacheSettings, handler_for};
use oas_domain::{Result, cache::Binding};
use sqlx::Row;
use std::sync::Arc;

pub async fn build(repo: Repository) -> Result<Arc<CacheService>> {
    let name = std::env::var("OAS_CACHE_HANDLER").unwrap_or_else(|_| "v1".into());
    let matcher = if name == "v2" {
        Some(Arc::new(matcher::HttpMatcher::from_env()?)
            as Arc<dyn oas_application::cache::ReuseMatcher>)
    } else {
        None
    };
    build_with_handler(repo, handler_for(&name, matcher)?).await
}
pub async fn build_with_handler(
    repo: Repository,
    strategy: Arc<dyn CacheHandler>,
) -> Result<Arc<CacheService>> {
    let handler = strategy.version().to_owned();
    let schema = strategy.schema_version();
    let payload = strategy.payload_version();
    if schema < 1 || payload < 1 {
        return Err(oas_domain::Error::invalid("handler_version"));
    }
    let settings = CacheSettings::from_env()?;
    let mut tx = repo.pool.begin().await.map_err(db)?;
    sqlx::query("INSERT INTO cache_control(singleton,handler,namespace,activation,schema_version,payload_version) VALUES(true,$1,$2,1,$3,$4) ON CONFLICT DO NOTHING")
        .bind(&handler).bind(oas_domain::id()).bind(schema).bind(payload).execute(&mut *tx).await.map_err(db)?;
    let row=sqlx::query("SELECT handler,namespace,activation,schema_version,payload_version FROM cache_control WHERE singleton FOR UPDATE").fetch_one(&mut *tx).await.map_err(db)?;
    let mut binding = Binding {
        handler: row.get("handler"),
        namespace: row.get("namespace"),
        activation: row.get("activation"),
    };
    if binding.handler != handler
        || row.get::<i32, _>("schema_version") != schema
        || row.get::<i32, _>("payload_version") != payload
    {
        binding = Binding {
            handler,
            namespace: oas_domain::id(),
            activation: binding.activation + 1,
        };
        sqlx::query("UPDATE cache_control SET handler=$1,namespace=$2,activation=$3,schema_version=$4,payload_version=$5 WHERE singleton").bind(&binding.handler).bind(&binding.namespace).bind(binding.activation).bind(schema).bind(payload).execute(&mut *tx).await.map_err(db)?;
    }
    sqlx::query("UPDATE cache_jobs SET state='ignored',last_error='version_mismatch',finished_at=$1 WHERE state IN ('waiting','retry','running') AND (handler<>$2 OR namespace<>$3 OR activation<>$4 OR payload_version<>$5)")
        .bind(chrono::Utc::now().timestamp_millis()).bind(&binding.handler).bind(&binding.namespace).bind(binding.activation).bind(payload).execute(&mut *tx).await.map_err(db)?;
    sqlx::query("UPDATE cache_jobs SET lease_until=$1 WHERE state='running'")
        .bind(chrono::Utc::now().timestamp_millis())
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    sqlx::query("INSERT INTO cache_namespaces(namespace) VALUES($1) ON CONFLICT DO NOTHING")
        .bind(&binding.namespace)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    tx.commit().await.map_err(db)?;
    let encoding = Arc::new(HttpEmbedding::new()?);
    use oas_application::cache::Embedding;
    garbage::limits()?;
    sqlx::query("INSERT INTO cache_index_control(namespace,encoding,ready) VALUES($1,$2,NOT EXISTS(SELECT 1 FROM cache_snapshots WHERE namespace=$1 AND expires_at>$3)) ON CONFLICT(namespace) DO UPDATE SET encoding=$2,ready=CASE WHEN cache_index_control.encoding=$2 THEN cache_index_control.ready ELSE NOT EXISTS(SELECT 1 FROM cache_snapshots WHERE namespace=$1 AND expires_at>$3) END")
        .bind(&binding.namespace).bind(encoding.version()).bind(chrono::Utc::now().timestamp_millis()).execute(&repo.pool).await.map_err(db)?;
    let index = Arc::new(QdrantIndex::new(&binding, &encoding));
    let objects = Arc::new(S3Objects::new()?);
    let metadata = Arc::new(CacheMetadata {
        repo,
        settings: settings.clone(),
    });
    Ok(Arc::new(CacheService {
        metadata,
        index,
        embedding: encoding,
        objects,
        handler: strategy,
        binding,
        settings,
    }))
}

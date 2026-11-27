//! Metadata pointers are withdrawn before deleting immutable objects. History
//! owns frozen material bytes; cache GC never traverses or edits request history.
use super::CacheMetadata;
use crate::repository::db;
use oas_application::cache::CacheService;
use oas_domain::{Error, Result, cache::*};
use serde_json::json;
use sqlx::Row;

pub fn limits() -> Result<(i64, i64)> {
    let bytes = std::env::var("OAS_CACHE_MAX_OBJECT_BYTES")
        .unwrap_or_else(|_| "10737418240".into())
        .parse::<i64>()
        .map_err(|_| Error::invalid("OAS_CACHE_MAX_OBJECT_BYTES"))?;
    let snapshots = std::env::var("OAS_CACHE_MAX_SNAPSHOTS")
        .unwrap_or_else(|_| "1000000".into())
        .parse::<i64>()
        .map_err(|_| Error::invalid("OAS_CACHE_MAX_SNAPSHOTS"))?;
    if bytes <= 0 || snapshots <= 0 {
        return Err(Error::invalid("cache_capacity"));
    }
    Ok((bytes, snapshots))
}
pub async fn track(
    meta: &CacheMetadata,
    scope: &Scope,
    binding: &Binding,
    key: &str,
    bytes: i64,
) -> Result<bool> {
    let mut tx = meta.repo.pool.begin().await.map_err(db)?;
    if !CacheMetadata::guard(&mut tx, scope, binding).await? {
        return Ok(false);
    }
    let inserted=sqlx::query(
        "INSERT INTO cache_gc_objects(object_key,orphaned_at,bytes) VALUES($1,$2,$3) ON CONFLICT DO NOTHING"
    ).bind(key).bind(chrono::Utc::now().timestamp_millis()).bind(bytes).execute(&mut *tx).await.map_err(db)?;
    if inserted.rows_affected() > 0 {
        // INSERT's trigger already holds the counter row until commit. Rolling
        // back a reservation releases its bytes in the same transaction.
        let used = sqlx::query_scalar::<_, i64>(
            "SELECT object_bytes FROM cache_storage_totals WHERE singleton",
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if used > limits()?.0 {
            return Ok(false);
        }
    } else {
        let refreshed = sqlx::query(
            "UPDATE cache_gc_objects SET orphaned_at=$2 WHERE object_key=$1 AND bytes=$3",
        )
        .bind(key)
        .bind(chrono::Utc::now().timestamp_millis())
        .bind(bytes)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        if refreshed.rows_affected() != 1 {
            return Err(Error::invalid("object_size"));
        }
    }
    tx.commit().await.map_err(db)?;
    Ok(true)
}
pub async fn pin(
    meta: &CacheMetadata,
    scope: &Scope,
    binding: &Binding,
    key: &str,
) -> Result<String> {
    let mut tx = meta.repo.pool.begin().await.map_err(db)?;
    if !CacheMetadata::guard(&mut tx, scope, binding).await? {
        return Err(Error::cancelled());
    }
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM cache_pages WHERE object_key=$1)",
    )
    .bind(key)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    if !exists {
        return Err(Error::unavailable());
    }
    let id = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO cache_read_leases(id,object_key,expires_at) VALUES($1,$2,$3)")
        .bind(id)
        .bind(key)
        .bind(chrono::Utc::now().timestamp_millis() + meta.settings.lookup_ms as i64 + 1000)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(id.to_string())
}
pub async fn collect(meta: &CacheMetadata, service: &CacheService) -> Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let (max_bytes, max_snapshots) = limits()?;
    sqlx::query("UPDATE cache_jobs SET input=input #- '{page,markdown}' WHERE state NOT IN ('waiting','retry','running') AND input->'page' ? 'markdown'").execute(&meta.repo.pool).await.map_err(db)?;
    sqlx::query("DELETE FROM cache_read_leases WHERE expires_at<$1")
        .bind(now)
        .execute(&meta.repo.pool)
        .await
        .map_err(db)?;
    sqlx::query("DELETE FROM cache_foreground_reads WHERE expires_at<$1")
        .bind(now)
        .execute(&meta.repo.pool)
        .await
        .map_err(db)?;
    // A hot expiry is retained until its single refresh has been considered.
    let pages = sqlx::query(include_str!("sql/expired_pages.sql"))
        .bind(&service.binding.namespace)
        .bind(now)
        .fetch_all(&meta.repo.pool)
        .await
        .map_err(db)?;
    for p in pages {
        withdraw(meta, &p, now).await?;
    }
    sqlx::query(include_str!("sql/expired_snapshots.sql"))
        .bind(&service.binding.namespace)
        .bind(now)
        .execute(&meta.repo.pool)
        .await
        .map_err(db)?;
    let totals =
        sqlx::query("SELECT snapshots,object_bytes FROM cache_storage_totals WHERE singleton")
            .fetch_one(&meta.repo.pool)
            .await
            .map_err(db)?;
    let mut snapshots: i64 = totals.get("snapshots");
    let mut bytes: i64 = totals.get("object_bytes");
    if bytes > max_bytes * 9 / 10 {
        // Detached objects stay charged until S3 acknowledges deletion. Only
        // live pointers can contribute to the next withdrawal target.
        let mut live_bytes: i64 = sqlx::query_scalar(
            "SELECT COALESCE(sum((body->>'size_bytes')::bigint),0)::bigint FROM cache_pages",
        )
        .fetch_one(&meta.repo.pool)
        .await
        .map_err(db)?;
        let cold=sqlx::query("SELECT p.namespace,p.scope,p.page_key,p.object_key,COALESCE((p.body->>'size_bytes')::bigint,0) AS bytes FROM cache_pages p LEFT JOIN cache_registry r ON r.scope=p.scope AND r.kind='content' AND r.object_id=p.page_key WHERE (NOT EXISTS(SELECT FROM cache_enabled_scopes a WHERE a.scope=p.scope AND a.access_epoch=p.access_epoch) OR EXISTS(SELECT 1 FROM cache_hot_boards b WHERE b.scope=p.scope AND b.kind='content' AND b.as_of>$1-180000) AND NOT EXISTS(SELECT 1 FROM cache_hot_members h WHERE h.scope=p.scope AND h.kind='content' AND h.object_id=p.page_key)) AND NOT EXISTS(SELECT 1 FROM cache_read_leases l WHERE l.object_key=p.object_key AND l.expires_at>$1) AND NOT EXISTS(SELECT 1 FROM cache_jobs j WHERE j.scope=p.scope AND j.target=p.page_key AND j.state='running') ORDER BY COALESCE(r.total,0),COALESCE((p.body->>'size_bytes')::bigint,0) DESC,p.collected_at LIMIT 256")
            .bind(now).fetch_all(&meta.repo.pool).await.map_err(db)?;
        for p in cold {
            if live_bytes <= max_bytes * 8 / 10 {
                break;
            }
            if withdraw(meta, &p, now).await? {
                live_bytes = live_bytes.saturating_sub(p.get::<i64, _>("bytes"));
            }
        }
    }
    if snapshots > max_snapshots * 9 / 10 {
        let count = (snapshots - max_snapshots * 8 / 10).min(10000);
        let changed=sqlx::query("DELETE FROM cache_snapshots WHERE id IN (SELECT s.id FROM cache_snapshots s LEFT JOIN cache_registry r ON r.scope=s.scope AND r.kind='list' AND r.object_id=s.question WHERE (NOT EXISTS(SELECT FROM cache_enabled_scopes a WHERE a.scope=s.scope AND a.access_epoch=s.access_epoch) OR EXISTS(SELECT 1 FROM cache_hot_boards b WHERE b.scope=s.scope AND b.kind='list' AND b.as_of>$1-180000) AND NOT EXISTS(SELECT 1 FROM cache_hot_members h WHERE h.scope=s.scope AND h.kind='list' AND h.object_id=s.question)) AND NOT EXISTS(SELECT 1 FROM cache_jobs j WHERE j.target=s.id::text AND j.kind='index' AND j.state='running') ORDER BY COALESCE(r.total,0),s.collected_at LIMIT $2)")
            .bind(now).bind(count).execute(&meta.repo.pool).await.map_err(db)?;
        snapshots = snapshots.saturating_sub(changed.rows_affected() as i64);
    }
    // Hold the orphan row lock through DELETE. A new writer first locks this
    // same row, so it cannot lose a newly uploaded object to concurrent GC.
    for _ in 0..64 {
        let mut tx = meta.repo.pool.begin().await.map_err(db)?;
        let row=sqlx::query("SELECT object_key FROM cache_gc_objects g WHERE orphaned_at<$1 AND NOT EXISTS(SELECT 1 FROM cache_pages p WHERE p.object_key=g.object_key) AND NOT EXISTS(SELECT 1 FROM cache_read_leases l WHERE l.object_key=g.object_key AND l.expires_at>$2) ORDER BY orphaned_at LIMIT 1 FOR UPDATE SKIP LOCKED")
            .bind(now-300000).bind(now).fetch_optional(&mut *tx).await.map_err(db)?;
        let Some(row) = row else { break };
        let key: String = row.get("object_key");
        service.objects.delete(&key).await?;
        sqlx::query("DELETE FROM cache_gc_objects WHERE object_key=$1")
            .bind(key)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
    }
    bytes = sqlx::query_scalar("SELECT object_bytes FROM cache_storage_totals WHERE singleton")
        .fetch_one(&meta.repo.pool)
        .await
        .map_err(db)?;
    let status = json!({"as_of":now,"object_bytes":bytes,"max_object_bytes":max_bytes,"snapshots":snapshots,"max_snapshots":max_snapshots,"write_paused":bytes>=max_bytes||snapshots>=max_snapshots});
    sqlx::query("INSERT INTO settings(name,version,body) VALUES('cache-storage-status',1,$1) ON CONFLICT(name) DO UPDATE SET version=settings.version+1,body=$1").bind(status).execute(&meta.repo.pool).await.map_err(db)?;
    super::index_gc::purge(meta, service, now).await?;
    sqlx::query("DELETE FROM cache_page_resources r WHERE NOT EXISTS(SELECT 1 FROM cache_snapshot_pages p WHERE p.page_key=r.page_key) AND NOT EXISTS(SELECT 1 FROM cache_page_states s WHERE s.scope=r.scope AND s.page_key=r.page_key) AND NOT EXISTS(SELECT 1 FROM cache_registry h WHERE h.scope=r.scope AND h.kind='content' AND h.object_id=r.page_key)").execute(&meta.repo.pool).await.map_err(db)?;
    let pending=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM cache_snapshots WHERE namespace=$1 AND expires_at>$2 AND index_version<>$3)").bind(&service.binding.namespace).bind(now).bind(service.embedding.version()).fetch_one(&meta.repo.pool).await.map_err(db)?;
    let retired = sqlx::query_scalar::<_, String>(
        "SELECT namespace FROM cache_namespaces WHERE namespace<>$1",
    )
    .bind(&service.binding.namespace)
    .fetch_all(&meta.repo.pool)
    .await
    .map_err(db)?;
    service
        .index
        .collect(&service.binding, now, !pending, &retired)
        .await?;
    sqlx::query("DELETE FROM cache_index_gc WHERE namespace<>$1")
        .bind(&service.binding.namespace)
        .execute(&meta.repo.pool)
        .await
        .map_err(db)?;
    Ok(())
}
async fn withdraw(meta: &CacheMetadata, row: &sqlx::postgres::PgRow, now: i64) -> Result<bool> {
    let (namespace, scope, key, object, bytes): (String, String, String, String, i64) = (
        row.get("namespace"),
        row.get("scope"),
        row.get("page_key"),
        row.get("object_key"),
        row.get("bytes"),
    );
    let mut tx = meta.repo.pool.begin().await.map_err(db)?;
    // Recheck the read lease and writer inside the pointer update transaction.
    let removed=sqlx::query("DELETE FROM cache_pages p WHERE namespace=$1 AND scope=$2 AND page_key=$3 AND object_key=$4 AND NOT EXISTS(SELECT 1 FROM cache_read_leases l WHERE l.object_key=p.object_key AND l.expires_at>$5) AND NOT EXISTS(SELECT 1 FROM cache_jobs j WHERE j.scope=p.scope AND j.target=p.page_key AND j.state='running')")
        .bind(namespace).bind(scope).bind(key).bind(&object).bind(now).execute(&mut *tx).await.map_err(db)?;
    if removed.rows_affected() > 0 {
        sqlx::query("INSERT INTO cache_gc_objects(object_key,orphaned_at,bytes) VALUES($1,$2,$3) ON CONFLICT(object_key) DO UPDATE SET orphaned_at=GREATEST(cache_gc_objects.orphaned_at,$2)")
        .bind(object).bind(now).bind(bytes).execute(&mut *tx).await.map_err(db)?;
    }
    tx.commit().await.map_err(db)?;
    Ok(removed.rows_affected() > 0)
}

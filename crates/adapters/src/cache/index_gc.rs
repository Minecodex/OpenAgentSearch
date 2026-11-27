use super::CacheMetadata;
use crate::repository::db;
use oas_application::cache::CacheService;
use oas_domain::{Result, cache::point_id};
use serde_json::json;
use sqlx::{Postgres, Row, Transaction};

pub(super) fn question_id(scope: &str, epoch: i64, question: &str) -> String {
    point_id(&format!("{scope}/{epoch}/{question}"))
}

/// Serialize changes only to points shared by these snapshots. Stable lock
/// ordering prevents cycles when two questions share more than one feature.
pub(super) async fn lock_points(
    tx: &mut Transaction<'_, Postgres>,
    namespace: &str,
    question: &[String],
    features: &[String],
) -> Result<()> {
    let names = question
        .iter()
        .map(|id| format!("{namespace}/q/{id}"))
        .chain(features.iter().map(|id| format!("{namespace}/f/{id}")))
        .collect::<Vec<_>>();
    sqlx::query("SELECT pg_advisory_xact_lock(lock_id) FROM (SELECT DISTINCT hashtextextended(name,77183005) AS lock_id FROM unnest($1::text[]) k(name) ORDER BY lock_id) ordered")
        .bind(names).execute(&mut **tx).await.map_err(db)?;
    Ok(())
}

pub(super) async fn purge(meta: &CacheMetadata, service: &CacheService, now: i64) -> Result<()> {
    let namespace = &service.binding.namespace;
    let candidates = sqlx::query(include_str!("sql/purge_candidates.sql"))
        .bind(namespace)
        .bind(now)
        .bind(None::<serde_json::Value>)
        .fetch_all(&meta.repo.pool)
        .await
        .map_err(db)?;
    if candidates.is_empty() {
        return Ok(());
    }
    let mut requested = Vec::with_capacity(candidates.len());
    let (mut questions, mut features) = (Vec::new(), Vec::new());
    for r in candidates {
        let scope: String = r.get("scope");
        let epoch: i64 = r.get("access_epoch");
        let kind: String = r.get("kind");
        let target: String = r.get("target");
        if kind == "question" {
            questions.push(question_id(&scope, epoch, &target))
        } else {
            features.push(target.clone())
        }
        requested.push(json!({"kind":kind,"scope":scope,"epoch":epoch,"target":target}));
    }
    let mut tx = meta.repo.pool.begin().await.map_err(db)?;
    lock_points(&mut tx, namespace, &questions, &features).await?;
    // Recheck after acquiring the locks: another writer may just have created
    // a reference. Unrelated questions can continue to commit during Qdrant I/O.
    let eligible = sqlx::query(include_str!("sql/purge_candidates.sql"))
        .bind(namespace)
        .bind(now)
        .bind(json!(requested))
        .fetch_all(&mut *tx)
        .await
        .map_err(db)?;
    questions.clear();
    features.clear();
    for r in &eligible {
        let target: String = r.get("target");
        if r.get::<String, _>("kind") == "question" {
            questions.push(question_id(
                &r.get::<String, _>("scope"),
                r.get("access_epoch"),
                &target,
            ));
        } else {
            features.push(target)
        }
    }
    service.index.purge(&questions, &features).await?;
    for r in eligible {
        sqlx::query("DELETE FROM cache_index_gc WHERE namespace=$1 AND kind=$2 AND scope=$3 AND access_epoch=$4 AND target=$5")
            .bind(namespace).bind(r.get::<String,_>("kind")).bind(r.get::<String,_>("scope")).bind(r.get::<i64,_>("access_epoch")).bind(r.get::<String,_>("target")).execute(&mut *tx).await.map_err(db)?;
    }
    tx.commit().await.map_err(db)
}

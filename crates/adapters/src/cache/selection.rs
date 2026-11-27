use super::CacheMetadata;
use crate::repository::db;
use oas_domain::{Result, cache::*};
use serde_json::Value;
use sqlx::Row;
use std::collections::HashSet;

impl CacheMetadata {
    pub(super) async fn select_snapshots(
        &self,
        scope: &Scope,
        binding: &Binding,
        questions: &[String],
        exact: &str,
        per_question: usize,
        now: i64,
    ) -> Result<Vec<SearchSnapshot>> {
        if questions.is_empty() || per_question == 0 {
            return Ok(Vec::new());
        }
        let mut tx = self.repo.pool.begin().await.map_err(db)?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        if !Self::guard(&mut tx, scope, binding).await? {
            return Ok(Vec::new());
        }
        let sources: Vec<_> = scope.sources.iter().cloned().collect();
        let limit = i64::try_from(per_question)
            .map_err(|_| oas_domain::Error::invalid("snapshot_limit"))?;
        let rows = sqlx::query(include_str!("sql/snapshot_candidates.sql"))
            .bind(&binding.namespace)
            .bind(&scope.project)
            .bind(questions)
            .bind(now)
            .bind(&sources)
            .bind(oas_domain::BROWSER_SEARCH)
            .bind(oas_domain::BROWSER_READER)
            .bind(scope.access_epoch)
            .bind(exact)
            .bind(limit)
            .fetch_all(&mut *tx)
            .await
            .map_err(db)?;
        let mut result = Vec::with_capacity(rows.len());
        for row in rows {
            let mut snapshot: SearchSnapshot = serde_json::from_value(row.get::<Value, _>("body"))
                .map_err(|_| oas_domain::Error::internal())?;
            let indices: HashSet<_> = row.get::<Vec<i32>, _>("indices").into_iter().collect();
            let legacy: HashSet<_> = row
                .get::<Vec<String>, _>("legacy_keys")
                .into_iter()
                .collect();
            snapshot.hits = snapshot
                .hits
                .into_iter()
                .enumerate()
                .filter_map(|(i, h)| {
                    let eligible = indices.contains(&(i as i32))
                        || (!legacy.is_empty()
                            && page_key(&h.url, false).is_some_and(|k| legacy.contains(&k)));
                    eligible.then_some(h)
                })
                .collect();
            if !row.get::<bool, _>("answer_visible") {
                snapshot.engine_answer = None;
            }
            if snapshot.question != exact || snapshot.query.time_range.is_some() {
                snapshot.cards.clear();
            }
            result.push(snapshot);
        }
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
}

use super::CacheMetadata;
use crate::repository::db;
use oas_application::cache::Metadata;
use oas_domain::{Result, cache::*};
use serde_json::{Value, json};
use sqlx::Row;

impl CacheMetadata {
    pub async fn claim(
        &self,
        binding: &Binding,
        browser: bool,
        model: bool,
    ) -> Result<Option<Task>> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut tx = self.repo.pool.begin().await.map_err(db)?;
        sqlx::query("UPDATE cache_jobs j SET state='ignored',last_error='version_or_project_mismatch',finished_at=$1 WHERE state IN ('waiting','retry') AND (namespace<>$2 OR activation<>$3 OR handler<>$4 OR payload_version<>(SELECT payload_version FROM cache_control WHERE singleton) OR (scope NOT LIKE 'admin:%' AND NOT EXISTS(SELECT 1 FROM resources r WHERE r.id::text=j.scope AND NOT r.archived AND r.body->>'cache_enabled'='true' AND COALESCE((r.body->>'cache_epoch')::bigint,0)=j.cache_epoch)))")
            .bind(now).bind(&binding.namespace).bind(binding.activation).bind(&binding.handler).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("UPDATE cache_jobs SET state='expired',finished_at=$1,last_error='task_deadline' WHERE state IN ('waiting','retry','running') AND deadline<=$1")
            .bind(now).execute(&mut *tx).await.map_err(db)?;
        let row = sqlx::query(include_str!("sql/claim_job.sql"))
            .bind(&binding.namespace)
            .bind(binding.activation)
            .bind(&binding.handler)
            .bind(now)
            .bind(browser)
            .bind(model)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
        let Some(row) = row else {
            tx.commit().await.map_err(db)?;
            return Ok(None);
        };
        let id = row.get::<uuid::Uuid, _>("id");
        let lease = uuid::Uuid::new_v4();
        sqlx::query("UPDATE cache_jobs SET state='running',lease=$2,lease_until=LEAST(deadline,$3) WHERE id=$1")
            .bind(id).bind(lease).bind(now+60000).execute(&mut *tx).await.map_err(db)?;
        let mut scope: Scope = serde_json::from_value(row.get("scope_body"))
            .map_err(|_| oas_domain::Error::internal())?;
        scope.lease = Some(lease.to_string());
        let task = Task {
            id: id.to_string(),
            scope,
            binding: binding.clone(),
            payload_version: row.get("payload_version"),
            plan: JobPlan {
                kind: row.get("kind"),
                target: row.get("target"),
                reason: row.get("reason"),
                input: row.get("input"),
                object_epoch: row.get("object_epoch"),
            },
            attempt: row.get("attempts"),
            created_at: row.get("created_at"),
            deadline: row.get("deadline"),
            lease: lease.to_string(),
        };
        tx.commit().await.map_err(db)?;
        Ok(Some(task))
    }
    /// One durable attempt is charged before the first real call of a round.
    pub async fn dispatched(&self, task: &Task) -> Result<()> {
        self.dispatched_lease(&task.lease).await
    }
    pub async fn dispatch_checked(
        &self,
        task: &Task,
        scope: &Scope,
        object_epoch: i64,
    ) -> Result<()> {
        let mut tx = self.repo.pool.begin().await.map_err(db)?;
        if !Self::guard(&mut tx, scope, &task.binding).await? {
            return Err(oas_domain::Error::cancelled());
        }
        if matches!(task.plan.kind.as_str(), "content" | "summary") {
            let state = Self::page_state_tx(&mut tx, scope, &task.plan.target).await?;
            state.require_network(
                task.plan.kind == "content" && task.plan.reason == "origin_recovery",
            )?;
            if state.epoch != object_epoch {
                return Err(oas_domain::Error::cancelled());
            }
        }
        Self::charge(&mut tx, &task.lease).await?;
        tx.commit().await.map_err(db)
    }
    pub(crate) async fn dispatched_lease(&self, lease: &str) -> Result<()> {
        let mut tx = self.repo.pool.begin().await.map_err(db)?;
        Self::charge(&mut tx, lease).await?;
        tx.commit().await.map_err(db)
    }
    async fn charge(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, lease: &str) -> Result<()> {
        let value =
            json!({"lease":lease,"at":chrono::Utc::now().timestamp_millis(),"stage":"dispatched"});
        let updated=sqlx::query("UPDATE cache_jobs SET attempts=attempts+1,phases=phases||jsonb_build_array($2::jsonb) WHERE lease::text=$1 AND state='running' AND deadline>$3 AND lease_until>$3 AND attempts<attempt_limit AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(phases) p WHERE p->>'lease'=$1 AND p->>'stage'='dispatched') RETURNING id")
            .bind(lease).bind(value).bind(chrono::Utc::now().timestamp_millis()).fetch_optional(&mut **tx).await.map_err(db)?;
        if updated.is_none() {
            let dispatched=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT FROM jsonb_array_elements(phases) p WHERE p->>'lease'=$1 AND p->>'stage'='dispatched') FROM cache_jobs WHERE lease::text=$1 AND state='running' AND deadline>$2 AND lease_until>$2")
                .bind(lease).bind(chrono::Utc::now().timestamp_millis()).fetch_optional(&mut **tx).await.map_err(db)?;
            match dispatched {
                Some(true) => (),
                Some(false) => {
                    return Err(oas_domain::Error::new(
                        "CACHE_ATTEMPTS_EXHAUSTED",
                        503,
                        "后台尝试次数已用尽。",
                        "The task has used its dispatch attempts.",
                    ));
                }
                None => return Err(oas_domain::Error::cancelled()),
            }
        }
        Ok(())
    }
    pub async fn execution_started(
        &self,
        task: &Task,
        request: &str,
        configuration: Value,
    ) -> Result<()> {
        let changed=sqlx::query("UPDATE cache_jobs SET execution_request=$3,phases=phases||jsonb_build_array($4::jsonb) WHERE id::text=$1 AND lease::text=$2 AND state='running' AND deadline>$5 AND lease_until>$5")
            .bind(&task.id).bind(&task.lease).bind(request).bind(configuration).bind(chrono::Utc::now().timestamp_millis()).execute(&self.repo.pool).await.map_err(db)?;
        if changed.rows_affected() != 1 {
            return Err(oas_domain::Error::cancelled());
        }
        Ok(())
    }
    /// A receipt is committed in the same transaction as its material. A lease
    /// reclaimed after losing only the completion acknowledgement must not refetch.
    pub async fn committed_version(&self, task: &Task, scope: &Scope) -> Result<Option<String>> {
        sqlx::query_scalar("SELECT p->>'version' FROM cache_jobs j CROSS JOIN LATERAL jsonb_array_elements(j.phases) WITH ORDINALITY receipt(p,n) WHERE j.id::text=$1 AND j.lease::text=$2 AND j.state='running' AND p->>'stage'='material_committed' AND (p->>'access_epoch')::bigint=$3 ORDER BY n DESC LIMIT 1")
            .bind(&task.id).bind(&task.lease).bind(scope.access_epoch).fetch_optional(&self.repo.pool).await.map_err(db)
    }
    pub async fn complete(
        &self,
        task: &Task,
        error: Option<&str>,
        retry_after: Option<i64>,
    ) -> Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut check_scope = task.scope.clone();
        if matches!(task.plan.kind.as_str(), "list" | "content" | "summary") {
            check_scope.access_epoch = -1;
        }
        let error = if self.valid(&check_scope, &task.binding).await? {
            error
        } else {
            Some("cache_disabled")
        };
        let mut tx = self.repo.pool.begin().await.map_err(db)?;
        let row=sqlx::query("SELECT attempts,attempt_limit,deadline FROM cache_jobs WHERE id::text=$1 AND lease::text=$2 AND state='running' AND lease_until>$3 FOR UPDATE")
            .bind(&task.id).bind(&task.lease).bind(now).fetch_optional(&mut *tx).await.map_err(db)?;
        let Some(row) = row else { return Ok(()) };
        let attempts = row.get::<i32, _>("attempts");
        let deadline = row.get::<i64, _>("deadline");
        let delay = retry_after.unwrap_or(if attempts == 0 {
            30000
        } else if attempts == 1 {
            1000
        } else {
            5000
        });
        let ignored = matches!(
            error,
            Some(
                "cache_disabled"
                    | "version_mismatch"
                    | "CANCELLED"
                    | "CACHE_SOURCE_GONE"
                    | "ACCESS_DENIED"
                    | "URL_NOT_ALLOWED"
            )
        );
        let mut state = if ignored {
            "ignored"
        } else if error == Some("CACHE_NOT_ADMITTED") {
            "not_admitted"
        } else if error.is_none() {
            "completed"
        } else if now.saturating_add(delay) >= deadline {
            "expired"
        } else if attempts >= row.get::<i32, _>("attempt_limit") {
            "failed"
        } else {
            "retry"
        };
        if state == "retry" {
            sqlx::query("SELECT pg_advisory_xact_lock(77183003)")
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            let count = sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM cache_jobs WHERE state IN ('waiting','retry')",
            )
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
            if count >= self.settings.queue_capacity {
                let oldest=sqlx::query("SELECT id,sequence FROM cache_jobs WHERE state IN ('waiting','retry') OR id::text=$1 ORDER BY sequence LIMIT 1 FOR UPDATE").bind(&task.id).fetch_optional(&mut *tx).await.map_err(db)?;
                if let Some(oldest) = oldest {
                    let oldest = oldest.get::<uuid::Uuid, _>("id");
                    if oldest.to_string() == task.id {
                        state = "evicted";
                    } else {
                        sqlx::query("UPDATE cache_jobs SET state='evicted',last_error='queue_full',finished_at=$2 WHERE id=$1").bind(oldest).bind(now).execute(&mut *tx).await.map_err(db)?;
                    }
                }
            }
        }
        sqlx::query("UPDATE cache_jobs SET phases=phases||jsonb_build_array($7::jsonb),state=$3,last_error=$4,available_at=$5,finished_at=$6,lease=NULL,lease_until=NULL,input=CASE WHEN $3 IN ('completed','not_admitted','failed','expired','ignored','evicted') THEN input #- '{page,markdown}' ELSE input END WHERE id::text=$1 AND lease::text=$2")
            .bind(&task.id).bind(&task.lease).bind(state).bind(error).bind(now.saturating_add(delay)).bind(if state=="retry"{None}else{Some(now)}).bind(json!({"stage":"round_result","at":now,"state":state,"error":error})).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(())
    }
}

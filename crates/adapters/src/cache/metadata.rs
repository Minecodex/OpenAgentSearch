use crate::repository::{Repository, db};
use async_trait::async_trait;
use oas_application::cache::{CacheSettings, Metadata};
use oas_domain::{Result, cache::*};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};

#[derive(Clone)]
pub struct CacheMetadata {
    pub repo: Repository,
    pub settings: CacheSettings,
}
impl CacheMetadata {
    async fn material_committed(
        tx: &mut Transaction<'_, Postgres>,
        scope: &Scope,
        key: &str,
        version: &str,
    ) -> Result<()> {
        if let Some(lease) = &scope.lease {
            let receipt = json!({"stage":"material_committed","target":key,"version":version,"access_epoch":scope.access_epoch,"at":chrono::Utc::now().timestamp_millis()});
            let saved=sqlx::query("UPDATE cache_jobs SET phases=phases||jsonb_build_array($2::jsonb) WHERE lease::text=$1 AND state='running' AND deadline>$3 AND lease_until>$3 AND target=$4")
                .bind(lease).bind(receipt).bind(chrono::Utc::now().timestamp_millis()).bind(key).execute(&mut **tx).await.map_err(db)?;
            if saved.rows_affected() != 1 {
                return Err(oas_domain::Error::cancelled());
            }
        }
        Ok(())
    }
    pub(super) async fn page_state_tx(
        tx: &mut Transaction<'_, Postgres>,
        scope: &Scope,
        key: &str,
    ) -> Result<PageState> {
        let row=sqlx::query("SELECT epoch,status,access_epoch,retry_at FROM cache_page_states WHERE scope=$1 AND page_key=$2 FOR SHARE")
            .bind(&scope.project).bind(key).fetch_optional(&mut **tx).await.map_err(db)?;
        let Some(row) = row else {
            return Ok(PageState::from_stored(0, 200));
        };
        Ok(PageState::in_access_scope(
            row.get("epoch"),
            row.get("status"),
            row.get("access_epoch"),
            scope.access_epoch,
            row.get("retry_at"),
        ))
    }
    pub(crate) async fn guard(
        tx: &mut Transaction<'_, Postgres>,
        scope: &Scope,
        binding: &Binding,
    ) -> Result<bool> {
        let active=sqlx::query_scalar::<_,bool>("SELECT handler=$1 AND namespace=$2 AND activation=$3 FROM cache_control WHERE singleton FOR SHARE")
            .bind(&binding.handler).bind(&binding.namespace).bind(binding.activation).fetch_optional(&mut **tx).await.map_err(db)?.unwrap_or(false);
        if !active {
            return Ok(false);
        }
        if !scope.project.starts_with("admin:") {
            let project=sqlx::query_scalar::<_,Value>("SELECT body FROM resources WHERE id::text=$1 AND kind='projects' AND NOT archived FOR SHARE")
                .bind(&scope.project).fetch_optional(&mut **tx).await.map_err(db)?;
            if !project.is_some_and(|p| {
                p["cache_enabled"] == true
                    && p["cache_epoch"].as_i64().unwrap_or(0) == scope.epoch
                    && (scope.access_epoch < 0
                        || p["cache_access_epoch"].as_i64().unwrap_or(0) == scope.access_epoch)
            }) {
                return Ok(false);
            }
        } else {
            let resource = scope.project.strip_prefix("admin:").unwrap_or_default();
            let version = sqlx::query_scalar::<_, i64>(
                "SELECT version FROM resources WHERE id::text=$1 AND NOT archived FOR SHARE",
            )
            .bind(resource)
            .fetch_optional(&mut **tx)
            .await
            .map_err(db)?;
            if !version.is_some_and(|v| scope.access_epoch < 0 || v == scope.access_epoch) {
                return Ok(false);
            }
        }
        if let Some(lease) = &scope.lease {
            let valid=sqlx::query_scalar::<_,bool>("SELECT true FROM cache_jobs WHERE lease::text=$1 AND state='running' AND deadline>$2 AND lease_until>$2 AND scope=$3 AND cache_epoch=$4 AND namespace=$5 AND activation=$6 AND handler=$7 FOR SHARE")
                .bind(lease).bind(chrono::Utc::now().timestamp_millis()).bind(&scope.project).bind(scope.epoch).bind(&binding.namespace).bind(binding.activation).bind(&binding.handler).fetch_optional(&mut **tx).await.map_err(db)?.unwrap_or(false);
            if !valid {
                return Ok(false);
            }
        }
        Ok(true)
    }
    async fn allowed(&self, scope: &Scope, source: &str) -> Result<bool> {
        if !scope.sources.contains(source) {
            return Ok(false);
        }
        if source == oas_domain::BROWSER_READER || source == oas_domain::BROWSER_SEARCH {
            return Ok(true);
        }
        let exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM resources WHERE id::text=$1 AND NOT archived)",
        )
        .bind(source)
        .fetch_one(&self.repo.pool)
        .await
        .map_err(db)?;
        if !exists {
            return Ok(false);
        }
        if scope.project.starts_with("admin:") {
            return Ok(true);
        }
        let body = sqlx::query_scalar::<_, Value>(
            "SELECT body FROM resources WHERE id::text=$1 AND NOT archived",
        )
        .bind(&scope.project)
        .fetch_optional(&self.repo.pool)
        .await
        .map_err(db)?;
        Ok(body.is_some_and(|body| {
            ["search_pools", "reader_pools"].iter().any(|field| {
                body[*field].as_array().into_iter().flatten().any(|p| {
                    p.as_array()
                        .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(source)))
                })
            })
        }))
    }
    pub(crate) async fn enqueue_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        scope: &Scope,
        binding: &Binding,
        plan: &JobPlan,
        parent: &str,
    ) -> Result<()> {
        if !Self::guard(tx, scope, binding).await? {
            return if scope.lease.is_some() {
                Err(oas_domain::Error::cancelled())
            } else {
                Ok(())
            };
        }
        let mut not_before = plan.input["retry_at"].as_i64().unwrap_or(0);
        if matches!(plan.kind.as_str(), "content" | "summary" | "publish_page") {
            let state = Self::page_state_tx(tx, scope, &plan.target).await?;
            if plan.kind == "content" {
                not_before = not_before.max(state.retry_at);
            }
            state.require_fetch(plan.kind == "content" && plan.reason == "origin_recovery")?;
            if scope.access_epoch >= 0 && state.epoch != plan.object_epoch {
                return if scope.lease.is_some() {
                    Err(oas_domain::Error::cancelled())
                } else {
                    Ok(())
                };
            }
        }
        sqlx::query("SELECT pg_advisory_xact_lock(77183003)")
            .execute(&mut **tx)
            .await
            .map_err(db)?;
        sqlx::query("UPDATE cache_jobs SET state='expired',last_error='task_deadline',finished_at=$1 WHERE state IN ('waiting','retry') AND deadline<=$1")
            .bind(chrono::Utc::now().timestamp_millis()).execute(&mut **tx).await.map_err(db)?;
        if plan.reason == "hot_expiry" {
            let marked=sqlx::query("INSERT INTO cache_expiry_marks(namespace,scope,kind,target,generation) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING")
                .bind(&binding.namespace).bind(&scope.project).bind(&plan.kind).bind(&plan.target).bind(plan.input["expired_generation"].as_i64().unwrap_or(0))
                .execute(&mut **tx).await.map_err(db)?;
            if marked.rows_affected() == 0 {
                return Ok(());
            }
        }
        let dedup = hash(&format!(
            "{}/{}/{}/{}/{}/{}/{}/{}",
            binding.namespace,
            binding.activation,
            scope.project,
            scope.epoch,
            plan.kind,
            plan.target,
            plan.object_epoch,
            if plan.kind == "summary" || plan.kind == "publish_page" || plan.kind == "index" {
                hash(&plan.input.to_string())
            } else {
                String::new()
            }
        ));
        let merged=sqlx::query("UPDATE cache_jobs SET merged=merged+1, available_at=GREATEST(available_at,$2), state=CASE WHEN state<>'running' AND $2>=deadline THEN 'expired' ELSE state END, finished_at=CASE WHEN state<>'running' AND $2>=deadline THEN $3 ELSE finished_at END, last_error=CASE WHEN state<>'running' AND $2>=deadline THEN 'retry_after_deadline' ELSE last_error END WHERE dedup=$1 AND state IN ('waiting','retry','running')").bind(&dedup).bind(not_before).bind(chrono::Utc::now().timestamp_millis()).execute(&mut **tx).await.map_err(db)?;
        if merged.rows_affected() > 0 {
            return Ok(());
        }
        // Disabled projects and obsolete activations never consume the active bound.
        sqlx::query("UPDATE cache_jobs j SET state='ignored',last_error='cache_disabled',finished_at=$1 WHERE state IN ('waiting','retry') AND (namespace<>$2 OR activation<>$3 OR (scope NOT LIKE 'admin:%' AND NOT EXISTS(SELECT 1 FROM resources r WHERE r.id::text=j.scope AND NOT r.archived AND r.body->>'cache_enabled'='true' AND COALESCE((r.body->>'cache_epoch')::bigint,0)=j.cache_epoch)))")
            .bind(chrono::Utc::now().timestamp_millis()).bind(&binding.namespace).bind(binding.activation).execute(&mut **tx).await.map_err(db)?;
        let waiting = sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM cache_jobs WHERE state IN ('waiting','retry')",
        )
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?;
        let now = chrono::Utc::now().timestamp_millis();
        let deadline = now.saturating_add(self.settings.task_ttl.saturating_mul(1000));
        let expired = not_before >= deadline;
        if !expired && waiting >= self.settings.queue_capacity {
            sqlx::query("UPDATE cache_jobs SET state='evicted',last_error='queue_full',finished_at=$1 WHERE id=(SELECT id FROM cache_jobs WHERE state IN ('waiting','retry') ORDER BY sequence LIMIT 1 FOR UPDATE)")
                .bind(chrono::Utc::now().timestamp_millis()).execute(&mut **tx).await.map_err(db)?;
        }
        let id = uuid::Uuid::new_v4();
        let mut saved_scope = scope.clone();
        saved_scope.lease = None;
        sqlx::query("INSERT INTO cache_jobs(id,scope,cache_epoch,handler,namespace,activation,kind,target,dedup,reason,parent,scope_body,input,object_epoch,created_at,deadline,available_at,attempt_limit,payload_version,origin,operation,state,finished_at,last_error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$18,$17,(SELECT payload_version FROM cache_control WHERE singleton),COALESCE((SELECT origin FROM requests WHERE id::text=$11),'system'),COALESCE((SELECT operation FROM requests WHERE id::text=$11),CASE WHEN $7='content' THEN 'content' WHEN $7='summary' THEN 'summary' ELSE 'list' END),$19,$20,$21)")
            .bind(id).bind(&scope.project).bind(scope.epoch).bind(&binding.handler).bind(&binding.namespace).bind(binding.activation)
            .bind(&plan.kind).bind(&plan.target).bind(dedup).bind(&plan.reason).bind(parent).bind(json!(saved_scope)).bind(&plan.input)
            .bind(plan.object_epoch).bind(now) .bind(deadline).bind(self.settings.max_attempts).bind(now.max(not_before))
            .bind(if expired {"expired"} else {"waiting"}).bind(expired.then_some(now)).bind(expired.then_some("retry_after_deadline")).execute(&mut **tx).await.map_err(db)?;
        Ok(())
    }
}
#[async_trait]
impl Metadata for CacheMetadata {
    async fn begin_reads(
        &self,
        scope: &Scope,
        binding: &Binding,
        keys: &[String],
        request: &str,
        expires: i64,
    ) -> Result<()> {
        let mut tx = self.repo.pool.begin().await.map_err(db)?;
        if !Self::guard(&mut tx, scope, binding).await? {
            return Ok(());
        }
        sqlx::query("INSERT INTO cache_foreground_reads(scope,page_key,request_id,cache_epoch,access_epoch,expires_at) SELECT $1,unnest($2::text[]),$3,$4,$5,$6 ON CONFLICT(scope,page_key,request_id) DO UPDATE SET expires_at=$6")
            .bind(&scope.project).bind(keys).bind(request).bind(scope.epoch).bind(scope.access_epoch).bind(expires).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(())
    }
    async fn end_reads(&self, scope: &Scope, keys: &[String], request: &str) -> Result<()> {
        sqlx::query("DELETE FROM cache_foreground_reads WHERE scope=$1 AND page_key=ANY($2) AND request_id=$3").bind(&scope.project).bind(keys).bind(request).execute(&self.repo.pool).await.map_err(db)?;
        Ok(())
    }
    async fn reading(&self, scope: &Scope, key: &str) -> Result<bool> {
        Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cache_foreground_reads WHERE scope=$1 AND page_key=$2 AND cache_epoch=$3 AND access_epoch=$4 AND expires_at>$5)")
            .bind(&scope.project).bind(key).bind(scope.epoch).bind(scope.access_epoch).bind(chrono::Utc::now().timestamp_millis()).fetch_one(&self.repo.pool).await.map_err(db)?)
    }
    async fn source_state(&self, scope: &Scope, key: &str) -> Result<PageState> {
        let (kind, resource) = match scope.project.strip_prefix("admin:") {
            Some(id) => ("endpoints", id),
            None => ("projects", scope.project.as_str()),
        };
        let id =
            uuid::Uuid::parse_str(resource).map_err(|_| oas_domain::Error::invalid("scope"))?;
        // An old request must not interpret a denial recorded under a newer
        // access configuration as permission to use the old route.
        let row=sqlx::query(
            "SELECT CASE WHEN r.kind='projects' THEN COALESCE((r.body->>'cache_access_epoch')::bigint,0) ELSE r.version END AS current_access,
                    s.epoch,s.status,s.access_epoch,s.retry_at FROM resources r
             LEFT JOIN cache_page_states s ON s.scope=$3 AND s.page_key=$4
             WHERE r.id=$1 AND r.kind=$2 AND NOT r.archived"
        ).bind(id).bind(kind).bind(&scope.project).bind(key).fetch_optional(&self.repo.pool).await.map_err(db)?;
        let Some(row) = row.filter(|r| {
            scope.access_epoch < 0 || r.get::<i64, _>("current_access") == scope.access_epoch
        }) else {
            return Err(oas_domain::Error::new(
                "ACCESS_DENIED",
                502,
                "访问配置已更改，请重新请求。",
                "The access configuration has changed. Start a new request.",
            ));
        };
        let current: i64 = row.get("current_access");
        Ok(PageState::in_access_scope(
            row.get::<Option<i64>, _>("epoch").unwrap_or(0),
            row.get::<Option<i32>, _>("status").unwrap_or(200),
            row.get::<Option<i64>, _>("access_epoch").unwrap_or(current),
            current,
            row.get::<Option<i64>, _>("retry_at").unwrap_or(0),
        ))
    }
    async fn allowed_source(&self, scope: &Scope, source: &str) -> Result<bool> {
        self.allowed(scope, source).await
    }
    async fn pages(
        &self,
        scope: &Scope,
        binding: &Binding,
        keys: &[String],
        now: i64,
    ) -> Result<Vec<Page>> {
        if !self.valid(scope, binding).await? {
            return Ok(vec![]);
        }
        let sources = scope.sources.iter().cloned().collect::<Vec<_>>();
        let rows=sqlx::query("SELECT p.body,p.object_key FROM cache_pages p LEFT JOIN cache_page_states s ON s.scope=p.scope AND s.page_key=p.page_key WHERE p.namespace=$1 AND p.scope=$2 AND p.page_key=ANY($3) AND p.expires_at>$4 AND p.access_epoch=$8 AND COALESCE(s.status,200) NOT IN (-1,401,403,410) AND p.object_epoch=COALESCE(s.epoch,0) AND p.source=ANY($5) AND (p.source IN ($6,$7) OR EXISTS(SELECT 1 FROM resources e WHERE e.id::text=p.source AND NOT e.archived) AND ($2 LIKE 'admin:%' OR EXISTS(SELECT 1 FROM resource_links l WHERE l.owner_id::text=$2 AND l.target_id::text=p.source)))")
            .bind(&binding.namespace).bind(&scope.project).bind(keys).bind(now).bind(sources).bind(oas_domain::BROWSER_SEARCH).bind(oas_domain::BROWSER_READER).bind(scope.access_epoch).fetch_all(&self.repo.pool).await.map_err(db)?;
        rows.into_iter()
            .map(|r| {
                let mut p: Page = serde_json::from_value(r.get("body"))
                    .map_err(|_| oas_domain::Error::internal())?;
                p.object_key = r.get("object_key");
                Ok(p)
            })
            .collect()
    }
    async fn index_ready(&self, binding: &Binding, encoding: &str) -> Result<bool> {
        Ok(sqlx::query_scalar(
            "SELECT ready AND encoding=$2 FROM cache_index_control WHERE namespace=$1",
        )
        .bind(&binding.namespace)
        .bind(encoding)
        .fetch_optional(&self.repo.pool)
        .await
        .map_err(db)?
        .unwrap_or(false))
    }
    async fn effect_started(&self, scope: &Scope) -> Result<()> {
        if let Some(lease) = &scope.lease {
            self.dispatched_lease(lease).await?;
        }
        Ok(())
    }
    async fn track_object(
        &self,
        scope: &Scope,
        binding: &Binding,
        key: &str,
        bytes: i64,
    ) -> Result<bool> {
        super::garbage::track(self, scope, binding, key, bytes).await
    }
    async fn pin_object(&self, scope: &Scope, binding: &Binding, key: &str) -> Result<String> {
        super::garbage::pin(self, scope, binding, key).await
    }
    async fn unpin_object(&self, pin: &str) -> Result<()> {
        sqlx::query("DELETE FROM cache_read_leases WHERE id::text=$1")
            .bind(pin)
            .execute(&self.repo.pool)
            .await
            .map_err(db)?;
        Ok(())
    }
    async fn valid(&self, scope: &Scope, binding: &Binding) -> Result<bool> {
        let mut tx = self.repo.pool.begin().await.map_err(db)?;
        let result = Self::guard(&mut tx, scope, binding).await?;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
    async fn register(&self, scope: &Scope, query: &Query) -> Result<()> {
        let mut tx = self.repo.cache_accounting.begin().await.map_err(db)?;
        sqlx::query("SET LOCAL lock_timeout='10ms'")
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let valid = if let Some(eid) = scope.project.strip_prefix("admin:") {
            sqlx::query_scalar::<_, bool>(
                "SELECT version=$2 FROM resources WHERE id::text=$1 AND NOT archived FOR SHARE",
            )
            .bind(eid)
            .bind(scope.access_epoch)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
        } else {
            sqlx::query_scalar::<_,bool>("SELECT body->>'cache_enabled'='true' AND COALESCE((body->>'cache_epoch')::bigint,0)=$2 AND COALESCE((body->>'cache_access_epoch')::bigint,0)=$3 FROM resources WHERE id::text=$1 AND NOT archived FOR SHARE")
                .bind(&scope.project).bind(scope.epoch).bind(scope.access_epoch).fetch_optional(&mut *tx).await.map_err(db)?
        };
        if valid != Some(true) {
            return Ok(());
        }
        sqlx::query("INSERT INTO cache_registry(scope,kind,object_id,body) VALUES($1,'list',$2,$3) ON CONFLICT(scope,kind,object_id) DO UPDATE SET body=excluded.body WHERE cache_registry.body='{}'::jsonb")
            .bind(&scope.project).bind(query.id()).bind(json!({"query":query})).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)
    }
    async fn snapshots(
        &self,
        scope: &Scope,
        binding: &Binding,
        questions: &[String],
        exact_question: &str,
        per_question: usize,
        now: i64,
    ) -> Result<Vec<SearchSnapshot>> {
        self.select_snapshots(scope, binding, questions, exact_question, per_question, now)
            .await
    }
    async fn save_search(
        &self,
        scope: &Scope,
        binding: &Binding,
        snapshot: &SearchSnapshot,
    ) -> Result<bool> {
        if !self.allowed(scope, &snapshot.source).await? {
            return Ok(false);
        }
        let mut tx = self.repo.pool.begin().await.map_err(db)?;
        if !Self::guard(&mut tx, scope, binding).await? {
            return Ok(false);
        }
        let mut stored = snapshot.clone();
        let mut keys = Vec::new();
        let mut resources = Vec::new();
        let mut features = Vec::new();
        let mut published = Vec::new();
        let mut indices = Vec::new();
        for (index, hit) in stored.hits.iter_mut().enumerate() {
            hit.content = None;
            if let (Some(key), Some(resource)) = (page_key(&hit.url, false), resource_key(&hit.url))
            {
                keys.push(key);
                published.push(hit.published_at);
                indices.push(i32::try_from(index).map_err(|_| oas_domain::Error::invalid("hits"))?);
                resources.push(resource);
                features.push(point_id(&oas_application::cache::feature_text(hit)));
            }
        }
        let point =
            super::index_gc::question_id(&scope.project, scope.access_epoch, &snapshot.question);
        super::index_gc::lock_points(&mut tx, &binding.namespace, &[point], &features).await?;
        sqlx::query("INSERT INTO cache_page_resources(scope,page_key,resource_key) SELECT $1,* FROM unnest($2::text[],$3::text[]) ON CONFLICT DO NOTHING")
            .bind(&scope.project).bind(&keys).bind(&resources).execute(&mut *tx).await.map_err(db)?;
        let answer_keys = snapshot.engine_answer.as_ref().and_then(|a| {
            let sources = a["sources"].as_array()?;
            a["content"]
                .as_str()
                .or(a["text"].as_str())
                .or(a["answer"].as_str())
                .filter(|s| !s.trim().is_empty())?;
            sources
                .iter()
                .map(|s| page_key(s["url"].as_str()?, false))
                .collect::<Option<Vec<_>>>()
        });
        let inserted=sqlx::query("INSERT INTO cache_snapshots(id,namespace,scope,question,source,collected_at,expires_at,body,access_epoch,acquisition_order,answer_keys) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING")
            .bind(uuid::Uuid::parse_str(&snapshot.id).map_err(|_|oas_domain::Error::invalid("snapshot_id"))?).bind(&binding.namespace).bind(&scope.project)
            .bind(&snapshot.question).bind(&snapshot.source).bind(snapshot.collected_at).bind(snapshot.expires_at).bind(json!(stored)).bind(scope.access_epoch).bind(snapshot.acquisition_order).bind(answer_keys).execute(&mut *tx).await.map_err(db)?;
        if inserted.rows_affected() > 0 {
            sqlx::query("INSERT INTO cache_snapshot_pages(snapshot_id,page_key,feature_id,published_at,hit_index) SELECT $1,* FROM unnest($2::text[],$3::text[],$4::bigint[],$5::int[]) ON CONFLICT DO NOTHING")
                .bind(uuid::Uuid::parse_str(&snapshot.id).map_err(|_|oas_domain::Error::invalid("snapshot_id"))?)
                .bind(&keys).bind(&features).bind(&published).bind(&indices).execute(&mut *tx).await.map_err(db)?;
            let allocated=sqlx::query("UPDATE cache_storage_totals SET snapshots=snapshots+1 WHERE singleton AND snapshots<$1 RETURNING snapshots").bind(super::garbage::limits()?.1).fetch_optional(&mut *tx).await.map_err(db)?;
            if allocated.is_none() {
                return Err(oas_domain::Error::new(
                    "CACHE_CAPACITY_EXCEEDED",
                    503,
                    "快照容量已满，等待回收。",
                    "Snapshot capacity is exhausted. Waiting for reclamation.",
                ));
            }
        }
        self.enqueue_tx(
            &mut tx,
            scope,
            binding,
            &JobPlan {
                kind: "index".into(),
                target: snapshot.id.clone(),
                reason: "acquired".into(),
                input: json!({"snapshot":snapshot.id}),
                object_epoch: 0,
            },
            &snapshot.request_id,
        )
        .await?;
        Self::material_committed(&mut tx, scope, &snapshot.question, &snapshot.id).await?;
        tx.commit().await.map_err(db)?;
        Ok(true)
    }
    async fn page(
        &self,
        scope: &Scope,
        binding: &Binding,
        key: &str,
        now: i64,
    ) -> Result<Option<Page>> {
        if !self.valid(scope, binding).await? {
            return Ok(None);
        }
        let row=sqlx::query("SELECT p.body,p.object_key FROM cache_pages p LEFT JOIN cache_page_states s ON s.scope=p.scope AND s.page_key=p.page_key WHERE p.namespace=$1 AND p.scope=$2 AND p.page_key=$3 AND p.expires_at>$4 AND p.access_epoch=$5 AND COALESCE(s.status,200) NOT IN (-1,401,403,410) AND p.object_epoch=COALESCE(s.epoch,0)")
            .bind(&binding.namespace).bind(&scope.project).bind(key).bind(now).bind(scope.access_epoch).fetch_optional(&self.repo.pool).await.map_err(db)?;
        let Some(row) = row else { return Ok(None) };
        let mut p: Page =
            serde_json::from_value(row.get("body")).map_err(|_| oas_domain::Error::internal())?;
        if !self.allowed(scope, &p.source).await? {
            return Ok(None);
        }
        p.object_key = row.get("object_key");
        Ok(Some(p))
    }
    async fn publish_page(
        &self,
        scope: &Scope,
        binding: &Binding,
        page: &Page,
        object: &str,
    ) -> Result<bool> {
        if !self.allowed(scope, &page.source).await? {
            return Ok(false);
        }
        let mut tx = self.repo.pool.begin().await.map_err(db)?;
        if !Self::guard(&mut tx, scope, binding).await? {
            return Ok(false);
        }
        sqlx::query(
            "INSERT INTO cache_page_states(scope,page_key,access_epoch) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        )
        .bind(&scope.project)
        .bind(&page.key)
        .bind(scope.access_epoch)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        let state = sqlx::query(
            "SELECT epoch,status,observed_at,observed_order,access_epoch FROM cache_page_states WHERE scope=$1 AND page_key=$2 FOR UPDATE",
        )
        .bind(&scope.project)
        .bind(&page.key)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let access = PageState::from_stored(page.object_epoch, state.get("status")).access;
        if state.get::<i64, _>("epoch") != page.object_epoch
            || access == PageAccess::Denied
            || (
                state.get::<i64, _>("observed_at"),
                state.get::<i64, _>("observed_order"),
            ) > (page.collected_at, page.acquisition_order)
            || state.get::<i64, _>("access_epoch") != scope.access_epoch
        {
            return Ok(false);
        }
        if access == PageAccess::Gone {
            let allowed=page.source==oas_domain::BROWSER_READER && sqlx::query_scalar::<_,bool>(
                "SELECT EXISTS(SELECT FROM cache_jobs WHERE lease::text=$1 AND scope=$2 AND target=$3 AND kind='content' AND reason='origin_recovery' AND state='running')"
            ).bind(&scope.lease).bind(&scope.project).bind(&page.key).fetch_one(&mut *tx).await.map_err(db)?;
            if !allowed {
                return Ok(false);
            }
        }
        // The recovery and its immutable object pointer become visible together.
        let published_epoch = page.object_epoch
            + i64::from(matches!(
                access,
                PageAccess::Gone | PageAccess::VerifyNotFound
            ));
        if let Some(resource) = resource_key(&page.url) {
            sqlx::query("INSERT INTO cache_page_resources(scope,page_key,resource_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
                .bind(&scope.project).bind(&page.key).bind(resource).execute(&mut *tx).await.map_err(db)?;
        }
        let mut metadata = json!(page);
        metadata["object_epoch"] = json!(published_epoch);
        metadata["size_bytes"] = json!(page.markdown.len());
        metadata["markdown"] = json!("");
        metadata["object_key"] = json!(object);
        let updated=sqlx::query("INSERT INTO cache_pages(namespace,scope,page_key,source,collected_at,expires_at,object_epoch,object_key,body,access_epoch,acquisition_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(namespace,scope,page_key) DO UPDATE SET acquisition_order=$11,access_epoch=$10,source=$4,collected_at=$5,expires_at=$6,object_epoch=$7,object_key=$8,body=CASE WHEN cache_pages.body->>'content_hash'=$9->>'content_hash' THEN $9||jsonb_build_object('summary',cache_pages.body->'summary','summary_version',cache_pages.body->'summary_version') ELSE $9 END WHERE (cache_pages.collected_at,cache_pages.acquisition_order)<=($5,$11)")
            .bind(&binding.namespace).bind(&scope.project).bind(&page.key).bind(&page.source).bind(page.collected_at).bind(page.expires_at)
            .bind(published_epoch).bind(object).bind(metadata).bind(scope.access_epoch).bind(page.acquisition_order).execute(&mut *tx).await.map_err(db)?;
        if updated.rows_affected() > 0 {
            Self::material_committed(&mut tx, scope, &page.key, &page.content_hash).await?;
            sqlx::query("UPDATE cache_page_states SET observed_at=$3,observed_order=$4,status=200,epoch=$5,not_found_count=0,retry_at=0 WHERE scope=$1 AND page_key=$2")
                .bind(&scope.project).bind(&page.key).bind(page.collected_at).bind(page.acquisition_order).bind(published_epoch).execute(&mut *tx).await.map_err(db)?;
        }
        sqlx::query("INSERT INTO cache_registry(scope,kind,object_id,body) VALUES($1,'content',$2,$3) ON CONFLICT DO NOTHING").bind(&scope.project).bind(&page.key).bind(json!({"url":page.url})).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(updated.rows_affected() > 0)
    }
    async fn pending_page(
        &self,
        scope: &Scope,
        binding: &Binding,
        key: &str,
        now: i64,
    ) -> Result<Option<Page>> {
        if !self.valid(scope, binding).await? {
            return Ok(None);
        }
        let page=sqlx::query_scalar::<_,Value>("SELECT input->'page' FROM cache_jobs WHERE namespace=$1 AND activation=$2 AND scope=$3 AND cache_epoch=$4 AND kind='publish_page' AND target=$5 AND state IN ('waiting','retry','running') AND deadline>$6 AND COALESCE((scope_body->>'access_epoch')::bigint,0)=$7 ORDER BY (input->'page'->>'collected_at')::bigint DESC LIMIT 1")
            .bind(&binding.namespace).bind(binding.activation).bind(&scope.project).bind(scope.epoch).bind(key).bind(now).bind(scope.access_epoch).fetch_optional(&self.repo.pool).await.map_err(db)?;
        Ok(page.and_then(|p| serde_json::from_value(p).ok()))
    }
    async fn page_epoch(&self, scope: &Scope, key: &str) -> Result<i64> {
        let mut tx = self.repo.pool.begin().await.map_err(db)?;
        if let Some(resource) = scope.project.strip_prefix("admin:") {
            let version = sqlx::query_scalar::<_, i64>(
                "SELECT version FROM resources WHERE id::text=$1 AND NOT archived FOR SHARE",
            )
            .bind(resource)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
            if version != Some(scope.access_epoch) {
                return Err(oas_domain::Error::cancelled());
            }
        } else {
            let body = sqlx::query_scalar::<_, Value>(
                "SELECT body FROM resources WHERE id::text=$1 AND NOT archived FOR SHARE",
            )
            .bind(&scope.project)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
            if !body.is_some_and(|p| {
                p["cache_enabled"] == true
                    && p["cache_epoch"].as_i64().unwrap_or(0) == scope.epoch
                    && p["cache_access_epoch"].as_i64().unwrap_or(0) == scope.access_epoch
            }) {
                return Err(oas_domain::Error::cancelled());
            }
        }
        sqlx::query("INSERT INTO cache_page_states(scope,page_key,access_epoch) VALUES($1,$2,$3) ON CONFLICT(scope,page_key) DO UPDATE SET access_epoch=$3,epoch=cache_page_states.epoch+1,status=CASE WHEN cache_page_states.status IN (-1,401,403) THEN 0 ELSE cache_page_states.status END,observed_at=0,observed_order=0,not_found_count=0,retry_at=0 WHERE cache_page_states.access_epoch<>$3")
            .bind(&scope.project).bind(key).bind(scope.access_epoch).execute(&mut *tx).await.map_err(db)?;
        let epoch = sqlx::query_scalar(
            "SELECT epoch FROM cache_page_states WHERE scope=$1 AND page_key=$2",
        )
        .bind(&scope.project)
        .bind(key)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(epoch)
    }
    async fn bind_resource(
        &self,
        scope: &Scope,
        binding: &Binding,
        key: &str,
        url: &str,
    ) -> Result<()> {
        let Some(resource) = resource_key(url) else {
            return Ok(());
        };
        let mut tx = self.repo.pool.begin().await.map_err(db)?;
        if !Self::guard(&mut tx, scope, binding).await? {
            return Ok(());
        }
        sqlx::query("INSERT INTO cache_page_resources(scope,page_key,resource_key) VALUES($1,$2,$3) ON CONFLICT(scope,page_key) DO UPDATE SET resource_key=$3")
            .bind(&scope.project).bind(key).bind(resource).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(())
    }
    async fn source_status(
        &self,
        scope: &Scope,
        binding: &Binding,
        key: &str,
        observation: OriginObservation,
        collected: i64,
        epoch: i64,
        order: i64,
        retry_at: Option<i64>,
    ) -> Result<Option<i64>> {
        let mut tx = self.repo.pool.begin().await.map_err(db)?;
        if !Self::guard(&mut tx, scope, binding).await? {
            return Ok(None);
        }
        sqlx::query(
            "INSERT INTO cache_page_states(scope,page_key,access_epoch) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        )
        .bind(&scope.project)
        .bind(key)
        .bind(scope.access_epoch)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        let old=sqlx::query("SELECT epoch,status,observed_at,observed_order,not_found_count,access_epoch FROM cache_page_states WHERE scope=$1 AND page_key=$2 FOR UPDATE").bind(&scope.project).bind(key).fetch_one(&mut *tx).await.map_err(db)?;
        if old.get::<i64, _>("epoch") != epoch
            || (
                old.get::<i64, _>("observed_at"),
                old.get::<i64, _>("observed_order"),
            ) > (collected, order)
            || old.get::<i64, _>("access_epoch") != scope.access_epoch
        {
            return Ok(None);
        }
        let status = observation.stored();
        let previous = PageState::from_stored(epoch, old.get("status")).access;
        let denied = PageState::from_stored(epoch, status).access == PageAccess::Denied;
        if previous == PageAccess::Denied && !denied
            || previous == PageAccess::Gone && !denied && status != 410
        {
            return Ok(None);
        }
        if status == 404
            && old.get::<i32, _>("not_found_count") > 0
            && (
                old.get::<i64, _>("observed_at"),
                old.get::<i64, _>("observed_order"),
            ) == (collected, order)
        {
            return Ok(Some(epoch));
        }
        let not_found = if status == 404 {
            old.get::<i32, _>("not_found_count") + 1
        } else {
            0
        };
        let effective = if status == 404 && not_found >= 2 {
            410
        } else {
            status
        };
        let recover = matches!(effective, 200 | 304)
            && matches!(previous, PageAccess::VerifyNotFound | PageAccess::Gone);
        let invalid = [-1, 401, 403, 410].contains(&effective);
        let next = epoch + if invalid || recover { 1 } else { 0 };
        sqlx::query("UPDATE cache_page_states SET status=$3,observed_at=$4,epoch=$5,not_found_count=$6,observed_order=$7,retry_at=GREATEST(retry_at,$8) WHERE scope=$1 AND page_key=$2")
            .bind(&scope.project).bind(key).bind(effective).bind(collected).bind(next).bind(not_found).bind(order).bind(retry_at.unwrap_or(0)).execute(&mut *tx).await.map_err(db)?;
        if invalid && observation != OriginObservation::TargetDenied {
            // HTTP status applies to all known rendered routes backed by the
            // actual main resource, but never invalidates a newer acquisition.
            sqlx::query("INSERT INTO cache_page_states(scope,page_key,access_epoch) SELECT scope,page_key,$3 FROM cache_page_resources WHERE scope=$1 AND resource_key=(SELECT resource_key FROM cache_page_resources WHERE scope=$1 AND page_key=$2) ON CONFLICT DO NOTHING")
                .bind(&scope.project).bind(key).bind(scope.access_epoch).execute(&mut *tx).await.map_err(db)?;
            sqlx::query("UPDATE cache_page_states s SET status=$3,observed_at=$4,observed_order=$5,epoch=epoch+1,not_found_count=$6 WHERE scope=$1 AND page_key<>$2 AND (status NOT IN (-1,401,403) OR $3 IN (-1,401,403)) AND access_epoch=$7 AND (observed_at,observed_order)<=($4,$5) AND page_key IN (SELECT page_key FROM cache_page_resources WHERE scope=$1 AND resource_key=(SELECT resource_key FROM cache_page_resources WHERE scope=$1 AND page_key=$2))")
                .bind(&scope.project).bind(key).bind(effective).bind(collected).bind(order).bind(not_found).bind(scope.access_epoch).execute(&mut *tx).await.map_err(db)?;
        }
        if invalid {
            sqlx::query("DELETE FROM cache_pages p USING cache_page_states s WHERE p.scope=s.scope AND p.page_key=s.page_key AND p.scope=$1 AND s.status IN (-1,401,403,410) AND s.access_epoch=$2")
                .bind(&scope.project).bind(scope.access_epoch).execute(&mut *tx).await.map_err(db)?;
        }
        tx.commit().await.map_err(db)?;
        Ok(Some(next))
    }
    async fn save_summary(
        &self,
        scope: &Scope,
        binding: &Binding,
        key: &str,
        hash: &str,
        summary: &str,
        version: &str,
    ) -> Result<bool> {
        let mut tx = self.repo.pool.begin().await.map_err(db)?;
        if !Self::guard(&mut tx, scope, binding).await? {
            return Ok(false);
        }
        let rows=sqlx::query("UPDATE cache_pages p SET body=body||jsonb_build_object('summary',$5::text,'summary_version',$6::text) WHERE namespace=$1 AND scope=$2 AND page_key=$3 AND body->>'content_hash'=$4 AND expires_at>$7 AND NOT EXISTS(SELECT 1 FROM cache_page_states s WHERE s.scope=p.scope AND s.page_key=p.page_key AND (s.status IN (-1,401,403,410) OR s.epoch<>p.object_epoch))")
            .bind(&binding.namespace).bind(&scope.project).bind(key).bind(hash).bind(summary).bind(version).bind(chrono::Utc::now().timestamp_millis()).execute(&mut *tx).await.map_err(db)?;
        if rows.rows_affected() > 0 {
            Self::material_committed(&mut tx, scope, key, version).await?;
        }
        tx.commit().await.map_err(db)?;
        Ok(rows.rows_affected() > 0)
    }
    async fn enqueue(
        &self,
        scope: &Scope,
        binding: &Binding,
        plan: &JobPlan,
        parent: &str,
    ) -> Result<()> {
        let mut tx = self.repo.pool.begin().await.map_err(db)?;
        self.enqueue_tx(&mut tx, scope, binding, plan, parent)
            .await?;
        tx.commit().await.map_err(db)?;
        Ok(())
    }
    async fn record(&self, event: &Usage) -> Result<()> {
        let mut tx = self.repo.cache_accounting.begin().await.map_err(db)?;
        sqlx::query("SET LOCAL lock_timeout='10ms'")
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        if !event.project.starts_with("admin:") {
            let enabled=sqlx::query_scalar::<_,bool>("SELECT body->>'cache_enabled'='true' FROM resources WHERE id::text=$1 AND NOT archived FOR SHARE").bind(&event.project).fetch_optional(&mut *tx).await.map_err(db)?.unwrap_or(false);
            if !enabled && event.outcome != "disabled" {
                return Ok(());
            }
        }
        let inserted=sqlx::query("INSERT INTO cache_usage(event_id,scope,request_id,lookup_id,kind,object_id,outcome,at,origin,operation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE((SELECT origin FROM requests WHERE id::text=$3),'unknown'),COALESCE((SELECT operation FROM requests WHERE id::text=$3),'list')) ON CONFLICT DO NOTHING")
            .bind(uuid::Uuid::parse_str(&event.event_id).map_err(|_|oas_domain::Error::invalid("event_id"))?).bind(&event.project).bind(&event.request).bind(&event.lookup)
            .bind(&event.kind).bind(&event.object).bind(&event.outcome).bind(event.at).execute(&mut *tx).await.map_err(db)?;
        if inserted.rows_affected() > 0 && event.outcome == "reference" {
            sqlx::query("INSERT INTO cache_registry(scope,kind,object_id,total) VALUES($1,$2,$3,1) ON CONFLICT(scope,kind,object_id) DO UPDATE SET total=cache_registry.total+1")
                .bind(&event.project).bind(&event.kind).bind(&event.object).execute(&mut *tx).await.map_err(db)?;
            sqlx::query("INSERT INTO cache_heat_buckets(scope,kind,object_id,bucket,count) VALUES($1,$2,$3,$4,1) ON CONFLICT(scope,kind,object_id,bucket) DO UPDATE SET count=cache_heat_buckets.count+1")
                .bind(&event.project).bind(&event.kind).bind(&event.object).bind(event.at/60000*60000).execute(&mut *tx).await.map_err(db)?;
        }
        tx.commit().await.map_err(db)?;
        Ok(())
    }
    async fn readable(&self, scope: &Scope, keys: &[String]) -> Result<Vec<String>> {
        let blocked=sqlx::query_scalar::<_,String>("SELECT page_key FROM cache_page_states WHERE scope=$1 AND page_key=ANY($2) AND (status=410 OR status IN (-1,401,403) AND access_epoch=$3)")
            .bind(&scope.project).bind(keys).bind(scope.access_epoch).fetch_all(&self.repo.pool).await.map_err(db)?;
        Ok(keys
            .iter()
            .filter(|k| !blocked.contains(k))
            .cloned()
            .collect())
    }
}

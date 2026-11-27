use crate::App;
use async_trait::async_trait;
use oas_adapters::cache::{CacheMetadata, hotness, management};
use oas_application::{
    BrowserOpen, Invocation, PreparedInvocation, Transport,
    cache::*,
    engine::{Engine, Execution, ExecutionContext},
};
use oas_domain::{Command, Endpoint, Error, RequestStart, Result, Snapshot, cache::*, id};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

pub async fn supervise(app: App) {
    let metadata = CacheMetadata {
        repo: app.repo.clone(),
        settings: app.cache.settings.clone(),
    };
    let mut workers = tokio::task::JoinSet::new();
    let mut interval = tokio::time::interval(Duration::from_millis(200));
    let maintenance = Arc::new(tokio::sync::Semaphore::new(1));
    let mut refresh_at = tokio::time::Instant::now();
    let mut config_at = refresh_at;
    let mut index_at = refresh_at;
    loop {
        tokio::select! {_=app.scheduler.stopped()=>break,_=interval.tick()=>{},Some(result)=workers.join_next(),if !workers.is_empty()=>{if let Err(error)=result{tracing::error!(%error,"cache task supervisor failed");}}}
        if tokio::time::Instant::now() >= config_at {
            if let (Ok(browser), Ok(model)) = (
                management::settings(&app.repo, "cache-concurrency").await,
                management::settings(&app.repo, "cache-model-budgets").await,
            ) {
                app.scheduler.configure_cache(
                    browser["configured_limit"].as_u64().unwrap_or(1) as usize,
                    model["concurrency"].as_u64().unwrap_or(1) as usize,
                    model["rpm"].as_u64().unwrap_or(10) as usize,
                );
            }
            config_at = tokio::time::Instant::now() + Duration::from_secs(2);
        }
        if tokio::time::Instant::now() >= refresh_at
            && let Ok(permit) = maintenance.clone().try_acquire_owned()
        {
            let (m, b, cache) = (
                metadata.clone(),
                app.cache.binding.clone(),
                app.cache.clone(),
            );
            workers.spawn(async move {
                let _permit = permit;
                if let Err(error) = hotness::refresh(&m, &b, cache.handler.as_ref()).await {
                    tracing::warn!(code=%error.code,"cache hotness refresh failed");
                }
                if let Err(error) = oas_adapters::cache::garbage::collect(&m, &cache).await {
                    tracing::warn!(code=%error.code,"cache capacity maintenance failed");
                }
            });
            refresh_at = tokio::time::Instant::now() + Duration::from_secs(60);
        }
        if tokio::time::Instant::now() >= index_at {
            if let Err(error) = backfill(&app).await {
                tracing::warn!(code=%error.code,"cache index backfill scheduling failed");
            }
            index_at = tokio::time::Instant::now() + Duration::from_secs(5);
        }
        while workers.len() < 8 {
            let capacity = app.scheduler.cache_capacity();
            let browser = capacity["background_active"].as_u64().unwrap_or(0)
                < capacity["effective_limit"].as_u64().unwrap_or(0)
                && capacity["foreground_waiting"] == 0;
            match metadata.claim(&app.cache.binding, browser, true).await {
                Ok(Some(task)) => {
                    let (app, m) = (app.clone(), metadata.clone());
                    workers.spawn(async move {
                        process(app, m, task).await;
                    });
                }
                Ok(None) => break,
                Err(error) => {
                    tracing::warn!(code=%error.code,"cache task claim failed");
                    break;
                }
            }
        }
    }
    workers.abort_all();
    while workers.join_next().await.is_some() {}
}
async fn process(app: App, metadata: CacheMetadata, task: Task) {
    let deadline = tokio::time::Instant::now()
        + Duration::from_millis((task.deadline - now()).clamp(0, 45000) as u64);
    let result = tokio::time::timeout_at(deadline, execute(&app, &metadata, &task))
        .await
        .unwrap_or_else(|_| Err(Error::timeout()));
    let retry_after = result
        .as_ref()
        .err()
        .and_then(|e| e.details["retry_after_ms"].as_i64());
    let error = result.as_ref().err().map(|e| e.code.as_str());
    if let Err(error) = metadata.complete(&task, error, retry_after).await {
        tracing::warn!(code=%error.code,"cache task completion was not recorded");
    }
}
async fn execute(app: &App, metadata: &CacheMetadata, task: &Task) -> Result<()> {
    let plan = app.cache.handler.execute_job(task)?;
    let mut guard_scope = task.scope.clone();
    if matches!(plan.kind.as_str(), "list" | "content" | "summary") {
        guard_scope.access_epoch = -1;
    }
    if !app
        .cache
        .metadata
        .valid(&guard_scope, &task.binding)
        .await?
    {
        return Err(Error::cancelled());
    }
    match plan.kind.as_str() {
        "index" => {
            sqlx::query("UPDATE cache_jobs SET input=input||jsonb_build_object('encoding_version',$3::text) WHERE id::text=$1 AND lease::text=$2")
                .bind(&task.id).bind(&task.lease).bind(app.cache.embedding.version()).execute(&app.repo.pool).await.map_err(|_|Error::internal())?;
            if !app.cache.embedding.configured() {
                return Err(Error::new(
                    "CACHE_CONFIGURATION_MISSING",
                    503,
                    "未配置统一向量服务。",
                    "The embedding service is not configured.",
                ));
            }
            let row=sqlx::query_scalar::<_,Value>("SELECT body FROM cache_snapshots WHERE id::text=$1 AND namespace=$2 AND expires_at>$3 AND index_version<>$4").bind(&plan.target).bind(&task.binding.namespace).bind(now()).bind(app.cache.embedding.version()).fetch_optional(&app.repo.pool).await.map_err(|_|Error::internal())?;
            if let Some(row) = row {
                let snapshot: SearchSnapshot =
                    serde_json::from_value(row).map_err(|_| Error::internal())?;
                metadata.dispatched(task).await?;
                if !app.cache.index_search(&task.scope, &snapshot).await? {
                    return Err(Error::cancelled());
                }
                sqlx::query(
                    "UPDATE cache_snapshots SET indexed=true,index_version=$2 WHERE id::text=$1",
                )
                .bind(&plan.target)
                .bind(app.cache.embedding.version())
                .execute(&app.repo.pool)
                .await
                .map_err(|_| Error::internal())?;
            }
            Ok(())
        }
        "publish_page" => {
            if task.attempt > 0
                && metadata
                    .committed_version(task, &task.scope)
                    .await?
                    .is_some()
            {
                return Ok(());
            }
            if !app.cache.objects.configured() {
                return Err(Error::new(
                    "CACHE_CONFIGURATION_MISSING",
                    503,
                    "未配置正文对象存储。",
                    "Content object storage is not configured.",
                ));
            }
            let page: Page = serde_json::from_value(plan.input["page"].clone())
                .map_err(|_| Error::internal())?;
            if metadata
                .page(&task.scope, &task.binding, &page.key, now())
                .await?
                .is_some_and(|current| {
                    (current.collected_at, current.acquisition_order)
                        >= (page.collected_at, page.acquisition_order)
                })
            {
                return Ok(());
            }
            app.cache.publish_page(&task.scope, &page).await.map(|_| ())
        }
        "list" | "content" | "summary" => {
            let mut snapshot = latest_snapshot(app, &task.scope).await?;
            let mut scope = Scope::from_snapshot(&snapshot, app.cache.settings.summary_tokens);
            if task.scope.project.starts_with("admin:") {
                scope.project = task.scope.project.clone();
                scope.sources.extend(task.scope.sources.clone());
            }
            scope.lease = Some(task.lease.clone());
            if scope.epoch != task.scope.epoch
                || !app.cache.metadata.valid(&scope, &task.binding).await?
            {
                return Err(Error::cancelled());
            }
            let object_epoch = if scope.access_epoch != task.scope.access_epoch
                && matches!(plan.kind.as_str(), "content" | "summary")
            {
                app.cache.metadata.page_epoch(&scope, &plan.target).await?
            } else {
                plan.object_epoch
            };
            if task.attempt > 0
                && let Some(version) = metadata.committed_version(task, &scope).await?
            {
                // A content goal may have committed its body before queuing the derived summary.
                if plan.kind == "content"
                    && let Some(page) = metadata
                        .page(&scope, &task.binding, &plan.target, now())
                        .await?
                {
                    queue_missing_summary(
                        app.cache.handler.as_ref(),
                        metadata,
                        &scope,
                        &task.binding,
                        &page,
                        &task.id,
                    )
                    .await?;
                }
                if plan.kind != "summary" || scope.summary_version.as_deref() == Some(&version) {
                    return Ok(());
                }
            }
            if plan.kind == "list" {
                let candidates = metadata
                    .snapshots(
                        &scope,
                        &task.binding,
                        std::slice::from_ref(&plan.target),
                        &plan.target,
                        app.cache.handler.snapshots_per_question(),
                        now(),
                    )
                    .await?;
                if candidates.iter().any(|s| {
                    s.collected_at >= task.created_at
                        || plan.input["expired_generation"]
                            .as_i64()
                            .is_some_and(|old| s.collected_at > old)
                }) {
                    return Ok(());
                }
            }
            if plan.kind == "content" {
                let state = metadata.source_state(&scope, &plan.target).await?;
                if state.epoch != object_epoch
                    || state.access == PageAccess::Denied
                    || state.access == PageAccess::Gone && plan.reason != "origin_recovery"
                {
                    return Err(Error::new(
                        "CACHE_SOURCE_GONE",
                        410,
                        "源站已撤下或拒绝访问。",
                        "The origin removed or denied this page.",
                    ));
                }
                let verify_missing = state.access == PageAccess::VerifyNotFound;
                if app.cache.metadata.reading(&scope, &plan.target).await? {
                    let mut error = Error::new(
                        "CACHE_MATERIAL_PENDING",
                        503,
                        "等待前台已经开始的取文。",
                        "Waiting for the existing foreground read.",
                    );
                    error.details = Box::new(json!({"retry_after_ms":500}));
                    return Err(error);
                }
                if !verify_missing
                    && let Some(page) = metadata
                        .page(&scope, &task.binding, &plan.target, now())
                        .await?
                {
                    return queue_missing_summary(
                        app.cache.handler.as_ref(),
                        metadata,
                        &scope,
                        &task.binding,
                        &page,
                        &task.id,
                    )
                    .await;
                }
                if metadata
                    .pending_page(&scope, &task.binding, &plan.target, now())
                    .await?
                    .is_some()
                {
                    let mut error = Error::new(
                        "CACHE_MATERIAL_PENDING",
                        503,
                        "等待已获取的正文提交。",
                        "Waiting for the acquired page to commit.",
                    );
                    error.details = Box::new(json!({"retry_after_ms":500}));
                    return Err(error);
                }
            }
            let transport = Arc::new(BackgroundTransport {
                inner: Arc::new(app.providers.clone()),
                metadata: metadata.clone(),
                task: task.clone(),
                scope: scope.clone(),
                object_epoch,
            });
            let engine = Engine {
                transport,
                scheduler: app.scheduler.clone(),
                cache: None,
                background: true,
            };
            snapshot.project.search_limit = 10;
            snapshot.project.search_pools = vec![vec![oas_domain::BROWSER_SEARCH.into()]];
            snapshot.project.reader_pools = vec![vec![oas_domain::BROWSER_READER.into()]];
            let request = id();
            let cancel = CancellationToken::new();
            let remaining = (task.deadline - now()).clamp(0, 45000) as u64;
            let context = ExecutionContext {
                request_id: request.clone(),
                ui_language: "zh".into(),
                cancel: cancel.clone(),
                deadline: tokio::time::Instant::now() + Duration::from_millis(remaining),
            };
            let _registration = if app.scheduler.register_background(
                &request,
                Some(scope.project.clone()),
                cancel.clone(),
            ) {
                Some(crate::http::Registration {
                    scheduler: app.scheduler.clone(),
                    request: request.clone(),
                })
            } else {
                return Err(Error::cancelled());
            };
            metadata.execution_started(task,&request,json!({"stage":"configuration","request_id":request,"at":now(),"project_version":snapshot.project.version,"model_version":scope.summary_version,"proxy_pool":snapshot.project.browser_proxy_pool_id})).await?;
            if plan.kind == "summary" {
                return summarize(app, task, &scope, &snapshot, &engine, context).await;
            }
            let query = if plan.kind == "list" {
                Some(
                    serde_json::from_value::<Query>(plan.input["query"].clone())
                        .map_err(|_| Error::invalid("query"))?,
                )
            } else {
                None
            };
            if plan.kind == "content"
                && let Some(url) = plan.input["url"].as_str()
            {
                metadata
                    .bind_resource(&scope, &task.binding, &plan.target, url)
                    .await?;
            }
            let command = if let Some(query) = &query {
                Command {
                    query: Some(query.text.clone()),
                    language: query.language.clone(),
                    time_range: query.time_range.clone(),
                    region: query.region.clone(),
                    count: Some(10),
                    ..Default::default()
                }
            } else {
                Command {
                    url: plan.input["url"]
                        .as_str()
                        .map(str::to_owned)
                        .or(Some(plan.target.clone())),
                    ..Default::default()
                }
            };
            let operation = if query.is_some() { "list" } else { "content" };
            let start = start(
                app,
                &snapshot,
                &scope,
                &request,
                operation,
                json!({"cache_task":task.id,"input":command}),
            )
            .await?;
            let execution = engine.run(operation, command, snapshot, context).await;
            let outcome = async {
                if matches!(
                    execution.response["status"].as_str(),
                    Some("error" | "cancelled")
                ) {
                    let mut error = error_from(&execution.response);
                    if plan.kind == "content"
                        && let Some(resource) = error.details["source_url"].as_str()
                    {
                        metadata
                            .bind_resource(&scope, &task.binding, &plan.target, resource)
                            .await?;
                    }
                    if plan.kind == "content"
                        && let Some(observation) = OriginObservation::from_error(&error)
                    {
                        app.cache
                            .metadata
                            .source_status(
                                &scope,
                                &task.binding,
                                &plan.target,
                                observation,
                                collected_at(&execution),
                                object_epoch,
                                acquisition_order(&execution),
                                error.details["retry_after_ms"]
                                    .as_i64()
                                    .map(|ms| now().saturating_add(ms.max(0))),
                            )
                            .await?;
                        if observation == OriginObservation::Http(404) {
                            error.details["retry_after_ms"] = json!(
                                error.details["retry_after_ms"]
                                    .as_i64()
                                    .unwrap_or(0)
                                    .max(60000)
                            );
                            if metadata.source_state(&scope, &plan.target).await?.access
                                == PageAccess::Gone
                            {
                                error = Error::new(
                                    "CACHE_SOURCE_GONE",
                                    410,
                                    "源站连续两次返回未找到。",
                                    "The origin returned not found twice.",
                                );
                            }
                        }
                        if matches!(
                            observation,
                            OriginObservation::TargetDenied
                                | OriginObservation::Http(401 | 403 | 410)
                        ) {
                            error = Error::new(
                                "CACHE_SOURCE_GONE",
                                410,
                                "源站已撤下或拒绝访问。",
                                "The origin removed or denied this page.",
                            );
                        }
                    }
                    Err(error)
                } else if let Some(query) = query {
                    let raw = execution.evidence["variants"][0]["hits"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    let hits = raw
                        .into_iter()
                        .filter_map(|v| serde_json::from_value::<oas_domain::Hit>(v).ok())
                        .collect();
                    let collected = collected_at(&execution);
                    let value = SearchSnapshot {
                        request_id: request.clone(),
                        id: id(),
                        question: query.id(),
                        query,
                        source: oas_domain::BROWSER_SEARCH.into(),
                        call_id: execution.evidence["variants"][0]["result_call_id"]
                            .as_str()
                            .unwrap_or(&request)
                            .to_owned(),
                        collected_at: collected,
                        acquisition_order: acquisition_order(&execution),
                        expires_at: 0,
                        hits,
                        partial: execution.response["status"] == "partial",
                        engine_answer: execution.response["data"].get("engine_answer").cloned(),
                        cards: execution.response["data"]["cards"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default(),
                    };
                    match app.cache.acquire_search(&scope, value).await {
                        Ok(WriteReceipt::NotAdmitted) => Err(Error::new(
                            "CACHE_NOT_ADMITTED",
                            200,
                            "已搜索，结果未达到缓存准入条件。",
                            "The search completed without meeting cache admission requirements.",
                        )),
                        Ok(_) => Ok(()),
                        Err(error) => Err(error),
                    }
                } else {
                    let material = execution
                        .materials
                        .iter()
                        .find(|v| v["markdown"].as_str().is_some_and(|s| !s.is_empty()));
                    if let Some(material) = material {
                        let collected = collected_at(&execution);
                        if let Some(resource) = material["final_url"].as_str() {
                            metadata
                                .bind_resource(&scope, &task.binding, &plan.target, resource)
                                .await?;
                        }
                        let markdown = material["markdown"].as_str().unwrap().to_owned();
                        let page = Page {
                            final_url: material["final_url"].as_str().map(str::to_owned),
                            key: plan.target.clone(),
                            url: plan.input["url"].as_str().unwrap_or(&plan.target).into(),
                            source: oas_domain::BROWSER_READER.into(),
                            call_id: material["call_id"].as_str().unwrap_or(&request).into(),
                            title: execution.response["data"]["title"]
                                .as_str()
                                .unwrap_or("")
                                .into(),
                            content_hash: hash(&markdown),
                            markdown,
                            collected_at: collected,
                            acquisition_order: acquisition_order(&execution),
                            expires_at: 0,
                            summary: None,
                            summary_version: None,
                            object_epoch,
                            object_key: String::new(),
                        };
                        if let Some(page) = app.cache.prepare_page(page)? {
                            app.cache.publish_page(&scope, &page).await?;
                            let current = metadata
                                .page(&scope, &task.binding, &page.key, now())
                                .await?
                                .ok_or_else(Error::cancelled)?;
                            queue_missing_summary(
                                app.cache.handler.as_ref(),
                                metadata,
                                &scope,
                                &task.binding,
                                &current,
                                &request,
                            )
                            .await?;
                            Ok(())
                        } else {
                            Err(Error::new(
                                "CACHE_NOT_ADMITTED",
                                200,
                                "正文未达到缓存准入条件。",
                                "The page did not meet cache admission requirements.",
                            ))
                        }
                    } else {
                        Err(Error::unavailable())
                    }
                }
            }
            .await;
            record(app, start, execution).await;
            outcome
        }
        _ => Err(Error::invalid("task_kind")),
    }
}
async fn queue_missing_summary(
    handler: &dyn CacheHandler,
    metadata: &CacheMetadata,
    scope: &Scope,
    binding: &Binding,
    page: &Page,
    parent: &str,
) -> Result<()> {
    let selected = SelectedPage {
        url: &page.url,
        key: &page.key,
        object_epoch: page.object_epoch,
        existing: Some(page),
        acquired: true,
        summary_version: scope.summary_version.as_deref(),
    };
    if let Some(plan) = handler.on_selected(selected) {
        metadata.enqueue(scope, binding, &plan, parent).await?;
    }
    Ok(())
}
async fn backfill(app: &App) -> Result<()> {
    use sqlx::Row;
    let rows=sqlx::query("SELECT s.body,s.scope,r.body AS project_body FROM cache_snapshots s LEFT JOIN resources r ON r.id::text=s.scope WHERE namespace=$1 AND expires_at>$2 AND index_version<>$3 AND ((s.scope LIKE 'admin:%' AND s.access_epoch=COALESCE((SELECT e.version FROM resources e WHERE e.id::text=substr(s.scope,7) AND NOT e.archived),-1)) OR (r.body->>'cache_enabled'='true' AND s.access_epoch=COALESCE((r.body->>'cache_access_epoch')::bigint,0))) AND (s.source IN ($4,$5) OR EXISTS(SELECT 1 FROM resources e WHERE e.id::text=s.source AND NOT e.archived) AND (s.scope LIKE 'admin:%' OR EXISTS(SELECT 1 FROM resource_links l WHERE l.owner_id::text=s.scope AND l.target_id::text=s.source))) AND NOT EXISTS(SELECT 1 FROM cache_jobs j WHERE j.namespace=s.namespace AND j.kind='index' AND j.target=s.id::text AND (j.state IN ('waiting','retry','running') OR j.input->>'encoding_version'=$3)) ORDER BY s.collected_at DESC LIMIT 32")
        .bind(&app.cache.binding.namespace).bind(now()).bind(app.cache.embedding.version()).bind(oas_domain::BROWSER_SEARCH).bind(oas_domain::BROWSER_READER).fetch_all(&app.repo.pool).await.map_err(|_|Error::internal())?;
    for row in rows {
        let snapshot: SearchSnapshot =
            serde_json::from_value(row.get("body")).map_err(|_| Error::internal())?;
        let project: Option<oas_domain::Project> = row
            .try_get::<Value, _>("project_body")
            .ok()
            .and_then(|p| serde_json::from_value(p).ok());
        let scope = if let Some(project) = project.filter(|p| p.cache_enabled) {
            Scope::from_project(&project)
        } else if row.get::<String, _>("scope").starts_with("admin:") {
            let scope = row.get::<String, _>("scope");
            let version = app
                .repo
                .resource("endpoints", scope.strip_prefix("admin:").unwrap())
                .await?["version"]
                .as_i64()
                .unwrap_or(0);
            Scope {
                project: scope,
                epoch: 0,
                access_epoch: version,
                sources: [
                    snapshot.source.clone(),
                    oas_domain::BROWSER_SEARCH.into(),
                    oas_domain::BROWSER_READER.into(),
                ]
                .into(),
                lease: None,
                summary_version: None,
            }
        } else {
            continue;
        };
        app.cache.enqueue(&scope,&JobPlan{kind:"index".into(),target:snapshot.id.clone(),reason:"index_version".into(),input:json!({"snapshot":snapshot.id,"encoding_version":app.cache.embedding.version()}),object_epoch:0},&snapshot.request_id).await;
    }
    sqlx::query("UPDATE cache_index_control SET ready=true WHERE namespace=$1 AND encoding=$2 AND NOT EXISTS(SELECT 1 FROM cache_snapshots s LEFT JOIN resources r ON r.id::text=s.scope WHERE namespace=$1 AND expires_at>$3 AND index_version<>$2 AND ((s.scope LIKE 'admin:%' AND s.access_epoch=COALESCE((SELECT e.version FROM resources e WHERE e.id::text=substr(s.scope,7) AND NOT e.archived),-1)) OR (r.body->>'cache_enabled'='true' AND s.access_epoch=COALESCE((r.body->>'cache_access_epoch')::bigint,0))) AND (s.source IN ($4,$5) OR EXISTS(SELECT 1 FROM resources e WHERE e.id::text=s.source AND NOT e.archived) AND (s.scope LIKE 'admin:%' OR EXISTS(SELECT 1 FROM resource_links l WHERE l.owner_id::text=s.scope AND l.target_id::text=s.source))))")
        .bind(&app.cache.binding.namespace).bind(app.cache.embedding.version()).bind(now()).bind(oas_domain::BROWSER_SEARCH).bind(oas_domain::BROWSER_READER).execute(&app.repo.pool).await.map_err(|_|Error::internal())?;
    Ok(())
}
pub async fn latest_snapshot(app: &App, scope: &Scope) -> Result<Snapshot> {
    let mut snapshot = if scope.project.starts_with("admin:") {
        let resource = app
            .repo
            .resource(
                "endpoints",
                scope.project.strip_prefix("admin:").unwrap_or_default(),
            )
            .await?;
        let mut project: oas_domain::Project=serde_json::from_value(json!({"id":point_id(&scope.project),"name":"Administrator cache","version":1,"search_pools":[],"reader_pools":[],"cache_enabled":true,"cache_access_epoch":resource["version"]})).unwrap();
        if resource["kind"] == "search" {
            project.search_pools = vec![vec![resource["id"].as_str().unwrap().into()]];
        }
        if resource["kind"] == "reader" {
            project.reader_pools = vec![vec![resource["id"].as_str().unwrap().into()]];
        }
        let mut probes = std::collections::HashMap::new();
        use sqlx::Row;
        for row in sqlx::query("SELECT egress_id,body FROM probes")
            .fetch_all(&app.repo.pool)
            .await
            .map_err(|_| Error::internal())?
        {
            probes.insert(row.get::<String, _>("egress_id"), row.get("body"));
        }
        Snapshot {
            project,
            endpoints: vec![serde_json::from_value(resource).map_err(|_| Error::internal())?],
            proxies: vec![],
            pools: vec![],
            routes: json!({"entries":[]}),
            secrets: Default::default(),
            probes,
            retention_days: 7,
            retention_version: 1,
        }
    } else {
        let mut connection = app
            .repo
            .pool
            .acquire()
            .await
            .map_err(|_| Error::internal())?;
        app.repo
            .load_snapshot(
                &mut connection,
                uuid::Uuid::parse_str(&scope.project).map_err(|_| Error::invalid("project"))?,
            )
            .await?
    };
    for eid in [oas_domain::BROWSER_SEARCH, oas_domain::BROWSER_READER] {
        if !snapshot.endpoints.iter().any(|e| e.id == eid) {
            let body = app.repo.resource("endpoints", eid).await?;
            snapshot
                .endpoints
                .push(serde_json::from_value(body).map_err(|_| Error::internal())?);
        }
    }
    let ready = app.scheduler.workers().len();
    for e in &mut snapshot.endpoints {
        if e.browser() {
            e.availability = if ready > 0 {
                "available"
            } else {
                "no_ready_pods"
            }
            .into();
            e.ready_pods = Some(ready);
        }
    }
    Ok(snapshot)
}
fn acquisition_order(execution: &Execution) -> i64 {
    execution
        .calls
        .iter()
        .filter_map(|v| v["started_at"].as_str())
        .filter_map(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .filter_map(|t| t.timestamp_nanos_opt())
        .max()
        .unwrap_or(0)
}
fn collected_at(execution: &Execution) -> i64 {
    execution
        .calls
        .iter()
        .filter_map(|v| v["started_at"].as_str())
        .filter_map(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.timestamp_millis())
        .max()
        .unwrap_or_else(now)
}
fn error_from(response: &Value) -> Error {
    let code = response["error"]["code"]
        .as_str()
        .unwrap_or("CACHE_TASK_FAILED");
    let mut error = Error::new(
        code,
        502,
        "后台缓存任务未完成。",
        "The cache task did not complete.",
    );
    error.details = Box::new(if response["error"]["details"].is_object() {
        response["error"]["details"].clone()
    } else {
        json!({})
    });
    error
}
async fn start(
    app: &App,
    snapshot: &Snapshot,
    scope: &Scope,
    request: &str,
    operation: &str,
    input: Value,
) -> Result<RequestStart> {
    app.repo
        .start(&RequestStart {
            id: request.into(),
            project: (!scope.project.starts_with("admin:")).then(|| scope.project.clone()),
            operation: operation.into(),
            origin: "cache_background".into(),
            language: Some("zh".into()),
            input,
            started_at: chrono::Utc::now(),
            retention_days: snapshot.retention_days,
            retention_version: snapshot.retention_version,
            snapshot: {
                let mut recorded = snapshot.recording();
                recorded["cache"] = json!(app.cache.binding);
                recorded
            },
        })
        .await
}
async fn record(app: &App, start: RequestStart, execution: Execution) {
    let duration = (now() - start.started_at.timestamp_millis()).max(0) as u64;
    let _ = app.repo.terminal(&start, &execution, duration).await;
    let _ = app.traces.try_send(crate::traces::Message::Record(Box::new(
        crate::traces::Record {
            start,
            execution,
            duration,
        },
    )));
}
async fn summarize(
    app: &App,
    task: &Task,
    scope: &Scope,
    snapshot: &Snapshot,
    engine: &Engine,
    context: ExecutionContext,
) -> Result<()> {
    let page = app
        .cache
        .metadata
        .page(scope, &task.binding, &task.plan.target, now())
        .await?;
    let Some(page) = page else {
        let pending = app.cache.metadata.reading(scope, &task.plan.target).await?
            || app
                .cache
                .metadata
                .pending_page(scope, &task.binding, &task.plan.target, now())
                .await?
                .is_some();
        if pending || now() - task.created_at < 10000 {
            let mut error = Error::new(
                "CACHE_MATERIAL_PENDING",
                503,
                "等待已取得正文发布。",
                "Waiting for acquired content to be published.",
            );
            error.details = Box::new(
                json!({"retry_after_ms":if app.cache.objects.configured(){1000}else{30000}}),
            );
            return Err(error);
        }
        return Err(Error::new(
            "CACHE_NOT_ADMITTED",
            200,
            "没有可复用的正文版本，等待后续真实需求。",
            "No usable content version is available; waiting for a new demand.",
        ));
    };
    if task.plan.input["hash"]
        .as_str()
        .is_some_and(|h| h != page.content_hash)
    {
        return Ok(());
    }
    let endpoint = snapshot
        .project
        .model_endpoint_id
        .as_ref()
        .and_then(|id| snapshot.endpoints.iter().find(|e| &e.id == id))
        .ok_or_else(Error::unavailable)?;
    if page.summary.is_some() && page.summary_version == scope.summary_version {
        return Ok(());
    }
    let markdown = app.cache.objects.get(&page.object_key).await?;
    let endpoint_owned = endpoint.clone();
    let title = page.title.clone();
    let budget = app.cache.settings.summary_tokens;
    let input = tokio::task::spawn_blocking(move || {
        summary_input(&endpoint_owned, &title, &markdown, budget)
    })
    .await
    .map_err(|_| Error::internal())??;
    let start = start(
        app,
        snapshot,
        scope,
        &context.request_id,
        "summary",
        json!({"cache_task":task.id,"url":page.url,"input_tokens_limit":budget}),
    )
    .await?;
    let execution = engine
        .test(
            endpoint.clone(),
            "cache_summary",
            input,
            snapshot.clone(),
            context,
        )
        .await;
    let output = execution
        .spans
        .iter()
        .find_map(|s| s["output"]["summary"].as_str())
        .map(str::to_owned);
    let result = async {
        if matches!(
            execution.response["status"].as_str(),
            Some("error" | "cancelled")
        ) {
            Err(error_from(&execution.response))
        } else if let Some(summary) = output {
            let encoding = endpoint.options["tokenizer"]
                .as_str()
                .unwrap_or("cl100k_base");
            if oas_domain::tokens::count(encoding, &summary)? > 1000 {
                Err(Error::invalid("summary"))
            } else {
                let committed = app
                    .cache
                    .metadata
                    .save_summary(
                        scope,
                        &task.binding,
                        &page.key,
                        &page.content_hash,
                        &summary,
                        scope.summary_version.as_deref().unwrap_or(""),
                    )
                    .await?;
                if committed {
                    Ok(())
                } else {
                    Err(Error::cancelled())
                }
            }
        } else {
            Err(Error::unavailable())
        }
    }
    .await;
    record(app, start, execution).await;
    result
}
fn summary_input(endpoint: &Endpoint, title: &str, markdown: &str, budget: usize) -> Result<Value> {
    let encoding = endpoint.options["tokenizer"]
        .as_str()
        .unwrap_or("cl100k_base");
    let prefix = oas_domain::tokens::split(encoding, markdown, budget, 1)?
        .into_iter()
        .next()
        .map(|(_, s)| s)
        .ok_or_else(Error::unavailable)?;
    let chars = prefix.chars().collect::<Vec<_>>();
    let (mut low, mut high, mut accepted) = (1, chars.len(), None);
    while low <= high {
        let middle = low + (high - low) / 2;
        let input = json!({"title":title,"text":chars[..middle].iter().collect::<String>()});
        if oas_domain::model::fits(endpoint, "cache_summary", &input)? {
            accepted = Some(input);
            low = middle + 1;
        } else {
            high = middle.saturating_sub(1);
        }
    }
    accepted.ok_or_else(Error::unavailable)
}
struct BackgroundTransport {
    scope: Scope,
    object_epoch: i64,
    inner: Arc<dyn Transport>,
    metadata: CacheMetadata,
    task: Task,
}
#[async_trait]
impl Transport for BackgroundTransport {
    async fn validate(&self, e: &Endpoint) -> Result<()> {
        self.inner.validate(e).await
    }
    async fn preflight(
        &self,
        e: &Endpoint,
        task: &str,
        input: &Value,
    ) -> Result<PreparedInvocation> {
        self.inner.preflight(e, task, input).await
    }
    async fn invoke(&self, invocation: Invocation<'_>) -> Result<Value> {
        self.metadata
            .dispatch_checked(&self.task, &self.scope, self.object_epoch)
            .await?;
        self.inner.invoke(invocation).await
    }
    async fn open_browser(&self, open: BrowserOpen<'_>) -> Result<Value> {
        self.metadata
            .dispatch_checked(&self.task, &self.scope, self.object_epoch)
            .await?;
        self.inner.open_browser(open).await
    }
    async fn close_browser(&self, session: &Value) -> Result<()> {
        self.inner.close_browser(session).await
    }
    async fn search_engine_failed(&self, s: &Value, r: &str) -> Result<()> {
        self.inner.search_engine_failed(s, r).await
    }
    async fn risk(&self, id: &str, until: i64) -> Result<()> {
        self.inner.risk(id, until).await
    }
    async fn proxy_state(&self, id: &str, version: i64, state: &Value) -> Result<()> {
        self.inner.proxy_state(id, version, state).await
    }
}

use crate::repository::{Repository, db};
use oas_domain::{Error, Result};
use serde_json::{Value, json};
use sqlx::Row;

pub async fn settings(repo: &Repository, name: &str) -> Result<Value> {
    let row = sqlx::query("SELECT version,body FROM settings WHERE name=$1")
        .bind(name)
        .fetch_one(&repo.pool)
        .await
        .map_err(db)?;
    let mut body: Value = row.get("body");
    body["version"] = json!(row.get::<i64, _>("version"));
    Ok(body)
}
pub async fn save_settings(
    repo: &Repository,
    name: &str,
    mut input: Value,
    ready_tabs: usize,
) -> Result<Value> {
    let expected = input["expected_version"]
        .as_i64()
        .ok_or_else(|| Error::invalid("expected_version"))?;
    let body = input
        .as_object_mut()
        .ok_or_else(|| Error::invalid("body"))?;
    body.remove("expected_version");
    match name {
        "cache-concurrency" => {
            oas_domain::validation::allowed_fields(&input, &["configured_limit"])?;
            let value = input["configured_limit"]
                .as_u64()
                .filter(|v| *v >= 1)
                .ok_or_else(|| Error::invalid("configured_limit"))?;
            if ready_tabs < 2 || value >= ready_tabs as u64 {
                return Err(Error::new(
                    "CACHE_CAPACITY_CHANGED",
                    409,
                    "浏览器标签容量已变化，请重读可用范围。",
                    "Browser capacity changed. Reload the allowed range.",
                )
                .field("configured_limit"));
            }
        }
        "cache-policy" => {
            oas_domain::validation::allowed_fields(&input, &["list", "content"])?;
            for kind in ["list", "content"] {
                let mut p: oas_domain::cache::HotPolicy =
                    serde_json::from_value(input[kind].clone())
                        .map_err(|_| Error::invalid(kind))?;
                p.validate()?;
                input[kind] = json!(p);
            }
        }
        "cache-model-budgets" => {
            oas_domain::validation::allowed_fields(&input, &["concurrency", "rpm"])?;
            for key in ["concurrency", "rpm"] {
                if input[key].as_u64().is_none_or(|v| v == 0 || v > 100000) {
                    return Err(Error::invalid(key));
                }
            }
        }
        _ => return Err(crate::repository::missing()),
    }
    let row=sqlx::query("UPDATE settings SET version=version+1,body=$3 WHERE name=$1 AND version=$2 RETURNING version")
        .bind(name).bind(expected).bind(&input).fetch_optional(&repo.pool).await.map_err(db)?.ok_or_else(||Error::new("VERSION_CONFLICT",409,"配置版本已变化，请重读。","Configuration changed. Reload it."))?;
    input["version"] = json!(row.get::<i64, _>("version"));
    Ok(input)
}
pub struct Filters<'a> {
    pub scope: Option<&'a str>,
    pub origin: Option<&'a str>,
    pub operation: Option<&'a str>,
    pub kind: Option<&'a str>,
    pub since: i64,
    pub until: i64,
}
pub async fn overview(repo: &Repository, namespace: &str, filters: &Filters<'_>) -> Result<Value> {
    let Filters {
        scope,
        origin,
        operation,
        since,
        until,
        ..
    } = *filters;
    let scopes=sqlx::query_scalar::<_,String>("SELECT id::text FROM resources WHERE kind='projects' AND NOT archived AND body->>'cache_enabled'='true' UNION SELECT DISTINCT scope FROM cache_registry WHERE scope LIKE 'admin:%'").fetch_all(&repo.pool).await.map_err(db)?;
    let live = scopes
        .into_iter()
        .filter(|s| scope.is_none_or(|p| p == s))
        .collect::<Vec<_>>();
    let now = chrono::Utc::now().timestamp_millis();
    let inv=sqlx::query("SELECT count(*) AS snapshots,count(DISTINCT (s.scope,s.question)) AS questions FROM cache_snapshots s LEFT JOIN resources r ON r.id::text=s.scope WHERE namespace=$1 AND s.scope=ANY($2) AND expires_at>$3 AND indexed AND (EXISTS(SELECT FROM cache_visible_snapshot_links(s,$3)) OR cache_visible_snapshot_answer(s)) AND s.access_epoch=CASE WHEN s.scope LIKE 'admin:%' THEN COALESCE((SELECT version FROM resources WHERE id::text=substr(s.scope,7) AND NOT archived),-1) ELSE COALESCE((r.body->>'cache_access_epoch')::bigint,0) END AND (s.source IN ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002') OR EXISTS(SELECT 1 FROM resources e WHERE e.id::text=s.source AND NOT archived) AND (s.scope LIKE 'admin:%' OR EXISTS(SELECT 1 FROM resource_links l WHERE l.owner_id::text=s.scope AND l.target_id::text=s.source)))").bind(namespace).bind(&live).bind(now).fetch_one(&repo.pool).await.map_err(db)?;
    let model_rows=sqlx::query("SELECT r.id::text AS scope,m.id::text AS model_id,m.version,m.body->'options' AS options FROM resources r JOIN resources m ON m.id::text=r.body->>'model_endpoint_id' WHERE r.id::text=ANY($1) AND NOT m.archived").bind(&live).fetch_all(&repo.pool).await.map_err(db)?;
    let summary_tokens = oas_application::cache::CacheSettings::from_env()?.summary_tokens;
    let compatible=model_rows.iter().map(|r|json!({"scope":r.get::<String,_>("scope"),"version":oas_domain::cache::summary_identity(&r.get::<String,_>("model_id"),r.get("version"),&r.get::<Value,_>("options"),summary_tokens)})).collect::<Vec<_>>();
    let pages=sqlx::query("SELECT count(*) AS pages,count(*) FILTER(WHERE p.body->>'summary' IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_to_recordset($4::jsonb) c(scope text,version text) WHERE c.scope=p.scope AND c.version=p.body->>'summary_version')) AS summaries FROM cache_pages p LEFT JOIN resources r ON r.id::text=p.scope LEFT JOIN cache_page_states s ON s.scope=p.scope AND s.page_key=p.page_key WHERE namespace=$1 AND p.scope=ANY($2) AND expires_at>$3 AND p.access_epoch=CASE WHEN p.scope LIKE 'admin:%' THEN COALESCE((SELECT version FROM resources WHERE id::text=substr(p.scope,7) AND NOT archived),-1) ELSE COALESCE((r.body->>'cache_access_epoch')::bigint,0) END AND COALESCE(s.status,200) NOT IN (-1,401,403,410) AND p.object_epoch=COALESCE(s.epoch,0) AND (p.source IN ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002') OR EXISTS(SELECT 1 FROM resources e WHERE e.id::text=p.source AND NOT archived) AND (p.scope LIKE 'admin:%' OR EXISTS(SELECT 1 FROM resource_links l WHERE l.owner_id::text=p.scope AND l.target_id::text=p.source)))").bind(namespace).bind(&live).bind(now).bind(json!(compatible)).fetch_one(&repo.pool).await.map_err(db)?;
    let mut outcomes = serde_json::Map::new();
    for r in sqlx::query("SELECT kind,outcome,count(*) AS n FROM cache_usage WHERE ($1::text IS NULL OR scope=$1) AND at>=$2 AND at<$3 AND ($4::text IS NULL OR origin=$4) AND ($5::text IS NULL OR operation=$5) GROUP BY kind,outcome")
        .bind(scope).bind(since).bind(until).bind(origin).bind(operation).fetch_all(&repo.pool).await.map_err(db)? {
        outcomes.insert(format!("{}:{}",r.get::<String,_>("kind"),r.get::<String,_>("outcome")),json!(r.get::<i64,_>("n")));
    }
    let n = |k: &str| outcomes.get(k).and_then(Value::as_i64).unwrap_or(0);
    let hit = n("lookup:h2") + n("lookup:h1_exact") + n("lookup:h1_search");
    let total = hit + n("lookup:h0");
    let content_hit = n("content_lookup:hit");
    let content_total = content_hit + n("content_lookup:miss");
    let mut states = serde_json::Map::new();
    for r in sqlx::query("SELECT state,count(*) AS n FROM cache_jobs WHERE ($1::text IS NULL OR scope=$1) AND ($2::text IS NULL OR origin=$2) AND ($3::text IS NULL OR operation=$3) AND (state IN ('waiting','retry','running') OR finished_at>=$4 AND finished_at<$5) GROUP BY state")
        .bind(scope).bind(origin).bind(operation).bind(since).bind(until).fetch_all(&repo.pool).await.map_err(db)? {states.insert(r.get("state"),json!(r.get::<i64,_>("n")));}
    let traffic=sqlx::query("SELECT count(*) FILTER(WHERE created_at>=$2 AND created_at<$3) AS created,count(*) FILTER(WHERE state IN ('completed','not_admitted') AND finished_at>=$2 AND finished_at<$3) AS completed,count(*) FILTER(WHERE state='evicted' AND finished_at>=$2 AND finished_at<$3) AS evicted,count(*) FILTER(WHERE state='ignored' AND finished_at>=$2 AND finished_at<$3) AS ignored,COALESCE(sum(attempts) FILTER(WHERE created_at>=$2 AND created_at<$3),0)::bigint AS attempts FROM cache_jobs WHERE ($1::text IS NULL OR scope=$1) AND ($4::text IS NULL OR origin=$4) AND ($5::text IS NULL OR operation=$5)")
        .bind(scope).bind(since).bind(until).bind(origin).bind(operation).fetch_one(&repo.pool).await.map_err(db)?;
    let waiting=sqlx::query("SELECT count(*) AS waiting,COALESCE($1-min(created_at),0)::bigint AS oldest_ms,COALESCE(percentile_cont(0.95) WITHIN GROUP(ORDER BY $1-created_at),0)::bigint AS p95_ms FROM cache_jobs WHERE state IN ('waiting','retry') AND ($2::text IS NULL OR scope=$2) AND ($3::text IS NULL OR origin=$3) AND ($4::text IS NULL OR operation=$4)")
        .bind(now).bind(scope).bind(origin).bind(operation).fetch_one(&repo.pool).await.map_err(db)?;
    let (max_bytes, max_snapshots) = super::garbage::limits()?;
    let storage=sqlx::query_scalar::<_,Value>("SELECT body FROM settings WHERE name='cache-storage-status'").fetch_optional(&repo.pool).await.map_err(db)?.unwrap_or(json!({"as_of":0,"object_bytes":0,"max_object_bytes":max_bytes,"snapshots":0,"max_snapshots":max_snapshots,"write_paused":false}));
    let heat=sqlx::query("SELECT (SELECT count(*) FROM cache_registry WHERE scope=ANY($1)) AS registry,(SELECT count(*) FROM cache_hot_members WHERE scope=ANY($1) AND total_hot) AS total_hot,(SELECT count(*) FROM cache_hot_members WHERE scope=ANY($1) AND recent_hot) AS recent_hot,COALESCE((SELECT min(as_of) FROM cache_hot_boards WHERE scope=ANY($1)),0)::bigint AS as_of").bind(&live).fetch_one(&repo.pool).await.map_err(db)?;
    let elapsed = ((until.min(now) - since) as f64 / 60000.0).max(1.0);
    Ok(
        json!({"as_of":now,"since":since,"scope":scope,"inventory":{"questions":inv.get::<i64,_>("questions"),"snapshots":inv.get::<i64,_>("snapshots"),"pages":pages.get::<i64,_>("pages"),"summaries":pages.get::<i64,_>("summaries")},
        "list":{"hits":hit,"total":total,"rate":if total>0 {Some(hit as f64/total as f64)}else{None}},"content":{"hits":content_hit,"total":content_total,"rate":if content_total>0{Some(content_hit as f64/content_total as f64)}else{None}},"outcomes":outcomes,"states":states,
        "queue":{"waiting":waiting.get::<i64,_>("waiting"),"oldest_ms":waiting.get::<i64,_>("oldest_ms"),"p95_ms":waiting.get::<i64,_>("p95_ms")},
        "traffic":{"created":traffic.get::<i64,_>("created"),"completed":traffic.get::<i64,_>("completed"),"evicted":traffic.get::<i64,_>("evicted"),"ignored":traffic.get::<i64,_>("ignored"),"attempts":traffic.get::<i64,_>("attempts"),"per_minute":traffic.get::<i64,_>("completed")as f64/elapsed},"statistics":"recorded_samples","storage":storage,"hotness":{"registry":heat.get::<i64,_>("registry"),"total_hot":heat.get::<i64,_>("total_hot"),"recent_hot":heat.get::<i64,_>("recent_hot"),"as_of":heat.get::<i64,_>("as_of")}}),
    )
}
pub async fn tasks(
    repo: &Repository,
    filters: &Filters<'_>,
    state: Option<&str>,
    cursor: Option<i64>,
    limit: i64,
) -> Result<Value> {
    let rows=sqlx::query("SELECT j.*,r.body->>'name' AS project_name FROM cache_jobs j LEFT JOIN resources r ON r.id::text=j.scope WHERE ($1::text IS NULL OR scope=$1) AND ($2::text IS NULL OR state=$2) AND ($3::bigint IS NULL OR sequence<$3) AND ($5::text IS NULL OR j.origin=$5) AND ($6::text IS NULL OR j.operation=$6) AND ($7::text IS NULL OR j.kind=$7) AND (state IN ('waiting','retry','running') OR j.created_at>=$8 AND j.created_at<$9) ORDER BY sequence DESC LIMIT $4")
        .bind(filters.scope).bind(state).bind(cursor).bind(limit.clamp(1,100)+1).bind(filters.origin).bind(filters.operation).bind(filters.kind).bind(filters.since).bind(filters.until).fetch_all(&repo.pool).await.map_err(db)?;
    let more = rows.len() as i64 > limit.clamp(1, 100);
    let rows = rows
        .into_iter()
        .take(limit.clamp(1, 100) as usize)
        .collect::<Vec<_>>();
    let next = if more {
        rows.last().map(|r| r.get::<i64, _>("sequence"))
    } else {
        None
    };
    let items = rows.iter().map(task_view).collect::<Vec<_>>();
    Ok(json!({"items":items,"next_cursor":next}))
}
pub async fn task(repo: &Repository, id: &str) -> Result<Value> {
    let row=sqlx::query("SELECT j.*,r.body->>'name' AS project_name FROM cache_jobs j LEFT JOIN resources r ON r.id::text=j.scope WHERE j.id::text=$1").bind(id).fetch_optional(&repo.pool).await.map_err(db)?.ok_or_else(crate::repository::missing)?;
    Ok(task_view(&row))
}
fn task_view(row: &sqlx::postgres::PgRow) -> Value {
    let mut input: Value = row.get("input");
    if let Some(page) = input.get_mut("page").and_then(Value::as_object_mut) {
        page.remove("markdown");
    }
    json!({"id":row.get::<uuid::Uuid,_>("id"),"project":row.get::<String,_>("scope"),"project_name":row.get::<Option<String>,_>("project_name"),"kind":row.get::<String,_>("kind"),"target":row.get::<String,_>("target"),"reason":row.get::<String,_>("reason"),"state":row.get::<String,_>("state"),"parent":row.get::<String,_>("parent"),"input":input,
        "origin":row.get::<String,_>("origin"),"operation":row.get::<String,_>("operation"),"handler_version":row.get::<String,_>("handler"),"cache_namespace":row.get::<String,_>("namespace"),"activation_id":row.get::<i64,_>("activation"),"project_cache_epoch":row.get::<i64,_>("cache_epoch"),"payload_version":row.get::<i32,_>("payload_version"),"attempts":row.get::<i32,_>("attempts"),"attempt_limit":row.get::<i32,_>("attempt_limit"),"execution_request":row.get::<Option<String>,_>("execution_request"),"merged":row.get::<i32,_>("merged"),"created_at":row.get::<i64,_>("created_at"),"deadline":row.get::<i64,_>("deadline"),"available_at":row.get::<i64,_>("available_at"),"finished_at":row.get::<Option<i64>,_>("finished_at"),"last_error":row.get::<Option<String>,_>("last_error"),"phases":row.get::<Value,_>("phases")})
}

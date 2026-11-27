use crate::repository::db;
use oas_domain::{Project, Result};
use serde_json::Value;
use sqlx::{Postgres, Transaction};

pub fn project_epoch(previous: Option<&Value>, project: &Project) -> i64 {
    let Some(old) = previous else { return 0 };
    let changed = old["search_pools"] != serde_json::json!(project.search_pools)
        || old["reader_pools"] != serde_json::json!(project.reader_pools)
        || old["browser_proxy_pool_id"] != serde_json::json!(project.browser_proxy_pool_id);
    old["cache_access_epoch"].as_i64().unwrap_or(0) + i64::from(changed)
}
pub async fn changed(
    tx: &mut Transaction<'_, Postgres>,
    kind: &str,
    id: &str,
    current: &Value,
    previous: Option<&Value>,
    secret_changed: bool,
) -> Result<()> {
    let keys: &[&str] = match kind {
        "endpoints" if current["kind"] != "model" => {
            &["provider", "adapter", "base_url", "options"]
        }
        "proxies" => &["scheme", "host", "port", "auth_mode", "enabled"],
        "proxy-pools" => &["members"],
        _ => return Ok(()),
    };
    if !secret_changed
        && previous.is_some_and(|old| keys.iter().all(|key| old[*key] == current[*key]))
    {
        return Ok(());
    }
    sqlx::query("UPDATE resources p SET body=jsonb_set(p.body,'{cache_access_epoch}',to_jsonb(COALESCE((p.body->>'cache_access_epoch')::bigint,0)+1)) WHERE p.kind='projects' AND NOT p.archived AND (EXISTS(SELECT 1 FROM resource_links l WHERE l.owner_id=p.id AND l.target_id::text=$1) OR EXISTS(SELECT 1 FROM resource_links l JOIN resource_links member ON member.owner_id=l.target_id WHERE l.owner_id=p.id AND member.target_id::text=$1) OR ($2='proxies' AND (p.body->>'browser_proxy_pool_id') IS NULL))")
        .bind(id).bind(kind).execute(&mut **tx).await.map_err(db)?;
    // Only captured material is obsolete. Network goals still use the newest
    // configuration when dispatched, as required for queued refreshes.
    sqlx::query("UPDATE cache_jobs j SET state='ignored',last_error='access_scope_changed',finished_at=$1 WHERE kind IN ('index','publish_page') AND state IN ('waiting','retry') AND scope NOT LIKE 'admin:%' AND EXISTS(SELECT 1 FROM resources p WHERE p.id::text=j.scope AND COALESCE((p.body->>'cache_access_epoch')::bigint,0)<>COALESCE((j.scope_body->>'access_epoch')::bigint,0))")
        .bind(chrono::Utc::now().timestamp_millis()).execute(&mut **tx).await.map_err(db)?;
    Ok(())
}

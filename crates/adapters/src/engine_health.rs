use crate::{probes::default_version, providers::Providers};
use oas_domain::{Error, Result};
use serde_json::{Value, json};
use sqlx::Row;

fn egress(proxy: Option<&Value>) -> (&str, i64) {
    proxy.map_or(("default_network", default_version()), |p| {
        (
            p["id"].as_str().unwrap_or(""),
            p["version"].as_i64().unwrap_or(0),
        )
    })
}
impl Providers {
    pub(crate) async fn google_cooldown(&self, proxy: Option<&Value>) -> Result<Option<Value>> {
        let (id, version) = egress(proxy);
        let row=sqlx::query("SELECT failure_code,retry_at FROM browser_engine_health WHERE egress_id=$1 AND version=$2 AND retry_at>clock_timestamp()")
            .bind(id).bind(version).fetch_optional(&self.repo.pool).await.map_err(|_|Error::internal())?;
        Ok(row.map(|r| {
            json!({"reason":"google_cooldown","failure_code":r.get::<String,_>("failure_code"),
            "retry_at":r.get::<chrono::DateTime<chrono::Utc>,_>("retry_at")})
        }))
    }
    pub(crate) async fn remember_google_failure(
        &self,
        session: &Value,
        reason: &str,
    ) -> Result<()> {
        let diag = &session["diagnostics"];
        let proxy = diag["proxy_id"].as_str();
        let (id, version) = proxy.map_or(("default_network", default_version()), |id| {
            (id, diag["proxy_version"].as_i64().unwrap_or(0))
        });
        sqlx::query("INSERT INTO browser_engine_health(egress_id,version,failure_code,retry_at) SELECT $1,$2,$3,clock_timestamp()+interval '10 minutes' WHERE $1='default_network' OR EXISTS(SELECT 1 FROM resources WHERE id::text=$1 AND version=$2 AND kind='proxies' AND NOT archived AND body->>'enabled'='true') ON CONFLICT(egress_id,version) DO UPDATE SET failure_code=EXCLUDED.failure_code,retry_at=EXCLUDED.retry_at")
            .bind(id).bind(version).bind(reason).execute(&self.repo.pool).await.map_err(|_|Error::internal())?;
        Ok(())
    }
}

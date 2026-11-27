use crate::crypto::{Secrets, hash, token, verify};
use chrono::{Duration, Utc};
use oas_domain::{
    BROWSER_READER, BROWSER_SEARCH, Endpoint, Error, Project, RequestStart, Result, Snapshot, id,
    unknown_probe,
    validation::{allowed_fields, validate_project},
};
use serde_json::{Value, json};
use sqlx::{PgPool, Row, postgres::PgPoolOptions};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Clone)]
pub struct Repository {
    pub pool: PgPool,
    pub(crate) cache_accounting: PgPool,
    pub secrets: Secrets,
}
pub(crate) fn db(e: sqlx::Error) -> Error {
    tracing::error!(error=%e,"database operation failed");
    Error::internal()
}
pub fn missing() -> Error {
    Error::new(
        "NOT_FOUND",
        404,
        "记录不存在或不可访问。",
        "The record is unavailable.",
    )
}
fn conflict() -> Error {
    Error::new(
        "VERSION_CONFLICT",
        409,
        "配置版本已变化，请重载。",
        "The configuration version changed. Reload it.",
    )
}
impl Repository {
    pub async fn connect(options: sqlx::postgres::PgConnectOptions, key: &str) -> Result<Self> {
        // Best-effort hotness writes may wait on the registry. They cannot
        // occupy the connections used to authorize requests or serve snapshots.
        let cache_accounting = PgPoolOptions::new()
            .max_connections(3)
            .connect_lazy_with(options.clone());
        let pool = PgPoolOptions::new()
            .max_connections(20)
            .connect_with(options)
            .await
            .map_err(db)?;
        Ok(Self {
            pool,
            cache_accounting,
            secrets: Secrets::new(key)?,
        })
    }
    pub async fn close(&self) {
        tokio::join!(self.pool.close(), self.cache_accounting.close());
    }
    pub async fn migrate(&self) -> Result<()> {
        sqlx::migrate!("./migrations")
            .run(&self.pool)
            .await
            .map_err(|e| {
                tracing::error!(error=%e,"migration failed");
                Error::internal()
            })
    }
    pub async fn bootstrap(&self, username: &str, pass: &str) -> Result<()> {
        oas_domain::administrator::validate(username, pass)?;
        let days = std::env::var("OAS_RETENTION_DAYS")
            .unwrap_or_else(|_| "7".into())
            .parse::<u32>()
            .map_err(|_| Error::invalid("OAS_RETENTION_DAYS"))?;
        if !(1..=36500).contains(&days) {
            return Err(Error::invalid("OAS_RETENTION_DAYS"));
        }
        self.initialize_administrator(username, pass).await?;
        for (name, body) in [
            ("retention", json!({"retention_days":days})),
            ("language-routes", json!({"entries":[]})),
        ] {
            sqlx::query("INSERT INTO settings VALUES($1,1,$2) ON CONFLICT DO NOTHING")
                .bind(name)
                .bind(body)
                .execute(&self.pool)
                .await
                .map_err(db)?;
        }
        let previous = sqlx::query_scalar::<_, i64>(
            "SELECT version FROM probes WHERE egress_id='default_network'",
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(db)?;
        if previous.is_some_and(|version| version > crate::probes::default_version()) {
            return Err(Error::invalid("OAS_DEFAULT_NETWORK_VERSION"));
        }
        for (eid, name, kind, adapter) in [
            (BROWSER_SEARCH, "内置浏览器搜索", "search", "browser_search"),
            (BROWSER_READER, "内置浏览器正文", "reader", "browser_reader"),
        ] {
            let opts = json!({});
            let value = json!({"id":eid,"name":name,"kind":kind,"provider":"browser","adapter":adapter,"base_url":null,
                "timeout_ms":if kind=="search"{14000}else{12000},"max_concurrency":24,"rpm":600,"options":opts,"version":1,
                "managed_by":"system","availability":"no_ready_pods","has_secret":false,"last_test":null,"ready_pods":0});
            sqlx::query("INSERT INTO resources(id,kind,body) VALUES($1,'endpoints',$2) ON CONFLICT DO NOTHING").bind(Uuid::parse_str(eid).unwrap()).bind(value).execute(&self.pool).await.map_err(db)?;
        }
        for (provider, kind, adapter, eid, port) in [
            (
                "searxng",
                "search",
                "http_search",
                "00000000-0000-4000-8000-000000000003",
                8080,
            ),
            (
                "crawl4ai",
                "reader",
                "http_reader",
                "00000000-0000-4000-8000-000000000004",
                11235,
            ),
        ] {
            let prefix = provider.to_ascii_uppercase();
            let enabled = std::env::var(format!("OAS_{prefix}_ENABLED")).is_ok_and(|v| v == "true");
            let base = std::env::var(format!("OAS_{prefix}_URL"))
                .unwrap_or_else(|_| format!("http://{provider}:{port}"));
            let secret = std::env::var(format!("OAS_{prefix}_KEY"))
                .ok()
                .map(|key| self.secrets.encrypt(&json!({"api_key":key})))
                .transpose()?;
            let options = if kind == "search" {
                json!({"engines":[]})
            } else {
                json!({"format":"markdown"})
            };
            let body = json!({"id":eid,"name":provider,"kind":kind,"provider":provider,"adapter":adapter,"base_url":base,"timeout_ms":12000,"max_concurrency":4,"rpm":120,
                "options":options,"version":1,"managed_by":"helm","availability":if enabled{"component_unready"}else{"component_disabled"},"has_secret":secret.is_some(),"last_test":null});
            sqlx::query("INSERT INTO resources(id,kind,body,secret) VALUES($1,'endpoints',$2,$3) ON CONFLICT(id) DO UPDATE SET version=resources.version+1,body=(resources.body||$2)||jsonb_build_object('version',resources.version+1,'has_secret',COALESCE($3,resources.secret) IS NOT NULL),secret=COALESCE($3,resources.secret)")
                .bind(Uuid::parse_str(eid).unwrap()).bind(body).bind(secret).execute(&self.pool).await.map_err(db)?;
        }
        Ok(())
    }
    pub async fn setting(&self, name: &str) -> Result<Value> {
        let row = sqlx::query("SELECT version,body FROM settings WHERE name=$1")
            .bind(name)
            .fetch_one(&self.pool)
            .await
            .map_err(db)?;
        let mut body: Value = row.get("body");
        body["version"] = json!(row.get::<i64, _>("version"));
        Ok(body)
    }
    pub async fn update_setting(&self, name: &str, mut body: Value) -> Result<Value> {
        let version = body["expected_version"]
            .as_i64()
            .ok_or_else(|| Error::invalid("expected_version"))?;
        let mut tx = self.pool.begin().await.map_err(db)?;
        if name == "retention" {
            allowed_fields(&body, &["retention_days", "expected_version"])?;
            if !body["retention_days"]
                .as_u64()
                .is_some_and(|n| (1..=36500).contains(&n))
            {
                return Err(Error::invalid("retention_days"));
            }
        } else {
            sqlx::query("SELECT pg_advisory_xact_lock(77183001)")
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            allowed_fields(&body, &["entries", "expected_version"])?;
            let entries = body["entries"]
                .as_array_mut()
                .ok_or_else(|| Error::invalid("entries"))?;
            let endpoints=sqlx::query_scalar::<_,Uuid>("SELECT id FROM resources WHERE kind='endpoints' AND NOT archived AND body->>'kind'='search'").fetch_all(&mut *tx).await.map_err(db)?.into_iter().map(|id|id.to_string()).collect::<std::collections::HashSet<_>>();
            let mut languages = std::collections::HashSet::new();
            for entry in entries {
                allowed_fields(entry, &["language", "endpoint_ids"])?;
                let language = entry["language"]
                    .as_str()
                    .filter(|l| !l.is_empty())
                    .ok_or_else(|| Error::invalid("language"))?;
                let language = oas_domain::validation::language_tag(language)?;
                entry["language"] = json!(language);
                if !languages.insert(language) {
                    return Err(Error::invalid("entries"));
                }
                let members = entry["endpoint_ids"]
                    .as_array()
                    .filter(|v| !v.is_empty())
                    .ok_or_else(|| Error::invalid("endpoint_ids"))?;
                let mut seen = std::collections::HashSet::new();
                for member in members {
                    let id = member
                        .as_str()
                        .filter(|id| endpoints.contains(*id))
                        .ok_or_else(|| Error::invalid("endpoint_ids"))?;
                    if !seen.insert(id) {
                        return Err(Error::invalid("endpoint_ids"));
                    }
                }
            }
        }
        body.as_object_mut().unwrap().remove("expected_version");
        let row=sqlx::query("UPDATE settings SET version=version+1,body=$3 WHERE name=$1 AND version=$2 RETURNING version").bind(name).bind(version).bind(&body).fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(conflict)?;
        body["version"] = json!(row.get::<i64, _>("version"));
        tx.commit().await.map_err(db)?;
        Ok(body)
    }
    pub async fn login(&self, username: &str, pass: &str) -> Result<(String, Value)> {
        let encoded = sqlx::query_scalar::<_, String>(
            "SELECT password_hash FROM administrators WHERE username=$1",
        )
        .bind(username)
        .fetch_optional(&self.pool)
        .await
        .map_err(db)?;
        let pass = pass.to_owned();
        let verified = tokio::task::spawn_blocking(move || encoded.filter(|s| verify(&pass, s)))
            .await
            .map_err(|_| Error::internal())?;
        let Some(encoded) = verified else {
            return Err(Error::new(
                "UNAUTHORIZED",
                401,
                "账号或口令错误。",
                "Invalid username or password.",
            ));
        };
        let raw = token();
        let csrf = token();
        let expires = Utc::now() + Duration::hours(12);
        let mut tx = self.pool.begin().await.map_err(db)?;
        let current = sqlx::query_scalar::<_, String>(
            "SELECT password_hash FROM administrators WHERE username=$1 FOR UPDATE",
        )
        .bind(username)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
        if current.as_deref() != Some(encoded.as_str()) {
            return Err(Error::new(
                "UNAUTHORIZED",
                401,
                "账号或口令错误。",
                "Invalid username or password.",
            ));
        }
        sqlx::query("INSERT INTO sessions VALUES($1,$2,$3,$4)")
            .bind(hash(&raw))
            .bind(username)
            .bind(&csrf)
            .bind(expires)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok((
            raw,
            json!({"username":username,"csrf_token":csrf,"expires_at":expires,"supported_languages":["zh","en"]}),
        ))
    }
    pub async fn session(&self, raw: &str) -> Result<Value> {
        let row=sqlx::query("SELECT username,csrf,expires_at FROM sessions WHERE token_hash=$1 AND expires_at>now()").bind(hash(raw)).fetch_optional(&self.pool).await.map_err(db)?.ok_or_else(||Error::new("UNAUTHORIZED",401,"请重新登录。","Please sign in."))?;
        Ok(
            json!({"username":row.get::<String,_>("username"),"csrf_token":row.get::<String,_>("csrf"),"expires_at":row.get::<chrono::DateTime<Utc>,_>("expires_at"),"supported_languages":["zh","en"]}),
        )
    }
    pub async fn logout(&self, raw: &str) -> Result<()> {
        sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
            .bind(hash(raw))
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(())
    }
    pub async fn resources(&self, kind: &str) -> Result<Vec<Value>> {
        let rows = sqlx::query(
            "SELECT body FROM resources WHERE kind=$1 AND NOT archived ORDER BY created_at,id",
        )
        .bind(kind)
        .fetch_all(&self.pool)
        .await
        .map_err(db)?;
        Ok(rows.iter().map(|r| r.get("body")).collect())
    }
    pub async fn resource(&self, kind: &str, eid: &str) -> Result<Value> {
        let eid = Uuid::parse_str(eid).map_err(|_| missing())?;
        sqlx::query_scalar("SELECT body FROM resources WHERE id=$1 AND kind=$2 AND NOT archived")
            .bind(eid)
            .bind(kind)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?
            .ok_or_else(missing)
    }
    pub async fn test_snapshot(&self, kind: &str, id: &str) -> Result<(Value, Option<Value>)> {
        let row = sqlx::query(
            "SELECT body,secret FROM resources WHERE id=$1 AND kind=$2 AND NOT archived",
        )
        .bind(Uuid::parse_str(id).map_err(|_| missing())?)
        .bind(kind)
        .fetch_optional(&self.pool)
        .await
        .map_err(db)?
        .ok_or_else(missing)?;
        let secret = row
            .get::<Option<Vec<u8>>, _>("secret")
            .map(|bytes| self.secrets.decrypt(&bytes))
            .transpose()?;
        Ok((row.get("body"), secret))
    }
    pub async fn save(&self, kind: &str, eid: Option<&str>, mut input: Value) -> Result<Value> {
        if input["name"].as_str().is_none_or(|s| s.trim().is_empty()) {
            return Err(Error::invalid("name"));
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        sqlx::query("SELECT pg_advisory_xact_lock(77183001)")
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let key = eid.map(str::to_owned).unwrap_or_else(id);
        let uuid = Uuid::parse_str(&key).map_err(|_| Error::invalid("id"))?;
        let old=sqlx::query("SELECT version,body,secret FROM resources WHERE id=$1 AND kind=$2 AND NOT archived FOR UPDATE").bind(uuid).bind(kind).fetch_optional(&mut *tx).await.map_err(db)?;
        if eid.is_some() && old.is_none() {
            return Err(missing());
        }
        let version = old.as_ref().map_or(1, |r| r.get::<i64, _>("version") + 1);
        if let Some(old) = &old {
            if input["expected_version"].as_i64() != Some(old.get("version")) {
                return Err(conflict());
            }
            if ["system", "helm"].contains(
                &old.get::<Value, _>("body")["managed_by"]
                    .as_str()
                    .unwrap_or(""),
            ) {
                return Err(Error::new(
                    "RESOURCE_PROTECTED",
                    409,
                    "系统能力由部署管理。",
                    "System capabilities are managed by the deployment.",
                ));
            }
        }
        if eid.is_none() && input.get("expected_version").is_some() {
            return Err(Error::invalid("expected_version"));
        }
        if let Some(action) = input.get("secret_action") {
            if !["keep", "replace", "clear"].contains(&action.as_str().unwrap_or("")) {
                return Err(Error::invalid("secret_action"));
            }
            if action != "replace" && input.get("secret").is_some() {
                return Err(Error::invalid("secret"));
            }
        }
        if let Some(value) = input.get("secret") {
            let fields = if kind == "proxies" {
                vec!["username", "password"]
            } else {
                vec!["api_key"]
            };
            allowed_fields(value, &fields)?;
            for field in fields {
                if value[field].as_str().is_none_or(|v| {
                    v.trim().is_empty() || v.len() > 4096 || v.contains(['\r', '\n'])
                }) {
                    return Err(Error::invalid("secret"));
                }
            }
            if kind == "proxies" && value["username"].as_str().unwrap().len() > 255 {
                return Err(Error::invalid("secret"));
            }
        }
        let mut secret = old
            .as_ref()
            .and_then(|r| r.get::<Option<Vec<u8>>, _>("secret"));
        match input["secret_action"]
            .as_str()
            .unwrap_or(if input.get("secret").is_some() {
                "replace"
            } else {
                "keep"
            }) {
            "replace" => {
                let value = input
                    .get("secret")
                    .filter(|s| s.is_object())
                    .ok_or_else(|| Error::invalid("secret"))?;
                secret = Some(self.secrets.encrypt(value)?);
            }
            "clear" => secret = None,
            "keep" => {}
            _ => return Err(Error::invalid("secret_action")),
        }
        let mut refs = Vec::<(Uuid, String)>::new();
        match kind {
            "projects" => {
                allowed_fields(
                    &input,
                    &[
                        "name",
                        "search_pools",
                        "reader_pools",
                        "model_endpoint_id",
                        "browser_proxy_pool_id",
                        "search_limit",
                        "source_limit",
                        "body_limit",
                        "summary_limit",
                        "rewrite_count",
                        "search_original_query",
                        "summary_snippets_only",
                        "allow_snippets",
                        "cache_enabled",
                        "cache_policy",
                        "expected_version",
                    ],
                )?;
                input.as_object_mut().unwrap().remove("expected_version");
                let mut p: Project =
                    serde_json::from_value(input.clone()).map_err(|_| Error::invalid("body"))?;
                validate_project(&p)?;
                p.id = key.clone();
                p.version = version;
                let previous = old.as_ref().map(|r| r.get::<Value, _>("body"));
                p.cache_access_epoch = crate::cache::access::project_epoch(previous.as_ref(), &p);
                p.cache_epoch = previous
                    .as_ref()
                    .and_then(|v| v["cache_epoch"].as_i64())
                    .unwrap_or(0)
                    + i64::from(previous.as_ref().is_some_and(|v| {
                        v["cache_enabled"].as_bool().unwrap_or(false) != p.cache_enabled
                    }));
                if let Some(policy) = &mut p.cache_policy {
                    policy.validate()?;
                }
                if !p.cache_enabled {
                    sqlx::query("UPDATE cache_jobs SET state='ignored',last_error='cache_disabled',finished_at=$2 WHERE scope=$1 AND state IN ('waiting','retry')")
                        .bind(&p.id).bind(Utc::now().timestamp_millis()).execute(&mut *tx).await.map_err(db)?;
                }
                input = serde_json::to_value(&p).unwrap();
                for (role, pools) in [("search", &p.search_pools), ("reader", &p.reader_pools)] {
                    for id in pools.iter().flatten() {
                        let target=sqlx::query_scalar::<_,Value>("SELECT body FROM resources WHERE id=$1 AND kind='endpoints' AND NOT archived").bind(Uuid::parse_str(id).unwrap()).fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(||Error::invalid(role))?;
                        if target["kind"] != role {
                            return Err(Error::invalid(role));
                        }
                        refs.push((Uuid::parse_str(id).unwrap(), role.into()));
                    }
                }
                for (role, id, target_kind) in [
                    ("model", p.model_endpoint_id, "endpoints"),
                    ("pool", p.browser_proxy_pool_id, "proxy-pools"),
                ] {
                    if let Some(id) = id {
                        let target_id = Uuid::parse_str(&id).map_err(|_| Error::invalid(role))?;
                        let target = sqlx::query_scalar::<_, Value>(
                            "SELECT body FROM resources WHERE id=$1 AND kind=$2 AND NOT archived",
                        )
                        .bind(target_id)
                        .bind(target_kind)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(db)?
                        .ok_or_else(|| Error::invalid(role))?;
                        if role == "model" && target["kind"] != "model" {
                            return Err(Error::invalid(role));
                        }
                        refs.push((target_id, role.into()));
                    }
                }
            }
            "endpoints" => {
                validate_endpoint(&input, old.as_ref().map(|r| r.get::<Value, _>("body")))?
            }
            "proxies" => {
                allowed_fields(
                    &input,
                    &[
                        "name",
                        "scheme",
                        "host",
                        "port",
                        "auth_mode",
                        "max_concurrency",
                        "enabled",
                        "secret",
                        "secret_action",
                        "expected_version",
                    ],
                )?;
                if !["https", "socks5"].contains(&input["scheme"].as_str().unwrap_or(""))
                    || input["host"].as_str().is_none_or(|h| {
                        h.is_empty()
                            || h.chars().any(|c| {
                                c.is_whitespace()
                                    || c.is_control()
                                    || ['/', '@', '\"', '\\'].contains(&c)
                            })
                    })
                {
                    return Err(Error::invalid("host"));
                }
                if !input["port"].as_u64().is_some_and(|n| n > 0 && n < 65536)
                    || !input["max_concurrency"].as_u64().is_some_and(|n| n > 0)
                    || !input["enabled"].is_boolean()
                {
                    return Err(Error::invalid("capacity"));
                }
                if !["none", "password"].contains(&input["auth_mode"].as_str().unwrap_or("")) {
                    return Err(Error::invalid("auth_mode"));
                }
                if input["auth_mode"] == "password" && secret.is_none() {
                    return Err(Error::invalid("secret"));
                }
                if input["auth_mode"] == "none" {
                    secret = None;
                }
                input["health"] = json!("unknown");
                input["active_leases"] = json!(0);
                input["google_probe"] = unknown_probe();
            }
            "proxy-pools" => {
                allowed_fields(&input, &["name", "members", "expected_version"])?;
                let members = input["members"]
                    .as_array()
                    .ok_or_else(|| Error::invalid("members"))?;
                if members.len() > 100 {
                    return Err(Error::invalid("members"));
                }
                let mut seen = std::collections::HashSet::new();
                for m in members {
                    allowed_fields(m, &["proxy_id", "weight"])?;
                    let id = Uuid::parse_str(m["proxy_id"].as_str().unwrap_or(""))
                        .map_err(|_| Error::invalid("members"))?;
                    if !seen.insert(id) || !m["weight"].as_u64().is_some_and(|n| n > 0 && n <= 100)
                    {
                        return Err(Error::invalid("members"));
                    }
                    let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM resources WHERE id=$1 AND kind='proxies' AND NOT archived)").bind(id).fetch_one(&mut *tx).await.map_err(db)?;
                    if !exists {
                        return Err(Error::invalid("members"));
                    }
                    refs.push((id, "proxy".into()));
                }
            }
            _ => return Err(missing()),
        }
        for field in ["expected_version", "secret", "secret_action"] {
            input.as_object_mut().unwrap().remove(field);
        }
        input["id"] = json!(key);
        input["version"] = json!(version);
        if kind == "endpoints" || kind == "proxies" {
            input["has_secret"] = json!(secret.is_some());
            input["last_test"] = Value::Null;
        }
        if kind == "endpoints" {
            input["managed_by"] = json!("administrator");
            input["availability"] = json!("available");
        }
        let secret_changed = old
            .as_ref()
            .and_then(|r| r.get::<Option<Vec<u8>>, _>("secret"))
            != secret;
        sqlx::query("INSERT INTO resources(id,kind,version,body,secret) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET version=$3,body=$4,secret=$5,updated_at=now()").bind(uuid).bind(kind).bind(version).bind(&input).bind(secret).execute(&mut *tx).await.map_err(db)?;
        crate::cache::access::changed(
            &mut tx,
            kind,
            &key,
            &input,
            old.as_ref().map(|r| r.get::<Value, _>("body")).as_ref(),
            secret_changed,
        )
        .await?;
        sqlx::query("DELETE FROM resource_links WHERE owner_id=$1")
            .bind(uuid)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        for (target, role) in refs {
            sqlx::query("INSERT INTO resource_links VALUES($1,$2,$3)")
                .bind(uuid)
                .bind(target)
                .bind(role)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        let mut output = input.clone();
        if kind == "projects" && eid.is_none() {
            let raw = format!("oas_{}", token());
            sqlx::query("INSERT INTO project_keys VALUES($1,$2,$3)")
                .bind(uuid)
                .bind(hash(&raw))
                .bind(&raw[..12])
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            output = json!({"project":input,"api_key":raw});
        }
        tx.commit().await.map_err(db)?;
        Ok(output)
    }
    pub async fn rotate(&self, id: &str, version: i64) -> Result<Value> {
        let id = Uuid::parse_str(id).map_err(|_| missing())?;
        let mut tx = self.pool.begin().await.map_err(db)?;
        let row=sqlx::query("UPDATE resources SET version=version+1,body=jsonb_set(body,'{version}',to_jsonb(version+1)) WHERE id=$1 AND kind='projects' AND version=$2 RETURNING version").bind(id).bind(version).fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(conflict)?;
        let raw = format!("oas_{}", token());
        sqlx::query("UPDATE project_keys SET key_hash=$2,prefix=$3 WHERE project_id=$1")
            .bind(id)
            .bind(hash(&raw))
            .bind(&raw[..12])
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(json!({"api_key":raw,"version":row.get::<i64,_>("version")}))
    }
    pub async fn archive(&self, kind: &str, id: &str, version: i64) -> Result<Value> {
        let uuid = Uuid::parse_str(id).map_err(|_| missing())?;
        let mut tx = self.pool.begin().await.map_err(db)?;
        sqlx::query("SELECT pg_advisory_xact_lock(77183001)")
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let body = sqlx::query_scalar::<_, Value>(
            "SELECT body FROM resources WHERE id=$1 AND kind=$2 AND NOT archived FOR UPDATE",
        )
        .bind(uuid)
        .bind(kind)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        .ok_or_else(missing)?;
        if body["version"].as_i64() != Some(version) {
            return Err(conflict());
        }
        if ["system", "helm"].contains(&body["managed_by"].as_str().unwrap_or("")) {
            return Err(Error::new(
                "RESOURCE_PROTECTED",
                409,
                "系统能力由部署管理。",
                "System capabilities are protected.",
            ));
        }
        let rows=sqlx::query_scalar::<_,Value>("SELECT r.body FROM resource_links l JOIN resources r ON r.id=l.owner_id WHERE l.target_id=$1 AND NOT r.archived").bind(uuid).fetch_all(&mut *tx).await.map_err(db)?;
        let routes = self.setting("language-routes").await?;
        if !rows.is_empty()
            || routes["entries"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|route| {
                    route["endpoint_ids"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|member| member == id)
                })
        {
            let mut e = Error::new(
                "RESOURCE_IN_USE",
                409,
                "资源仍被引用。",
                "The resource is still referenced.",
            );
            e.details = Box::new(json!({"references":rows}));
            return Err(e);
        }
        sqlx::query("UPDATE resources SET archived=true,version=version+1 WHERE id=$1")
            .bind(uuid)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(json!({"id":id}))
    }
    pub async fn prepare(
        &self,
        mut start: RequestStart,
        key: Option<&str>,
    ) -> Result<(Snapshot, RequestStart)> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let project = if let Some(key) = key {
            sqlx::query_scalar::<_,Uuid>("SELECT k.project_id FROM project_keys k JOIN resources r ON r.id=k.project_id WHERE k.key_hash=$1 AND NOT r.archived")
                .bind(hash(key)).fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(||Error::new("UNAUTHORIZED",401,"项目密钥无效。","Invalid project key."))?
        } else {
            Uuid::parse_str(start.project.as_deref().unwrap_or("")).map_err(|_| missing())?
        };
        let mut snapshot = self.load_snapshot(&mut tx, project).await?;
        if let Some(key) = key {
            snapshot
                .secrets
                .insert("project-auth".into(), json!({"api_key":key}));
        }
        start.project = Some(project.to_string());
        start.retention_days = snapshot.retention_days;
        start.retention_version = snapshot.retention_version;
        oas_domain::privacy::redact(
            &mut start.input,
            &oas_domain::privacy::secrets(&snapshot.secrets),
        );
        start.snapshot = snapshot.recording();
        insert_start(&mut tx, &start).await?;
        tx.commit().await.map_err(db)?;
        Ok((snapshot, start))
    }
    pub async fn load_snapshot(
        &self,
        connection: &mut sqlx::PgConnection,
        project: Uuid,
    ) -> Result<Snapshot> {
        let body = sqlx::query_scalar::<_, Value>(
            "SELECT body FROM resources WHERE id=$1 AND kind='projects' AND NOT archived",
        )
        .bind(project)
        .fetch_optional(&mut *connection)
        .await
        .map_err(db)?
        .ok_or_else(missing)?;
        let project: Project = serde_json::from_value(body).map_err(|_| Error::internal())?;
        let mut ids = project
            .search_pools
            .iter()
            .chain(&project.reader_pools)
            .flatten()
            .filter_map(|id| Uuid::parse_str(id).ok())
            .collect::<std::collections::HashSet<_>>();
        if let Some(model) = &project.model_endpoint_id {
            ids.insert(Uuid::parse_str(model).map_err(|_| Error::internal())?);
        }
        let mut pools = Vec::new();
        if let Some(pool) = &project.browser_proxy_pool_id {
            let pool = sqlx::query_scalar::<_, Value>(
                "SELECT body FROM resources WHERE id=$1 AND kind='proxy-pools' AND NOT archived",
            )
            .bind(Uuid::parse_str(pool).map_err(|_| Error::internal())?)
            .fetch_optional(&mut *connection)
            .await
            .map_err(db)?
            .ok_or_else(Error::unavailable)?;
            for member in pool["members"].as_array().into_iter().flatten() {
                ids.insert(
                    Uuid::parse_str(member["proxy_id"].as_str().unwrap_or(""))
                        .map_err(|_| Error::internal())?,
                );
            }
            pools.push(pool);
        }
        let rows = sqlx::query(
            "SELECT id,kind,body,secret FROM resources WHERE (id=ANY($1) OR ($2 AND kind='proxies' AND body->>'enabled'='true')) AND NOT archived",
        )
        .bind(ids.into_iter().collect::<Vec<_>>())
        .bind(project.browser_proxy_pool_id.is_none())
        .fetch_all(&mut *connection)
        .await
        .map_err(db)?;
        let mut endpoints = Vec::new();
        let mut proxies = Vec::new();
        let mut secrets = HashMap::new();
        for row in rows {
            let value: Value = row.get("body");
            match row.get::<String, _>("kind").as_str() {
                "endpoints" => endpoints.push(
                    serde_json::from_value::<Endpoint>(value).map_err(|_| Error::internal())?,
                ),
                "proxies" => proxies.push(value),
                _ => continue,
            }
            if let Some(secret) = row.get::<Option<Vec<u8>>, _>("secret") {
                secrets.insert(
                    row.get::<Uuid, _>("id").to_string(),
                    self.secrets.decrypt(&secret)?,
                );
            }
        }
        let mut settings = HashMap::new();
        for row in sqlx::query("SELECT name,version,body FROM settings")
            .fetch_all(&mut *connection)
            .await
            .map_err(db)?
        {
            let mut value: Value = row.get("body");
            value["version"] = json!(row.get::<i64, _>("version"));
            settings.insert(row.get::<String, _>("name"), value);
        }
        let mut egress_ids = proxies
            .iter()
            .filter_map(|p| p["id"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        egress_ids.push("default_network".into());
        let probes =
            sqlx::query("SELECT egress_id,version,body-'_next_due_at' AS body FROM probes WHERE egress_id=ANY($1)")
                .bind(egress_ids)
                .fetch_all(&mut *connection)
                .await
                .map_err(db)?
                .into_iter()
                .filter(|row| {
                    (row.get::<String, _>("egress_id") == "default_network"
                        && row.get::<i64, _>("version") == crate::probes::default_version())
                        || proxies.iter().any(|p| {
                            p["id"] == row.get::<String, _>("egress_id")
                                && p["version"].as_i64() == Some(row.get::<i64, _>("version"))
                        })
                })
                .map(|row| (row.get("egress_id"), row.get("body")))
                .collect();
        Ok(Snapshot {
            project,
            endpoints,
            proxies,
            pools,
            secrets,
            probes,
            routes: settings["language-routes"].clone(),
            retention_days: settings["retention"]["retention_days"]
                .as_i64()
                .unwrap_or(7) as i32,
            retention_version: settings["retention"]["version"].as_i64().unwrap_or(1),
        })
    }
    pub async fn proxy_state(&self, id: &str, version: i64, state: &Value) -> Result<()> {
        sqlx::query("UPDATE resources SET body=body||$3 WHERE id=$1 AND version=$2 AND kind='proxies' AND NOT archived AND COALESCE((body->>'health_revision')::bigint,0)<$4")
            .bind(Uuid::parse_str(id).map_err(|_|missing())?).bind(version).bind(state).bind(state["health_revision"].as_i64().unwrap_or(0)).execute(&self.pool).await.map_err(db)?;
        Ok(())
    }
    pub async fn risk(&self, id: &str, until: i64) -> Result<()> {
        sqlx::query("INSERT INTO endpoint_risk_cooldowns VALUES($1,$2) ON CONFLICT(endpoint_id) DO UPDATE SET blocked_until=GREATEST(endpoint_risk_cooldowns.blocked_until,$2)").bind(Uuid::parse_str(id).map_err(|_|Error::internal())?).bind(chrono::DateTime::from_timestamp_millis(until).unwrap()).execute(&self.pool).await.map_err(db)?;
        Ok(())
    }
    pub async fn start(&self, r: &RequestStart) -> Result<RequestStart> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let row = sqlx::query("SELECT version,body FROM settings WHERE name='retention' FOR SHARE")
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        let mut start = r.clone();
        start.retention_version = row.get("version");
        start.retention_days = row.get::<Value, _>("body")["retention_days"]
            .as_i64()
            .unwrap_or(7) as i32;
        insert_start(&mut tx, &start).await?;
        tx.commit().await.map_err(db)?;
        Ok(start)
    }
}

fn validate_endpoint(v: &Value, old: Option<Value>) -> Result<()> {
    allowed_fields(
        v,
        &[
            "name",
            "kind",
            "provider",
            "adapter",
            "base_url",
            "timeout_ms",
            "max_concurrency",
            "rpm",
            "options",
            "secret",
            "secret_action",
            "expected_version",
        ],
    )?;
    let provider = v["provider"].as_str().unwrap_or("");
    let kind = v["kind"].as_str().unwrap_or("");
    let adapter = v["adapter"].as_str().unwrap_or("");
    let valid = match (kind, provider) {
        ("search", "tavily" | "anysearch" | "deepseek") => {
            ["http_search", "integrated_search"].contains(&adapter)
        }
        ("search", "searxng") => adapter == "http_search",
        ("reader", "tavily" | "anysearch" | "deepseek" | "crawl4ai") => adapter == "http_reader",
        ("model", "openai_compatible") => adapter == "chat_model",
        _ => false,
    };
    if !valid {
        return Err(Error::invalid("provider"));
    }
    if let Some(old) = old
        && (old["kind"] != v["kind"]
            || old["provider"] != v["provider"]
            || old["adapter"] != v["adapter"])
    {
        return Err(Error::invalid("provider"));
    }
    let u = url::Url::parse(v["base_url"].as_str().unwrap_or(""))
        .map_err(|_| Error::invalid("base_url"))?;
    if !matches!(u.scheme(), "https" | "http") || !u.username().is_empty() || u.password().is_some()
    {
        return Err(Error::invalid("base_url"));
    }
    for f in ["timeout_ms", "max_concurrency", "rpm"] {
        if !v[f].as_u64().is_some_and(|n| n > 0) {
            return Err(Error::invalid(f));
        }
    }
    if !v["options"].is_object() {
        return Err(Error::invalid("options"));
    }
    if kind == "search" {
        allowed_fields(&v["options"], &["engines"])?;
        if provider != "searxng" && v["options"].get("engines").is_some() {
            return Err(Error::invalid("options.engines"));
        }
    }
    if kind == "model" {
        allowed_fields(
            &v["options"],
            &[
                "model",
                "tokenizer",
                "max_input_tokens",
                "max_output_tokens",
                "context_window_tokens",
                "reasoning_effort",
            ],
        )?;
        for f in ["model", "tokenizer"] {
            if v["options"][f].as_str().is_none_or(|v| v.trim().is_empty()) {
                return Err(Error::invalid(f));
            }
        }
        oas_domain::tokens::count(
            v["options"]["tokenizer"].as_str().unwrap_or(""),
            "validation",
        )?;
        if let Some(effort) = v["options"].get("reasoning_effort")
            && !matches!(
                effort.as_str(),
                Some("none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")
            )
        {
            return Err(Error::invalid("options.reasoning_effort"));
        }
        if let Some(window) = v["options"].get("context_window_tokens")
            && window
                .as_u64()
                .is_none_or(|n| n <= v["options"]["max_output_tokens"].as_u64().unwrap_or(0))
        {
            return Err(Error::invalid("options.context_window_tokens"));
        }
        for f in ["max_input_tokens", "max_output_tokens"] {
            if !v["options"][f].as_u64().is_some_and(|n| n > 0) {
                return Err(Error::invalid(f));
            }
        }
    }
    if kind == "reader" {
        allowed_fields(&v["options"], &["format"])?;
        if v["options"]
            .get("format")
            .is_some_and(|f| !matches!(f.as_str(), Some("html" | "markdown")))
        {
            return Err(Error::invalid("options.format"));
        }
    }

    Ok(())
}

async fn insert_start(connection: &mut sqlx::PgConnection, r: &RequestStart) -> Result<()> {
    let record = json!({"request_id":r.id,"project_id":r.project,"operation":r.operation,"status":"running","started_at":r.started_at,"duration_ms":0,"upstream_calls":0,"model_calls":0,"incomplete":false,
        "origin":r.origin,"language":r.language,"project_name":r.snapshot["project"]["name"],"query_preview":r.input["query"].as_str().or(r.input["url"].as_str()),"response_preview":null,
        "retention_days":r.retention_days,"retention_version":r.retention_version,"expires_at":r.started_at+Duration::days(r.retention_days as i64)});
    let written=sqlx::query("INSERT INTO requests(id,project_id,operation,origin,started_at,expires_at,record,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING")
        .bind(Uuid::parse_str(&r.id).map_err(|_|Error::invalid("request_id"))?)
        .bind(r.project.as_ref().and_then(|s|Uuid::parse_str(s).ok())).bind(&r.operation).bind(&r.origin).bind(r.started_at).bind(r.started_at+Duration::days(r.retention_days as i64))
        .bind(record).bind(json!({"snapshot":r.snapshot,"request_payload":r.input})).execute(connection).await.map_err(db)?;
    if written.rows_affected() == 0 {
        return Err(Error::new(
            "REQUEST_CONFLICT",
            409,
            "请求标识已被使用。",
            "The request ID is already in use.",
        ));
    }
    Ok(())
}

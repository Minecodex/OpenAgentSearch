use crate::{
    crypto::hash,
    repository::{Repository, missing},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use oas_domain::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder, Row};
use std::collections::{BTreeMap, HashMap};
use uuid::Uuid;
pub(crate) const FILTERS: [(&str, &str); 10] = [
    ("project_id", "project_id"),
    ("operation", "operation"),
    ("origin", "origin"),
    ("status", "status"),
    ("kind", "kind"),
    ("endpoint_id", "endpoint_id"),
    ("language", "language"),
    ("reason", "reason"),
    ("request_id", "request_id"),
    ("evaluation", "evaluation"),
];
#[derive(Serialize, Deserialize)]
struct Cursor {
    id: Uuid,
    at: DateTime<Utc>,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    scope: String,
}
pub(crate) fn filters(
    builder: &mut QueryBuilder<'_, Postgres>,
    field: &str,
    q: &HashMap<String, String>,
) {
    for (name, key) in FILTERS {
        if let Some(value) = q.get(name).filter(|v| !v.is_empty()) {
            builder
                .push(format!(" AND {field}->>'{key}'="))
                .push_bind(value.clone());
        }
    }
    if let Some(text) = q.get("q").filter(|s| !s.is_empty()) {
        let text = text
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        builder.push(format!(" AND concat_ws(' ',{field}->>'query_preview',{field}->>'input_preview',{field}->>'request_id') ILIKE ")).push_bind(format!("%{text}%"));
    }
}
impl Repository {
    pub async fn records_page(&self, table: &str, q: &HashMap<String, String>) -> Result<Value> {
        let (time, field) = match table {
            "requests" => ("started_at", "record"),
            "endpoint_calls" => ("finished_at", "body"),
            _ => return Err(missing()),
        };
        let cursor = if let Some(encoded) = q.get("cursor").filter(|v| !v.is_empty()) {
            if encoded.len() > 4096 {
                return Err(Error::invalid("cursor"));
            }
            Some(
                serde_json::from_slice::<Cursor>(
                    &URL_SAFE_NO_PAD
                        .decode(encoded)
                        .map_err(|_| Error::invalid("cursor"))?,
                )
                .map_err(|_| Error::invalid("cursor"))?,
            )
        } else {
            None
        };
        let parse = |name: &str, default: DateTime<Utc>| {
            q.get(name)
                .map(|s| {
                    DateTime::parse_from_rfc3339(s)
                        .map(|t| t.with_timezone(&Utc))
                        .map_err(|_| Error::invalid(name))
                })
                .unwrap_or(Ok(default))
        };
        let now = Utc::now();
        let from = parse(
            "from",
            cursor.as_ref().map_or(
                if q.get("request_id").is_some_and(|v| !v.is_empty()) {
                    DateTime::from_timestamp(0, 0).unwrap()
                } else {
                    now - Duration::hours(24)
                },
                |c| c.from,
            ),
        )?;
        let to = parse("to", cursor.as_ref().map_or(now, |c| c.to))?;
        if from >= to {
            return Err(Error::invalid("to"));
        }
        let mut scope = BTreeMap::from([
            ("table".to_owned(), table.to_owned()),
            ("from".into(), from.to_rfc3339()),
            ("to".into(), to.to_rfc3339()),
        ]);
        for (name, _) in FILTERS.into_iter().chain(std::iter::once(("q", "q"))) {
            if let Some(value) = q.get(name).filter(|v| !v.is_empty()) {
                scope.insert(name.into(), value.clone());
            }
        }
        let scope = hash(&serde_json::to_string(&scope).unwrap());
        if cursor.as_ref().is_some_and(|c| c.scope != scope) {
            return Err(Error::invalid("cursor"));
        }
        let size = q
            .get("limit")
            .map(|s| s.parse::<usize>().map_err(|_| Error::invalid("limit")))
            .unwrap_or(Ok(20))?;
        if !(1..=100).contains(&size) {
            return Err(Error::invalid("limit"));
        }
        let source = if table == "requests" {
            "request_history"
        } else {
            table
        };
        let mut builder = QueryBuilder::<Postgres>::new(format!(
            "SELECT id,{time} AS at,{field} AS item FROM {source} WHERE expires_at>now() AND {time}>="
        ));
        builder
            .push_bind(from)
            .push(format!(" AND {time}<"))
            .push_bind(to);
        filters(&mut builder, field, q);
        if let Some(cursor) = cursor {
            builder
                .push(format!(" AND ({time},id)<("))
                .push_bind(cursor.at)
                .push(",")
                .push_bind(cursor.id)
                .push(")");
        }
        builder
            .push(format!(" ORDER BY {time} DESC,id DESC LIMIT "))
            .push_bind((size + 1) as i64);
        let mut rows = builder
            .build()
            .fetch_all(&self.pool)
            .await
            .map_err(|_| Error::internal())?;
        let more = rows.len() > size;
        rows.truncate(size);
        let next = if more {
            rows.last().map(|r| {
                URL_SAFE_NO_PAD.encode(
                    serde_json::to_vec(&Cursor {
                        id: r.get("id"),
                        at: r.get("at"),
                        from,
                        to,
                        scope,
                    })
                    .unwrap(),
                )
            })
        } else {
            None
        };
        Ok(
            json!({"items":rows.into_iter().map(|r|r.get::<Value,_>("item")).collect::<Vec<_>>(),"next_cursor":next}),
        )
    }
    pub async fn endpoint_call(&self, id: &str) -> Result<Value> {
        sqlx::query_scalar("SELECT body FROM endpoint_calls WHERE id=$1 AND expires_at>now()")
            .bind(Uuid::parse_str(id).map_err(|_| missing())?)
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| Error::internal())?
            .ok_or_else(missing)
    }
}

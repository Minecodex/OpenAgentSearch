use crate::repository::{Repository, missing};
use chrono::{DateTime, Utc};
use oas_application::engine::Execution;
use oas_domain::{Error, RequestStart, Result, truncate};
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder, Row};
use std::collections::HashMap;
use uuid::Uuid;

impl Repository {
    pub async fn interrupted(&self, id: &str) -> Result<()> {
        sqlx::query("UPDATE requests SET state='finished',record=record||'{\"status\":\"error\",\"incomplete\":true}'::jsonb,payload=payload||'{\"response_payload\":null,\"incomplete_reasons\":[\"execution_interrupted\"]}'::jsonb WHERE id=$1 AND state='running'")
            .bind(Uuid::parse_str(id).map_err(|_|missing())?).execute(&self.pool).await.map_err(|_|Error::internal())?;
        Ok(())
    }
    pub async fn reconcile_abandoned(&self) -> Result<()> {
        sqlx::query("UPDATE requests SET state='finished',record=record||'{\"status\":\"error\",\"incomplete\":true}'::jsonb,payload=payload||'{\"response_payload\":null,\"incomplete_reasons\":[\"execution_interrupted\"]}'::jsonb WHERE state='running'")
            .execute(&self.pool).await.map_err(|_|Error::internal())?;
        Ok(())
    }
    pub async fn terminal(
        &self,
        start: &RequestStart,
        execution: &Execution,
        duration: u64,
    ) -> Result<()> {
        let response = &execution.response;
        let delta = json!({"status":response["status"],"duration_ms":duration,"upstream_calls":execution.calls.iter().filter(|c|c["sent"]==true).count(),
            "model_calls":execution.calls.iter().filter(|c|c["sent"]==true&&c["kind"]=="model").count(),"incomplete":true,
            "response_preview":truncate(response["data"]["summary"].as_str().or(response["data"]["text"].as_str()).or(response["error"]["message"].as_str()).unwrap_or(""),300)});
        let payload = json!({"response_payload":response,"spans":[],"evidence":{"variants":[],"candidates":[],"sources":[],"segments":[]},"execution_summary":execution_summary(&start.operation,&execution.calls,&execution.evidence),
            "config_version":start.snapshot["project"]["version"],"incomplete_reasons":["diagnostics_pending"]});
        sqlx::query("UPDATE requests SET record=record||$2,payload=payload||$3,state='finished' WHERE id=$1").bind(Uuid::parse_str(&start.id).unwrap()).bind(delta).bind(payload).execute(&self.pool).await.map_err(|_|Error::internal())?;
        Ok(())
    }
    pub async fn recording_failed(&self, request: &str, reason: &str) -> Result<()> {
        sqlx::query("UPDATE requests SET record=jsonb_set(record,'{incomplete}','true'::jsonb),payload=jsonb_set(payload,'{incomplete_reasons}',$2) WHERE id=$1")
            .bind(Uuid::parse_str(request).map_err(|_|missing())?).bind(json!([reason])).execute(&self.pool).await.map_err(|_|Error::internal())?;
        Ok(())
    }
    pub async fn finish(
        &self,
        start: &RequestStart,
        mut execution: Execution,
        duration: u64,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await.map_err(|_| Error::internal())?;
        let uid = Uuid::parse_str(&start.id).unwrap();
        let row =
            sqlx::query("SELECT record,payload,expires_at FROM requests WHERE id=$1 FOR UPDATE")
                .bind(uid)
                .fetch_one(&mut *tx)
                .await
                .map_err(|_| Error::internal())?;
        let mut record: Value = row.get("record");
        record["incomplete"] = json!(false);
        let mut payload: Value = row.get("payload");
        let expiry: DateTime<Utc> = row.get("expires_at");
        record["status"] = if execution.response["data"]["reason"] == "CANCELLED" {
            json!("cancelled")
        } else if start.origin.ends_with("_test") {
            execution.response["data"]["status"].clone()
        } else {
            execution.response["status"].clone()
        };
        record["duration_ms"] = json!(duration);
        record["upstream_calls"] =
            json!(execution.calls.iter().filter(|c| c["sent"] == true).count());
        record["model_calls"] = json!(
            execution
                .calls
                .iter()
                .filter(|c| c["kind"] == "model" && c["sent"] == true)
                .count()
        );
        record["response_preview"] = json!(truncate(
            execution.response["data"]["summary"]
                .as_str()
                .or(execution.response["data"]["text"].as_str())
                .or(execution.response["data"]["items"][0]["snippet"].as_str())
                .or(execution.response["error"]["message"].as_str())
                .unwrap_or(""),
            300
        ));
        for c in &mut execution.calls {
            c["project_id"] = json!(start.project);
            c["origin"] = json!(start.origin);
            c["operation"] = json!(start.operation);
            if c["kind"] == "search" {
                oas_domain::evidence::evaluate_search(c, &execution.evidence, &start.operation);
            }
            let inserted = sqlx::query(
                "INSERT INTO endpoint_calls(id,request_id,finished_at,expires_at,body,retention_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING RETURNING dimension_hash",
            )
            .bind(Uuid::parse_str(c["call_id"].as_str().unwrap()).unwrap())
            .bind(uid)
            .bind(
                c["finished_at"]
                    .as_str()
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .map(|t| t.with_timezone(&Utc))
                    .unwrap_or_else(Utc::now),
            )
            .bind(expiry)
            .bind(&*c)
            .bind(start.retention_version)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|_| Error::internal())?;
            if let Some(inserted) = inserted {
                let dimension: String = inserted.get("dimension_hash");
                crate::statistics::contribute(
                    &mut tx,
                    c,
                    start.retention_version,
                    expiry,
                    &dimension,
                )
                .await?;
            } else {
                let existing: Value =
                    sqlx::query_scalar("SELECT body FROM endpoint_calls WHERE id=$1")
                        .bind(Uuid::parse_str(c["call_id"].as_str().unwrap()).unwrap())
                        .fetch_one(&mut *tx)
                        .await
                        .map_err(|_| Error::internal())?;
                if existing != *c {
                    tracing::error!(call_id=%c["call_id"],"call identity conflict");
                    return Err(Error::internal());
                }
            }
        }
        for mut material in execution.materials {
            let layout = material.as_object_mut().unwrap().remove("_layout");
            if material["kind"] == "model" && material["state"] == "complete" {
                material.as_object_mut().unwrap().remove("reason");
            }
            sqlx::query("INSERT INTO materials VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING")
                .bind(uid)
                .bind(Uuid::parse_str(material["material_id"].as_str().unwrap()).unwrap())
                .bind(Uuid::parse_str(material["call_id"].as_str().unwrap()).unwrap())
                .bind(&material)
                .bind(layout)
                .execute(&mut *tx)
                .await
                .map_err(|_| Error::internal())?;
            for span in &mut execution.spans {
                if span["diagnostics"]["call_id"] == material["call_id"] {
                    span["replay"]
                        .as_array_mut()
                        .unwrap()
                        .push(material.clone());
                }
            }
        }
        let mut summary =
            execution_summary(&start.operation, &execution.calls, &execution.evidence);
        if start.origin.ends_with("_test") {
            summary["retrieval"] = Value::Null;
            summary["score_batches"] = Value::Null;
            summary["answer_source"] = Value::Null;
        } else if execution.response["status"] == "empty"
            || execution.response["status"] == "error"
            || execution.response["status"] == "cancelled"
        {
            summary["answer_source"] = json!("none");
        } else if start.operation == "summary" {
            let mut kinds = std::collections::HashSet::new();
            for citation in execution.response["data"]["citations"]
                .as_array()
                .into_iter()
                .flatten()
            {
                if let Some(source) = execution.response["data"]["sources"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|s| s["id"] == citation["source_id"])
                    && let Some(kind) = source["kind"].as_str()
                {
                    kinds.insert(kind);
                }
            }
            summary["answer_source"] = json!(if kinds.len() > 1 {
                "mixed"
            } else if kinds.contains("snippet") {
                "snippet"
            } else {
                "body"
            });
        }
        payload["response_payload"] = execution.response;
        payload["metadata"] = record.clone();
        payload["spans"] = json!(execution.spans);
        payload["evidence"] = execution.evidence;
        payload["execution_summary"] = summary;
        payload["config_version"] = start.snapshot["project"]["version"].clone();
        payload["incomplete_reasons"] = json!([]);
        sqlx::query("UPDATE requests SET record=$2,payload=$3,state='finished' WHERE id=$1")
            .bind(uid)
            .bind(record)
            .bind(payload)
            .execute(&mut *tx)
            .await
            .map_err(|_| Error::internal())?;
        tx.commit().await.map_err(|_| Error::internal())?;
        Ok(())
    }
    pub async fn detail(&self, id: &str) -> Result<Value> {
        let uid = Uuid::parse_str(id).map_err(|_| missing())?;
        let row = sqlx::query(
            "SELECT record,payload FROM request_history WHERE id=$1 AND expires_at>now()",
        )
        .bind(uid)
        .fetch_optional(&self.pool)
        .await
        .map_err(|_| Error::internal())?
        .ok_or_else(missing)?;
        let mut payload: Value = row.get("payload");
        payload["metadata"] = row.get("record");
        let object = payload.as_object_mut().unwrap();
        object.entry("spans").or_insert_with(|| json!([]));
        object.entry("response_payload").or_insert(Value::Null);
        object.entry("config_version").or_insert(Value::Null);
        object.entry("execution_summary").or_insert_with(||json!({"retrieval":null,"score_batches":null,"answer_source":null,"endpoints":{"search":null,"reader":null,"model":null}}));
        object
            .entry("incomplete_reasons")
            .or_insert_with(|| json!([]));
        Ok(payload)
    }
    pub async fn list_records(
        &self,
        table: &str,
        query: &HashMap<String, String>,
    ) -> Result<Vec<Value>> {
        let calls = table == "endpoint_calls";
        let field = if calls { "body" } else { "record" };
        let time = if calls { "finished_at" } else { "started_at" };
        let mut builder = QueryBuilder::<Postgres>::new(format!(
            "SELECT {field} FROM {table} WHERE expires_at>now()"
        ));
        for (name, json_key) in [
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
        ] {
            if let Some(value) = query.get(name).filter(|s| !s.is_empty()) {
                builder
                    .push(format!(" AND {field}->>'{json_key}'="))
                    .push_bind(value.clone());
            }
        }
        for (name, operator) in [("from", ">="), ("to", "<")] {
            if let Some(value) = query.get(name) {
                let dt = DateTime::parse_from_rfc3339(value)
                    .map_err(|_| Error::invalid(name))?
                    .with_timezone(&Utc);
                builder.push(format!(" AND {time}{operator}")).push_bind(dt);
            }
        }
        if let Some(q) = query.get("q").filter(|s| !s.is_empty()) {
            builder.push(format!(" AND concat_ws(' ',{field}->>'query_preview',{field}->>'input_preview',{field}->>'request_id') ILIKE ")).push_bind(format!("%{q}%"));
        }
        builder.push(format!(" ORDER BY {time} DESC,id DESC"));
        let rows = builder
            .build()
            .fetch_all(&self.pool)
            .await
            .map_err(|_| Error::internal())?;
        Ok(rows.into_iter().map(|r| r.get(field)).collect())
    }
    pub async fn layout(&self, request: &str, material: &str) -> Result<Value> {
        let row = sqlx::query_scalar::<_, Option<Value>>(
            "SELECT m.layout FROM materials m JOIN requests r ON r.id=m.request_id WHERE m.request_id=$1 AND m.material_id=$2 AND r.expires_at>statement_timestamp()",
        )
        .bind(Uuid::parse_str(request).map_err(|_| missing())?)
        .bind(Uuid::parse_str(material).map_err(|_| missing())?)
        .fetch_optional(&self.pool)
        .await
        .map_err(|_| Error::internal())?
        .flatten()
        .ok_or_else(missing)?;
        let mut value = row;
        value["material_id"] = json!(material);
        Ok(value)
    }
    pub async fn public_detail(&self, request: &str) -> Result<Value> {
        let row=sqlx::query("SELECT record,(payload-'spans'-'evidence')||jsonb_build_object('spans',COALESCE((SELECT jsonb_agg(s->'span') FROM jsonb_array_elements(COALESCE(payload->'spans','[]'::jsonb)) s),'[]'::jsonb)) AS payload FROM request_history WHERE id=$1 AND expires_at>statement_timestamp()")
            .bind(Uuid::parse_str(request).map_err(|_|missing())?).fetch_optional(&self.pool).await.map_err(|_|Error::internal())?.ok_or_else(missing)?;
        let mut payload: Value = row.get("payload");
        payload["metadata"] = row.get("record");
        let object = payload.as_object_mut().unwrap();
        object.entry("response_payload").or_insert(Value::Null);
        object.entry("config_version").or_insert(Value::Null);
        object.entry("incomplete_reasons").or_insert(json!([]));
        object.entry("execution_summary").or_insert_with(||json!({"retrieval":null,"score_batches":null,"answer_source":null,"endpoints":{"search":null,"reader":null,"model":null}}));
        Ok(payload)
    }
    pub async fn evidence(&self, request: &str) -> Result<Value> {
        sqlx::query_scalar("SELECT COALESCE(payload->'evidence','{\"variants\":[],\"candidates\":[],\"sources\":[],\"segments\":[]}'::jsonb) FROM requests WHERE id=$1 AND expires_at>statement_timestamp()")
            .bind(Uuid::parse_str(request).map_err(|_|missing())?).fetch_optional(&self.pool).await.map_err(|_|Error::internal())?.ok_or_else(missing)
    }
    pub async fn span(&self, request: &str, span: &str) -> Result<Value> {
        sqlx::query_scalar("SELECT s FROM requests r CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.payload->'spans','[]'::jsonb)) s WHERE r.id=$1 AND r.expires_at>statement_timestamp() AND s->'span'->>'span_id'=$2 LIMIT 1")
            .bind(Uuid::parse_str(request).map_err(|_|missing())?).bind(span).fetch_optional(&self.pool).await.map_err(|_|Error::internal())?.ok_or_else(missing)
    }
}
fn execution_summary(op: &str, calls: &[Value], e: &Value) -> Value {
    let mut by_kind = serde_json::Map::new();
    for kind in ["search", "reader", "model"] {
        let mut ids = std::collections::HashSet::new();
        let endpoints = calls
            .iter()
            .filter(|c| c["kind"] == kind && c["sent"] == true)
            .filter(|c| ids.insert(c["endpoint_id"].clone().to_string()))
            .map(|c| json!({"endpoint_id":c["endpoint_id"],"endpoint_name":c["endpoint_name"]}))
            .collect::<Vec<_>>();
        by_kind.insert(kind.into(), json!(endpoints));
    }
    let mut batches = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for call in calls {
        if let Some(batch) = call["score_batch_id"].as_str()
            && seen.insert(batch)
        {
            let count = e["candidates"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|c| c["score_batch_id"] == batch)
                .count();
            batches.push(json!({"batch_id":batch,"candidate_count":count}));
        }
    }
    json!({"retrieval":if op=="content"{Value::Null}else{oas_domain::evidence::retrieval(calls,e)},
        "score_batches":if op=="summary"{json!(batches)}else{Value::Null},"answer_source":match op{"list"=>json!("search_results"),"content"=>json!("body"),_=>Value::Null},"endpoints":by_kind})
}

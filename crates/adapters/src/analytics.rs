use crate::{
    records::filters,
    repository::Repository,
    statistics::{bounds, normalize_scope},
    totals::Totals,
};
use chrono::{DateTime, Utc};
use futures::TryStreamExt;
use oas_domain::{Error, Result};
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder, Row};
use std::collections::{BTreeMap, HashMap};

#[derive(Default)]
struct Accumulator {
    all: Totals,
    series: BTreeMap<String, (String, Totals)>,
    endpoints: BTreeMap<(String, i64, String), Totals>,
}
impl Accumulator {
    fn add(
        &mut self,
        at: DateTime<Utc>,
        value: &Value,
        rollup: bool,
        q: &HashMap<String, String>,
    ) -> Result<()> {
        let dimensions = if rollup { &value["dimensions"] } else { value };
        let key = (
            dimensions["endpoint_id"].as_str().unwrap_or("").into(),
            dimensions["endpoint_version"].as_i64().unwrap_or(1),
            (if rollup {
                &value["name"]
            } else {
                &value["endpoint_name"]
            })
            .as_str()
            .unwrap_or("")
            .into(),
        );
        let (from, to) = bounds(&at.to_rfc3339(), q);
        let bucket = &mut self
            .series
            .entry(from)
            .or_insert_with(|| (to, Totals::default()))
            .1;
        let endpoint = self.endpoints.entry(key).or_default();
        for target in [&mut self.all, bucket, endpoint] {
            if rollup {
                target.merge(value)
            } else {
                target.record(value)
            }
        }
        if self.series.len() > 500 {
            return Err(Error::invalid("time_window"));
        }
        Ok(())
    }
    fn value(self, q: &HashMap<String, String>) -> Value {
        json!({"from":q["from"],"to":q["to"],"timezone":q["timezone"],"overview":self.all.value(),
            "series":self.series.into_iter().map(|(from,(to,totals))|json!({"from":from,"to":to,"metrics":totals.value()})).collect::<Vec<_>>(),
            "endpoints":self.endpoints.into_iter().map(|((id,version,name),totals)|json!({"endpoint_id":id,"version":version,"name":name,"metrics":totals.value()})).collect::<Vec<_>>()})
    }
}

fn eligible(
    builder: &mut QueryBuilder<'_, Postgres>,
    table: &str,
    interval: &str,
    q: &HashMap<String, String>,
    as_of: DateTime<Utc>,
    enabled: bool,
) {
    builder.push(format!("SELECT * FROM {table} WHERE "));
    builder.push(if enabled { "true" } else { "false" });
    builder
        .push(" AND bucket_at>=")
        .push_bind(q["from"].clone())
        .push("::timestamptz AND bucket_at+interval '")
        .push(interval)
        .push("'<=")
        .push_bind(q["to"].clone())
        .push("::timestamptz AND first_expiry>")
        .push_bind(as_of);
    // Old-format buckets remain readable through their authoritative call rows.
    builder
        .push(" AND metrics ? 'duration_histogram' AND metrics->>'histogram_samples'=metrics->>'calls' AND date_trunc(")
        .push_bind(q["granularity"].clone())
        .push(",bucket_at AT TIME ZONE ")
        .push_bind(q["timezone"].clone())
        .push(")=date_trunc(")
        .push_bind(q["granularity"].clone())
        .push(",(bucket_at+interval '")
        .push(interval)
        .push("'-interval '1 microsecond') AT TIME ZONE ")
        .push_bind(q["timezone"].clone())
        .push(")");
    filters(builder, "(metrics->'dimensions')", q);
}

impl Repository {
    /// A single database snapshot prevents an expiry boundary or a concurrent
    /// diagnostic commit from being counted once in a bucket and again in detail.
    pub async fn endpoint_statistics(&self, query: &HashMap<String, String>) -> Result<Value> {
        let q = normalize_scope(query)?;
        let mut tx = self.pool.begin().await.map_err(|_| Error::internal())?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *tx)
            .await
            .map_err(|_| Error::internal())?;
        let as_of: DateTime<Utc> = sqlx::query_scalar("SELECT transaction_timestamp()")
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| Error::internal())?;
        let use_rollups = !["q", "request_id"]
            .iter()
            .any(|key| q.get(*key).is_some_and(|v| !v.is_empty()));
        let mut builder = QueryBuilder::<Postgres>::new("WITH days AS (");
        eligible(
            &mut builder,
            "endpoint_stats_day",
            "1 day",
            &q,
            as_of,
            use_rollups,
        );
        builder.push("), hours AS (");
        eligible(
            &mut builder,
            "endpoint_stats_hour",
            "1 hour",
            &q,
            as_of,
            use_rollups,
        );
        builder.push(" AND NOT EXISTS(SELECT 1 FROM days d WHERE d.dimension_hash=endpoint_stats_hour.dimension_hash AND d.retention_version=endpoint_stats_hour.retention_version AND d.bucket_at=date_trunc('day',endpoint_stats_hour.bucket_at,'UTC')))");
        builder.push(" SELECT true AS rollup,bucket_at AS at,metrics AS item FROM days UNION ALL SELECT true,bucket_at,metrics FROM hours UNION ALL SELECT false,c.finished_at,c.body FROM endpoint_calls c WHERE c.expires_at>").push_bind(as_of).push(" AND c.finished_at>=").push_bind(q["from"].clone()).push("::timestamptz AND c.finished_at<").push_bind(q["to"].clone()).push("::timestamptz");
        filters(&mut builder, "c.body", &q);
        builder.push(" AND NOT EXISTS(SELECT 1 FROM days d WHERE d.dimension_hash=c.dimension_hash AND d.retention_version=c.retention_version AND d.bucket_at=date_trunc('day',c.finished_at,'UTC')) AND NOT EXISTS(SELECT 1 FROM hours h WHERE h.dimension_hash=c.dimension_hash AND h.retention_version=c.retention_version AND h.bucket_at=date_trunc('hour',c.finished_at,'UTC'))");
        let mut accumulator = Accumulator::default();
        let mut stream = builder.build().fetch(&mut *tx);
        while let Some(row) = stream.try_next().await.map_err(|_| Error::internal())? {
            accumulator.add(
                row.get("at"),
                &row.get::<Value, _>("item"),
                row.get("rollup"),
                &q,
            )?;
        }
        drop(stream);
        tx.commit().await.map_err(|_| Error::internal())?;
        Ok(accumulator.value(&q))
    }
    pub async fn request_aggregates(&self, query: &HashMap<String, String>) -> Result<Value> {
        let q = normalize_scope(query)?;
        let mut builder = QueryBuilder::<Postgres>::new(
            "SELECT started_at,record FROM request_history WHERE expires_at>statement_timestamp() AND started_at>=",
        );
        builder
            .push_bind(q["from"].clone())
            .push("::timestamptz AND started_at<")
            .push_bind(q["to"].clone())
            .push("::timestamptz");
        filters(&mut builder, "record", &q);
        let mut stream = builder.build().fetch(&self.pool);
        let (mut count, mut partial, mut errors, mut duration, mut upstream, mut models) =
            (0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
        let (mut business, mut completed, mut successful) = (0u64, 0u64, 0u64);
        let mut series = BTreeMap::<String, Value>::new();
        let mut operations = BTreeMap::<String, u64>::new();
        while let Some(row) = stream.try_next().await.map_err(|_| Error::internal())? {
            let record: Value = row.get("record");
            let op = record["operation"].as_str().unwrap_or("list");
            count += 1;
            if let Some(status) = record["status"].as_str().filter(|s| *s != "running") {
                completed += 1;
                successful += u64::from(matches!(status, "success" | "partial" | "empty"));
            }
            business += u64::from(record["origin"] == "business");
            partial += u64::from(record["status"] == "partial");
            errors += u64::from(record["status"] == "error");
            duration += record["duration_ms"].as_u64().unwrap_or(0);
            upstream += record["upstream_calls"].as_u64().unwrap_or(0);
            models += record["model_calls"].as_u64().unwrap_or(0);
            *operations.entry(op.into()).or_default() += 1;
            let at: DateTime<Utc> = row.get("started_at");
            let (from, _) = bounds(&at.to_rfc3339(), &q);
            let bucket = series
                .entry(from.clone())
                .or_insert_with(|| json!({"from":from,"list":0,"content":0,"summary":0}));
            bucket[op] = json!(bucket[op].as_u64().unwrap_or(0) + 1);
            if series.len() > 500 {
                return Err(Error::invalid("time_window"));
            }
        }
        Ok(
            json!({"from":q["from"],"to":q["to"],"requests":count,"business_requests":business,"completed":completed,"successful":successful,"partial":partial,"errors":errors,"average_duration_ms":if count==0{Value::Null}else{json!(duration as f64/count as f64)},"upstream_calls":upstream,"model_calls":models,"operations":operations,"series":series.into_values().collect::<Vec<_>>()}),
        )
    }
}

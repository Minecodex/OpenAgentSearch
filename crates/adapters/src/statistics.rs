use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use oas_domain::{Error, Result};
use serde_json::{Value, json};
use std::collections::HashMap;

pub fn normalize_scope(query: &HashMap<String, String>) -> Result<HashMap<String, String>> {
    let mut q = query.clone();
    let now = Utc::now();
    q.entry("from".into())
        .or_insert_with(|| (now - Duration::hours(24)).to_rfc3339());
    q.entry("to".into()).or_insert_with(|| now.to_rfc3339());
    let from = DateTime::parse_from_rfc3339(&q["from"]).map_err(|_| Error::invalid("from"))?;
    let to = DateTime::parse_from_rfc3339(&q["to"]).map_err(|_| Error::invalid("to"))?;
    if from >= to {
        return Err(Error::invalid("to"));
    }
    let timezone = q.entry("timezone".into()).or_insert_with(|| "UTC".into());
    timezone
        .parse::<Tz>()
        .map_err(|_| Error::invalid("timezone"))?;
    let hours = (to - from).num_hours();
    let granularity = q.entry("granularity".into()).or_insert_with(|| {
        if hours <= 499 {
            "hour"
        } else if hours <= 24 * 499 {
            "day"
        } else if hours <= 24 * 7 * 499 {
            "week"
        } else {
            "month"
        }
        .into()
    });
    if !["hour", "day", "week", "month"].contains(&granularity.as_str()) {
        return Err(Error::invalid("granularity"));
    }
    let estimate = match granularity.as_str() {
        "hour" => hours,
        "day" => hours / 24,
        "week" => hours / (24 * 7),
        _ => hours / (24 * 28),
    };
    if estimate > 499 {
        return Err(Error::invalid("time_window"));
    }
    Ok(q)
}
fn at_midnight(tz: Tz, date: NaiveDate) -> DateTime<Tz> {
    // A few zones advance clocks at midnight. Use their first valid local hour.
    (0..24)
        .find_map(|h| {
            tz.from_local_datetime(&date.and_hms_opt(h, 0, 0).unwrap())
                .earliest()
        })
        .unwrap()
}
pub(crate) fn bounds(value: &str, q: &HashMap<String, String>) -> (String, String) {
    let tz = q
        .get("timezone")
        .and_then(|s| s.parse::<Tz>().ok())
        .unwrap_or(chrono_tz::UTC);
    let t = DateTime::parse_from_rfc3339(value)
        .unwrap()
        .with_timezone(&tz);
    let gran = q.get("granularity").map(String::as_str).unwrap_or("hour");
    let (from, to) = if gran == "hour" {
        let from = t
            - Duration::minutes(t.minute() as i64)
            - Duration::seconds(t.second() as i64)
            - Duration::nanoseconds(t.nanosecond() as i64);
        (from, from + Duration::hours(1))
    } else {
        let date = t.date_naive();
        let date = match gran {
            "week" => date - Duration::days(date.weekday().num_days_from_monday() as i64),
            "month" => date.with_day(1).unwrap(),
            _ => date,
        };
        let next = match gran {
            "week" => date + Duration::days(7),
            "month" => {
                if date.month() == 12 {
                    NaiveDate::from_ymd_opt(date.year() + 1, 1, 1).unwrap()
                } else {
                    NaiveDate::from_ymd_opt(date.year(), date.month() + 1, 1).unwrap()
                }
            }
            _ => date + Duration::days(1),
        };
        (at_midnight(tz, date), at_midnight(tz, next))
    };
    (from.to_rfc3339(), to.to_rfc3339())
}
#[cfg(test)]
pub fn metrics(calls: &[Value]) -> Value {
    let mut totals = crate::totals::Totals::default();
    for call in calls {
        totals.record(call);
    }
    totals.value()
}
/// Idempotence is established by endpoint_calls before entering this function.
pub async fn contribute(
    tx: &mut sqlx::PgConnection,
    call: &Value,
    version: i64,
    expiry: DateTime<Utc>,
    dimension: &str,
) -> Result<()> {
    use sqlx::Row;
    let mut dimensions = serde_json::Map::new();
    for key in [
        "project_id",
        "endpoint_id",
        "endpoint_version",
        "kind",
        "operation",
        "origin",
        "language",
        "reason",
        "status",
        "evaluation",
    ] {
        dimensions.insert(key.into(), call[key].clone());
    }
    let at = DateTime::parse_from_rfc3339(call["finished_at"].as_str().unwrap())
        .map_err(|_| Error::internal())?
        .with_timezone(&Utc);
    for (table, hours) in [("endpoint_stats_hour", 1), ("endpoint_stats_day", 24)] {
        let seconds = hours * 3600;
        let bucket =
            DateTime::<Utc>::from_timestamp(at.timestamp().div_euclid(seconds) * seconds, 0)
                .unwrap();
        sqlx::query(&format!(
            "INSERT INTO {table} VALUES($1,$2,$3,$4,$4,'{{}}') ON CONFLICT DO NOTHING"
        ))
        .bind(bucket)
        .bind(dimension)
        .bind(version)
        .bind(expiry)
        .execute(&mut *tx)
        .await
        .map_err(|_| Error::internal())?;
        let row=sqlx::query(&format!("SELECT metrics FROM {table} WHERE bucket_at=$1 AND dimension_hash=$2 AND retention_version=$3 FOR UPDATE"))
            .bind(bucket).bind(dimension).bind(version).fetch_one(&mut *tx).await.map_err(|_|Error::internal())?;
        let mut totals: Value = row.get("metrics");
        let mut accumulator = crate::totals::Totals::default();
        accumulator.merge(&totals);
        accumulator.record(call);
        totals = accumulator.stored();
        totals["name"] = call["endpoint_name"].clone();
        totals["dimensions"] = json!(dimensions);
        sqlx::query(&format!("UPDATE {table} SET first_expiry=LEAST(first_expiry,$4),last_expiry=GREATEST(last_expiry,$4),metrics=$5 WHERE bucket_at=$1 AND dimension_hash=$2 AND retention_version=$3"))
            .bind(bucket).bind(dimension).bind(version).bind(expiry).bind(totals).execute(&mut *tx).await.map_err(|_|Error::internal())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn calendar_buckets_remove_subseconds_and_honor_timezone() {
        let q = normalize_scope(&HashMap::from([
            ("timezone".into(), "Asia/Shanghai".into()),
            ("from".into(), "2026-11-01T00:00:00Z".into()),
            ("to".into(), "2026-11-03T00:00:00Z".into()),
        ]))
        .unwrap();
        assert_eq!(
            bounds("2026-11-01T12:30:01.123Z", &q).0,
            "2026-11-01T20:00:00+08:00"
        );
        let mut day = q.clone();
        day.insert("granularity".into(), "day".into());
        assert_eq!(
            bounds("2026-11-01T19:30:01Z", &day).0,
            "2026-11-02T00:00:00+08:00"
        );
    }
    #[test]
    fn reader_quality_excludes_cancelled_and_requires_article() {
        let rows = vec![
            json!({"kind":"reader","status":"success","retained_chars":5}),
            json!({"kind":"reader","status":"error"}),
            json!({"kind":"reader","status":"cancelled"}),
        ];
        let m = metrics(&rows);
        assert_eq!(m["quality_numerator"], 1);
        assert_eq!(m["quality_denominator"], 2);
    }
}

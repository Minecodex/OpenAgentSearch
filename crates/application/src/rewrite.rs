use crate::journal::Journal;
use serde_json::{Value, json};
use std::collections::HashSet;

pub fn accepted(question: &str, output: &Value, limit: usize) -> (Vec<String>, Vec<Value>) {
    let mut seen = HashSet::from([question.trim().to_lowercase()]);
    let mut queries = Vec::new();
    let mut entries = Vec::new();
    for value in output["queries"].as_array().into_iter().flatten().take(32) {
        let query = value.as_str().unwrap_or("").trim();
        let state = if query.is_empty() || query.chars().count() > 2048 {
            "invalid"
        } else if query.to_lowercase() == question.trim().to_lowercase() {
            "duplicate_original"
        } else if !seen.insert(query.to_lowercase()) {
            "duplicate_rewrite"
        } else if queries.len() >= limit {
            "over_limit"
        } else {
            "used"
        };
        let mut entry = json!({"query":query,"state":state});
        if state == "used" {
            queries.push(query.to_owned());
            entry["variant_id"] = json!(format!("Q{}", queries.len()));
        }
        entries.push(entry);
    }
    (queries, entries)
}

pub fn annotate(
    journal: &mut Journal,
    call: Option<&str>,
    requested: usize,
    entries: Vec<Value>,
    used: usize,
    fallback: Option<&str>,
    original: bool,
) {
    journal.rewrite_fallback = fallback.filter(|_| original).map(str::to_owned);
    let span_id = journal
        .calls
        .iter()
        .rev()
        .find(|value| value["stage"] == "rewrite" && call.is_none_or(|id| value["call_id"] == id))
        .and_then(|value| value["span_id"].as_str())
        .map(str::to_owned);
    if let Some(span) = span_id.and_then(|id| journal.span(&id)) {
        span["diagnostics"]["rewrite"] = json!({"requested":requested,"used":used,"entries":entries,
            "state":if fallback.is_none(){"used"}else if original{"fallback"}else{"failed"},
            "fallback_reason":fallback,"search_original_query":original});
        if fallback.is_some() && span["span"]["status"] == "success" {
            span["span"]["status"] = json!(if original { "partial" } else { "error" });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discarded_entries_never_take_search_variant_ids() {
        let (queries, entries) = accepted(
            "rain",
            &json!({"queries":["rain","rain locally"," RAIN LOCALLY ","","another query"]}),
            1,
        );
        assert_eq!(queries, vec!["rain locally"]);
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry["state"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "duplicate_original",
                "used",
                "duplicate_rewrite",
                "invalid",
                "over_limit"
            ]
        );
        assert_eq!(entries[1]["variant_id"], "Q1");
        assert!(entries[0]["variant_id"].is_null());
    }
}

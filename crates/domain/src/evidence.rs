use crate::canonical_url;
use serde_json::{Value, json};
use std::collections::HashSet;

/// Only received result sets contribute known counts. A pending/error branch
/// is different from a successfully received empty result set.
pub fn retrieval(calls: &[Value], evidence: &Value) -> Value {
    let sent = calls
        .iter()
        .filter(|c| c["kind"] == "search" && c["sent"] == true)
        .filter_map(|c| c["variant_id"].as_str())
        .collect::<HashSet<_>>();
    let variants = evidence["variants"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| sent.contains(v["variant_id"].as_str().unwrap_or("")))
        .collect::<Vec<_>>();
    let completed = variants.iter().filter(|v| v["hits"].is_array()).count();
    let known_raw = variants
        .iter()
        .filter_map(|v| v["hits"].as_array())
        .map(Vec::len)
        .sum::<usize>();
    let known_unique = variants
        .iter()
        .filter_map(|v| v["hits"].as_array())
        .flatten()
        .filter_map(|h| h["url"].as_str())
        .filter_map(canonical_url)
        .collect::<HashSet<_>>()
        .len();
    let complete = completed == sent.len();
    json!({"variant_count":sent.len(),"completed_variants":completed,"incomplete_variants":sent.len().saturating_sub(completed),
        "raw_candidates":if complete{json!(known_raw)}else{Value::Null},"unique_candidates":if complete{json!(known_unique)}else{Value::Null},
        "known_raw_candidates":known_raw,"known_unique_candidates":known_unique})
}

pub fn evaluate_search(call: &mut Value, evidence: &Value, operation: &str) {
    let cid = call["call_id"].clone();
    let variant = evidence["variants"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|v| {
            v["hits"]
                .as_array()
                .is_some_and(|hits| hits.iter().any(|h| h["call_id"] == cid))
                || v["call_ids"]
                    .as_array()
                    .is_some_and(|ids| ids.contains(&cid))
        });
    let received = variant.is_some_and(|v| v["hits"].is_array() && v["result_call_id"] == cid);
    let urls = variant
        .and_then(|v| v["hits"].as_array())
        .into_iter()
        .flatten()
        .filter(|h| h["call_id"] == cid)
        .filter_map(|h| h["url"].as_str())
        .filter_map(canonical_url)
        .collect::<HashSet<_>>();
    let candidates = evidence["candidates"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| {
            c["hits"]
                .as_array()
                .is_some_and(|hits| hits.iter().any(|h| h["call_id"] == cid))
        })
        .collect::<Vec<_>>();
    let evaluated = candidates
        .iter()
        .filter(|c| c["relevant"].is_boolean())
        .count();
    let failed = matches!(call["status"].as_str(), Some("error" | "cancelled"));
    let count = if received {
        Some(urls.len())
    } else if !candidates.is_empty() {
        Some(candidates.len())
    } else {
        None
    };
    let state = if failed || count.is_none() {
        "missing"
    } else if count == Some(0) {
        "no_candidates"
    } else if operation != "summary" || evaluated == 0 {
        "unscored"
    } else if count == Some(evaluated) {
        "complete"
    } else {
        "incomplete"
    };
    call["evaluation"] = json!(state);
    call["candidates"] = if failed { Value::Null } else { json!(count) };
    call["evaluated"] = if matches!(state, "complete" | "incomplete") {
        json!(evaluated)
    } else {
        Value::Null
    };
    call["relevant"] = if matches!(state, "complete" | "incomplete") {
        json!(candidates.iter().filter(|c| c["relevant"] == true).count())
    } else {
        Value::Null
    };
}

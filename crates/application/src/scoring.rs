use crate::{
    calls::CallOutput,
    engine::{Run, protocol, terminal},
};
use oas_domain::{Endpoint, Error, Result, model, truncate};
use serde_json::{Value, json};
use std::{collections::HashSet, time::Instant};
impl Run<'_> {
    pub async fn model(&self, task: &str, input: &Value) -> Result<CallOutput> {
        let endpoint = self.model_endpoint()?.clone();
        let mut payload = self.model_input(input);
        for attempt in 0..if task == "score" { 1 } else { 2 } {
            let queued = Instant::now();
            let lease = self
                .bounded(
                    self.engine
                        .scheduler
                        .model_permit(&endpoint, self.request, &self.cancel),
                )
                .await?;
            match self
                .call(
                    &endpoint,
                    task,
                    &payload,
                    None,
                    lease,
                    queued.elapsed().as_millis() as u64,
                )
                .await
            {
                Ok(mut output) => {
                    if normalize_no_evidence(task, &mut output.value, input) {
                        let mut journal = self.journal.lock().unwrap();
                        let span = journal
                            .call(&output.call_id)
                            .and_then(|call| call["span_id"].as_str())
                            .map(str::to_owned);
                        if let Some(value) = span.and_then(|span| journal.span(&span)) {
                            value["output"]["summary"] = json!("");
                            value["diagnostics"]["normalization"] = json!("no_relevant_passages");
                        }
                    }
                    if valid_output(task, &output.value, input) {
                        return Ok(output);
                    }
                    self.journal
                        .lock()
                        .unwrap()
                        .fail_call(&output.call_id, "MODEL_FORMAT_INVALID");
                }
                Err(error) => {
                    if error.code != "MODEL_FORMAT_INVALID" {
                        return Err(error);
                    }
                }
            }
            if attempt == 0 {
                payload["_correction"] = json!(model::CORRECTION);
            }
        }
        Err(protocol("MODEL_FAILED"))
    }
    pub async fn score(&self, question: &str, candidates: &mut [Value]) -> Result<bool> {
        let endpoint = self.model_endpoint()?.clone();
        let mut offset = 0;
        let mut number = 0;
        let mut loss = false;
        'batches: while offset < candidates.len() {
            number += 1;
            let batch = format!("B{number}");
            let mut end = offset;
            let mut data = Vec::new();
            while end < candidates.len() {
                let item = &candidates[end];
                let mut row = json!({"candidate_id":item["candidate_id"],"title":truncate(item["title"].as_str().unwrap_or(""),256),"snippet":item["snippet_preview"]});
                if data.is_empty() {
                    let e = endpoint.clone();
                    let template = self.model_input(&json!({"query":question,"batch_id":batch}));
                    row = self
                        .bounded(crate::cpu::run(&self.cancel, move || {
                            fit_candidate(&e, &template, &mut row)?;
                            Ok(row)
                        }))
                        .await?;
                }
                let mut trial = data.clone();
                trial.push(row.clone());
                if !data.is_empty()
                    && !self
                        .request_fits(
                            &endpoint,
                            "score",
                            &json!({"query":question,"batch_id":batch,"candidates":trial}),
                        )
                        .await?
                {
                    break;
                }
                data.push(row);
                end += 1;
            }
            let mut missing = data;
            for correction in 0..2 {
                let mut input = json!({"query":question,"batch_id":batch,"candidates":missing});
                if correction > 0 {
                    input["_correction"] = json!(model::CORRECTION);
                }
                match self.model("score", &input).await {
                    Ok(output) => {
                        let scores = output.value["scores"].as_array().unwrap();
                        let mut accepted = HashSet::new();
                        for score in scores {
                            let Some(cid) = score["candidate_id"].as_str() else {
                                continue;
                            };
                            if scores.iter().filter(|v| v["candidate_id"] == cid).count() != 1
                                || !missing.iter().any(|v| v["candidate_id"] == cid)
                                || !score["relevant"].is_boolean()
                                || !score["score"].as_u64().is_some_and(|n| n <= 100)
                            {
                                continue;
                            }
                            let target = candidates[offset..end]
                                .iter_mut()
                                .find(|v| v["candidate_id"] == cid)
                                .unwrap();
                            target["relevant"] = score["relevant"].clone();
                            target["score"] = score["score"].clone();
                            target["score_batch_id"] = json!(batch);
                            target["score_call_id"] = json!(output.call_id);
                            accepted.insert(cid.to_owned());
                        }
                        missing.retain(|v| !accepted.contains(v["candidate_id"].as_str().unwrap()));
                        if !missing.is_empty() {
                            self.journal
                                .lock()
                                .unwrap()
                                .fail_call(&output.call_id, "MODEL_FORMAT_INVALID");
                        }
                    }
                    Err(error) => {
                        if error.code == "STAGE_BUDGET_EXCEEDED" {
                            loss = true;
                            self.evidence("candidates", json!(candidates));
                            break 'batches;
                        }
                        if terminal(&error) {
                            return Err(error);
                        }
                    }
                }
                if missing.is_empty() {
                    break;
                }
            }
            loss |= !missing.is_empty();
            self.evidence("candidates", json!(candidates));
            offset = end;
        }
        if !candidates.iter().any(|c| c["relevant"].is_boolean()) {
            return Err(protocol("MODEL_FAILED"));
        }
        Ok(loss)
    }
}
fn fit_candidate(endpoint: &Endpoint, template: &Value, row: &mut Value) -> Result<()> {
    let fits = |row: &Value| -> Result<bool> {
        let mut input = template.clone();
        input["candidates"] = json!([row]);
        model::fits_with_correction(endpoint, "score", &input)
    };
    for field in ["snippet", "title"] {
        if fits(row)? {
            return Ok(());
        }
        let chars = row[field]
            .as_str()
            .unwrap_or("")
            .chars()
            .collect::<Vec<_>>();
        let mut lo = 0;
        let mut hi = chars.len();
        let mut best = String::new();
        while lo <= hi {
            let middle = lo + (hi - lo) / 2;
            row[field] = json!(chars[..middle].iter().collect::<String>());
            if fits(row)? {
                best = row[field].as_str().unwrap().into();
                lo = middle + 1;
            } else {
                if middle == 0 {
                    break;
                }
                hi = middle - 1;
            }
        }
        row[field] = json!(best);
    }
    if fits(row)? {
        Ok(())
    } else {
        Err(Error::new(
            "MODEL_CONTEXT_EXCEEDED",
            502,
            "问题和模型指令已超过输入预算。",
            "The query and model instructions exceed the input budget.",
        ))
    }
}
fn normalize_no_evidence(task: &str, value: &mut Value, input: &Value) -> bool {
    if task != "synthesis"
        || input["mode"] != "whole_sources"
        || !value["summary"].is_string()
        || value["citations"]
            .as_array()
            .is_none_or(|items| !items.is_empty())
    {
        return false;
    }
    let expected = super::synthesis::passages(&input["sources"]);
    if expected.as_array().is_none_or(Vec::is_empty)
        || !super::synthesis::valid_assessments(value, &expected)
        || !value["passages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|part| part["relevant"] == false)
    {
        return false;
    }
    let changed = value["summary"] != "";
    value["summary"] = json!("");
    changed
}
pub(crate) fn valid_output(task: &str, value: &Value, input: &Value) -> bool {
    match task {
        "rewrite" => value["queries"]
            .as_array()
            .is_some_and(|v| v.iter().all(Value::is_string)),
        "score" => value["scores"].is_array(),
        "segments" if input["passages"].is_array() => {
            super::synthesis::valid_assessments(value, &input["passages"])
        }
        "segments" => {
            value["relevant"].is_boolean()
                && value["summary"].is_string()
                && (value["relevant"] == false
                    || value["summary"]
                        .as_str()
                        .is_some_and(|s| !s.trim().is_empty()))
                && value["source_id"] == input["source_id"]
                && value["segment_id"] == input["segment_id"]
        }
        "compress" => {
            value["summary"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty())
                && value["citations"].as_array().is_some_and(|cs| {
                    !cs.is_empty()
                        && cs.iter().all(|c| {
                            citation(c)
                                && c["source_id"] == input["source"]["id"]
                                && input["source"]["segments"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .any(|s| {
                                        s["id"] == c["segment_id"]
                                            || s["references"].as_array().is_some_and(|refs| {
                                                refs.iter().any(|id| id == &c["segment_id"])
                                            })
                                    })
                        })
                })
        }
        "synthesis" => {
            if input["mode"] == "whole_sources" {
                let expected = super::synthesis::passages(&input["sources"]);
                if !super::synthesis::valid_assessments(value, &expected) {
                    return false;
                }
                let assessments = value["passages"].as_array().unwrap();
                if assessments.iter().all(|p| p["relevant"] == false) {
                    return value["summary"] == ""
                        && value["citations"].as_array().is_some_and(Vec::is_empty);
                }
                if value["citations"].as_array().is_none_or(|cs| {
                    cs.iter().any(|c| {
                        !assessments.iter().any(|p| {
                            p["relevant"] == true
                                && p["source_id"] == c["source_id"]
                                && p["segment_id"] == c["segment_id"]
                        })
                    })
                }) {
                    return false;
                }
            }
            value["summary"].as_str().is_some_and(|s| {
                !s.trim().is_empty()
                    && s.chars().count() <= input["max_chars"].as_u64().unwrap_or(1200) as usize
            }) && value["citations"].as_array().is_some_and(|cs| {
                let mut seen = HashSet::new();
                !cs.is_empty()
                    && cs.iter().all(|c| {
                        citation(c)
                            && seen.insert((
                                c["source_id"].as_str().unwrap(),
                                c["segment_id"].as_str().unwrap(),
                            ))
                            && input["sources"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .any(|source| {
                                    source["id"] == c["source_id"]
                                        && source["segments"].as_array().into_iter().flatten().any(
                                            |s| {
                                                s["id"] == c["segment_id"]
                                                    || s["references"].as_array().is_some_and(
                                                        |refs| {
                                                            refs.iter()
                                                                .any(|id| id == &c["segment_id"])
                                                        },
                                                    )
                                            },
                                        )
                                })
                    })
            })
        }
        _ => false,
    }
}
fn citation(value: &Value) -> bool {
    value.as_object().is_some_and(|o| o.len() == 2)
        && value["source_id"].is_string()
        && value["segment_id"].is_string()
}
#[cfg(test)]
mod empty_evidence_tests {
    use super::*;
    #[test]
    fn only_complete_known_all_irrelevant_assessments_can_discard_an_uncited_explanation() {
        let input = json!({"mode":"whole_sources","sources":[{"id":"s1","segments":[{"id":"p1","text":"Page navigation only."}]}]});
        let base = json!({"summary":"No relevant evidence is available.","citations":[],"passages":[{"source_id":"s1","segment_id":"p1","relevant":false,"summary":"Navigation only."}]});
        let mut valid = base.clone();
        assert!(normalize_no_evidence("synthesis", &mut valid, &input));
        assert_eq!(valid["summary"], "");
        assert!(valid_output("synthesis", &valid, &input));
        for patch in [
            json!({"passages":[]}),
            json!({"passages":[{"source_id":"unknown","segment_id":"p1","relevant":false,"summary":""}]}),
            json!({"citations":[{"source_id":"s1","segment_id":"p1"}]}),
            json!({"passages":[{"source_id":"s1","segment_id":"p1","relevant":true,"summary":"Fact."}]}),
        ] {
            let mut invalid = base.clone();
            invalid
                .as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            assert!(!normalize_no_evidence("synthesis", &mut invalid, &input));
            assert!(!valid_output("synthesis", &invalid, &input));
        }
    }
}

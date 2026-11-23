use crate::{
    cpu,
    engine::{Run, terminal},
    sources::split_passages,
};
use futures::{StreamExt, stream};
use oas_domain::{Endpoint, Error, Result, model};
use serde_json::{Value, json};
use std::collections::HashSet;
use tokio::time::Instant;

pub(crate) struct Analysis {
    pub answer: Option<Value>,
    pub loss: bool,
    pub reasons: Vec<&'static str>,
    pub error: Option<Error>,
}

pub(crate) fn passages(sources: &Value) -> Value {
    json!(
        sources
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|source| {
                source["segments"].as_array().into_iter().flatten().map(|part|
            json!({"source_id":source["id"],"segment_id":part["id"],"text":part["text"]}))
            })
            .collect::<Vec<_>>()
    )
}

pub(crate) fn valid_assessments(value: &Value, expected: &Value) -> bool {
    let Some(rows) = value["passages"].as_array() else {
        return false;
    };
    let Some(expected) = expected.as_array() else {
        return false;
    };
    let mut seen = HashSet::new();
    rows.len() == expected.len()
        && rows.iter().all(|row| {
            row["source_id"].is_string()
                && row["segment_id"].is_string()
                && seen.insert((row["source_id"].as_str(), row["segment_id"].as_str()))
                && expected.iter().any(|p| {
                    p["source_id"] == row["source_id"] && p["segment_id"] == row["segment_id"]
                })
                && row["relevant"].is_boolean()
                && row["summary"]
                    .as_str()
                    .is_some_and(|s| row["relevant"] == false || !s.trim().is_empty())
        })
}

struct Passage {
    data: Value,
    source: usize,
    offset: usize,
}

fn batch_input(template: &Value, batch: &[Passage]) -> Value {
    let mut input = template.clone();
    if let [p] = batch {
        input
            .as_object_mut()
            .unwrap()
            .extend(p.data.as_object().unwrap().clone());
    } else {
        input["passages"] = json!(batch.iter().map(|p| &p.data).collect::<Vec<_>>());
    }
    input
}

fn plan_batches(
    endpoint: &Endpoint,
    template: &Value,
    sources: &[Value],
) -> Result<(Vec<Vec<Passage>>, bool)> {
    let mut batches = Vec::new();
    let mut batch = Vec::new();
    let mut truncated = false;
    for (index, source) in sources.iter().enumerate() {
        let text = source["segments"][0]["text"].as_str().unwrap();
        let make = |n: usize, offset, part: &str| Passage {
            source: index,
            offset,
            data: json!({"source_id":source["id"],"segment_id":format!("p{n}"),"text":part}),
        };
        let chunks = split_passages(text, 16, |n, part| {
            model::fits_with_correction(
                endpoint,
                "segments",
                &batch_input(template, &[make(n, 0, part)]),
            )
        })?;
        truncated |= chunks.iter().map(|(_, s)| s.len()).sum::<usize>() < text.len();
        for (i, (offset, text)) in chunks.into_iter().enumerate() {
            batch.push(make(i + 1, offset, &text));
            if batch.len() > 1
                && !model::fits_with_correction(
                    endpoint,
                    "segments",
                    &batch_input(template, &batch),
                )?
            {
                let last = batch.pop().unwrap();
                batches.push(std::mem::take(&mut batch));
                batch.push(last);
            }
        }
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    Ok((batches, truncated))
}

impl Run<'_> {
    fn accept_passage(&self, sources: &mut [Value], passage: &Passage, assessment: &Value) {
        if assessment["relevant"] != true {
            return;
        }
        let text = passage.data["text"].as_str().unwrap();
        let id = &passage.data["segment_id"];
        sources[passage.source]["segments"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":id,"summary":assessment["summary"]}));
        self.journal.lock().unwrap().evidence["segments"].as_array_mut().unwrap().push(json!({
            "source_id":passage.data["source_id"],"segment_id":id,"start_char":passage.offset,
            "end_char":passage.offset+text.chars().count(),"summary":assessment["summary"],"text_preview":text,"cited":false}));
    }

    pub async fn summarize_sources(
        &self,
        sources: &mut Vec<Value>,
        query: &str,
        language: Option<&str>,
        max_chars: usize,
        material_deadline: Instant,
    ) -> Result<Analysis> {
        let endpoint = self.model_endpoint()?.clone();
        let mut result = Analysis {
            answer: None,
            loss: false,
            reasons: Vec::new(),
            error: None,
        };
        let direct = json!({"mode":"whole_sources","query":query,"language":language,"max_chars":max_chars,"sources":sources});
        if self.request_fits(&endpoint, "synthesis", &direct).await? {
            let answer = self.model("synthesis", &direct).await?.value;
            for (index, source) in direct["sources"].as_array().unwrap().iter().enumerate() {
                sources[index]["segments"] = json!([]);
                let data = json!({"source_id":source["id"],"segment_id":"p1","text":source["segments"][0]["text"]});
                let assessment = answer["passages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|v| v["source_id"] == data["source_id"])
                    .unwrap();
                self.accept_passage(
                    sources,
                    &Passage {
                        data,
                        source: index,
                        offset: 0,
                    },
                    assessment,
                );
            }
            sources.retain(|s| !s["segments"].as_array().unwrap().is_empty());
            if !sources.is_empty() {
                result.answer = Some(answer);
            }
            return Ok(result);
        }
        let template = self.model_input(&json!({"query":query,"language":language}));
        let raw = sources.clone();
        let layout = template.clone();
        let (batches, truncated) = self
            .bounded(cpu::run(&self.cancel, move || {
                plan_batches(&endpoint, &layout, &raw)
            }))
            .await?;
        if truncated {
            result.loss = true;
            result.reasons.push("segments_truncated");
        }
        for source in sources.iter_mut() {
            source["segments"] = json!([]);
        }
        let mut work = self.fork();
        work.deadline = material_deadline;
        let mut completed = stream::iter(batches.into_iter().map(|batch| {
            let child = work.fork();
            let input = batch_input(&template, &batch);
            async move {
                let response = child.model("segments", &input).await.map(|out| out.value);
                (batch, response)
            }
        }))
        .buffered(4);
        while let Some((batch, response)) = completed.next().await {
            match response {
                Ok(value) => {
                    for passage in &batch {
                        let assessment = if batch.len() == 1 {
                            &value
                        } else {
                            value["passages"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .find(|p| {
                                    p["source_id"] == passage.data["source_id"]
                                        && p["segment_id"] == passage.data["segment_id"]
                                })
                                .unwrap()
                        };
                        self.accept_passage(sources, passage, assessment);
                    }
                }
                Err(error) if terminal(&error) => return Err(error),
                Err(error) => {
                    result.loss = true;
                    if error.code == "STAGE_BUDGET_EXCEEDED" {
                        result.reasons.push("material_budget_exhausted");
                    }
                    result.error = Some(error);
                }
            }
        }
        sources.retain(|s| !s["segments"].as_array().unwrap().is_empty());
        if !sources.is_empty() {
            result.answer = Some(
                self.synthesize_summaries(sources, query, language, max_chars)
                    .await?,
            );
        }
        Ok(result)
    }
}

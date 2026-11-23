use chrono::Utc;
use oas_domain::{Endpoint, id};
use oas_runtime::Lease;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct Journal {
    pub calls: Vec<Value>,
    pub spans: Vec<Value>,
    pub materials: Vec<Value>,
    pub evidence: Value,
    pub rewrite_fallback: Option<String>,
    call_index: HashMap<String, usize>,
    span_index: HashMap<String, usize>,
    pending_started: HashMap<String, Instant>,
}
pub type SharedJournal = Arc<Mutex<Journal>>;
impl Journal {
    pub fn new() -> Self {
        Self {
            evidence: json!({"variants":[],"candidates":[],"sources":[],"segments":[]}),
            ..Self::default()
        }
    }
    pub fn call(&mut self, id: &str) -> Option<&mut Value> {
        let i = *self.call_index.get(id)?;
        self.calls.get_mut(i)
    }
    pub fn span(&mut self, id: &str) -> Option<&mut Value> {
        let i = *self.span_index.get(id)?;
        self.spans.get_mut(i)
    }
    pub fn add_span(&mut self, value: Value) {
        let id = value["span"]["span_id"].as_str().unwrap().to_owned();
        self.span_index.insert(id, self.spans.len());
        self.spans.push(value);
    }
    pub fn finish_span(&mut self, id: &str, status: &str, output: Value, start: Instant) {
        if let Some(s) = self.span(id) {
            s.as_object_mut().unwrap().remove("_pending");
            s["span"]["status"] = json!(status);
            s["span"]["duration_ms"] = json!(start.elapsed().as_millis() as u64);
            s["output"] = output;
        }
    }
    pub fn candidate(&mut self, index: usize, patch: &Value) {
        if let Some(c) = self.evidence["candidates"]
            .as_array_mut()
            .and_then(|v| v.get_mut(index))
        {
            for (k, v) in patch.as_object().unwrap() {
                c[k] = v.clone();
            }
        }
    }
    pub fn plan_variants(&mut self, queries: &[(usize, String)]) {
        self.evidence["variants"]=json!(queries.iter().map(|(i,query)|json!({"variant_id":format!("Q{i}"),"query":query,"status":"pending","hits":null,"call_ids":[],"result_call_id":null})).collect::<Vec<_>>());
    }
    pub fn variant_result(
        &mut self,
        variant: &str,
        status: &str,
        hits: Option<Value>,
        call: Option<&str>,
    ) {
        if let Some(value) = self.evidence["variants"]
            .as_array_mut()
            .and_then(|v| v.iter_mut().find(|v| v["variant_id"] == variant))
        {
            value["status"] = json!(status);
            value["hits"] = hits.unwrap_or(Value::Null);
            value["result_call_id"] = json!(call);
        }
    }
    pub fn fail_call(&mut self, id: &str, code: &str) {
        let span = if let Some(c) = self.call(id) {
            c["status"] = json!("error");
            c["error_code"] = json!(code);
            c["span_id"].as_str().map(str::to_owned)
        } else {
            None
        };
        if let Some(span) = span
            && let Some(s) = self.span(&span)
        {
            s["span"]["status"] = json!("error");
        }
    }
    pub fn finalize_pending(&mut self, code: &str, start: Instant) {
        let now = Utc::now();
        for c in &mut self.calls {
            if c.as_object_mut().unwrap().remove("_pending").is_some() {
                c["status"] = json!(if code == "CANCELLED" {
                    "cancelled"
                } else {
                    "error"
                });
                c["finished_at"] = json!(now);
                c["error_code"] = json!(code);
                c["execution_ms"] = json!(
                    self.pending_started
                        .get(c["call_id"].as_str().unwrap_or(""))
                        .map(|t| t.elapsed().as_millis() as u64)
                        .unwrap_or(0)
                );
            }
        }
        for variant in self.evidence["variants"]
            .as_array_mut()
            .into_iter()
            .flatten()
        {
            if matches!(variant["status"].as_str(), Some("pending" | "running")) {
                variant["status"] = json!(if code == "CANCELLED" {
                    "cancelled"
                } else {
                    "error"
                });
            }
        }
        for s in &mut self.spans {
            if s.as_object_mut().unwrap().remove("_pending").is_some() {
                s["span"]["status"] = json!(if code == "CANCELLED" {
                    "cancelled"
                } else {
                    "error"
                });
                s["span"]["duration_ms"] = json!(
                    (start.elapsed().as_millis() as u64)
                        .saturating_sub(s["span"]["start_offset_ms"].as_u64().unwrap_or(0))
                );
                s["output"] = json!({"code":code});
            }
        }
    }
}

/// A dispatch permit is committed by the adapter, after all local checks and
/// request construction, immediately before handing a request to its client.
pub struct Dispatch {
    pub call_id: String,
    pub span_id: String,
    journal: SharedJournal,
    lease: Mutex<Lease>,
    record: Value,
    sent: Mutex<Option<Instant>>,
    cancel: CancellationToken,
    model_input: Option<Value>,
    tokenizer: Option<String>,
}
impl Dispatch {
    pub fn new(
        journal: SharedJournal,
        lease: Lease,
        record: Value,
        span_id: String,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            call_id: id(),
            span_id,
            journal,
            lease: Mutex::new(lease),
            record,
            sent: Mutex::new(None),
            cancel,
            model_input: None,
            tokenizer: None,
        }
    }
    pub fn with_model_input(mut self, value: Option<Value>, tokenizer: Option<String>) -> Self {
        self.model_input = value;
        self.tokenizer = tokenizer;
        self
    }
    pub fn sent(&self) -> oas_domain::Result<()> {
        if self.cancel.is_cancelled() {
            return Err(oas_domain::Error::cancelled());
        }
        let mut sent = self.sent.lock().unwrap();
        if sent.is_some() {
            return Err(oas_domain::Error::internal());
        }
        self.lease.lock().unwrap().commit();
        *sent = Some(Instant::now());
        let mut c = self.record.clone();
        c["call_id"] = json!(self.call_id);
        c["span_id"] = json!(self.span_id);
        c["sent"] = json!(true);
        c["started_at"] = json!(Utc::now());
        c["finished_at"] = c["started_at"].clone();
        c["_pending"] = json!(true);
        let mut j = self.journal.lock().unwrap();
        let index = j.calls.len();
        j.call_index.insert(self.call_id.clone(), index);
        j.pending_started
            .insert(self.call_id.clone(), sent.unwrap());
        j.calls.push(c);
        if self.record["kind"] == "search"
            && let Some(variant) = j.evidence["variants"].as_array_mut().and_then(|v| {
                v.iter_mut()
                    .find(|v| v["variant_id"] == self.record["variant_id"])
            })
        {
            variant["status"] = json!("running");
            variant["call_ids"]
                .as_array_mut()
                .unwrap()
                .push(json!(self.call_id));
        }
        if self.record["kind"] == "reader"
            && let Some(candidate) = j.evidence["candidates"].as_array_mut().and_then(|v| {
                v.iter_mut()
                    .find(|v| v["candidate_id"] == self.record["candidate_id"])
            })
        {
            candidate["reader_call_ids"]
                .as_array_mut()
                .unwrap()
                .push(json!(self.call_id));
        }
        if let Some(span) = j.span(&self.span_id) {
            span["diagnostics"]["call_id"] = json!(self.call_id);
        }
        if let Some(input) = &self.model_input {
            j.materials.push(json!({"material_id":id(),"call_id":self.call_id,"kind":"model","task":self.record["stage"],"state":"incomplete","reason":"response_not_received","prompt_version":oas_domain::model::PROMPT_VERSION,"tokenizer":self.tokenizer,"model_input":input}));
        }
        Ok(())
    }
    pub fn was_sent(&self) -> bool {
        self.sent.lock().unwrap().is_some()
    }
    /// Preserve the received wire body even if protocol or semantic validation
    /// subsequently rejects it. Headers and credentials never enter the journal.
    pub fn model_reply(&self, output: Value, complete: bool) {
        let mut journal = self.journal.lock().unwrap();
        if let Some(call) = journal.call(&self.call_id) {
            for (source, target) in [
                ("prompt_tokens", "input_tokens"),
                ("completion_tokens", "output_tokens"),
            ] {
                if output["usage"][source].is_u64() {
                    call[target] = output["usage"][source].clone();
                }
            }
        }
        if let Some(material) = journal
            .materials
            .iter_mut()
            .find(|m| m["call_id"] == self.call_id && m["kind"] == "model")
        {
            material["model_output"] = output;
            material["state"] = json!(if complete { "complete" } else { "incomplete" });
            if complete {
                material.as_object_mut().unwrap().remove("reason");
            } else {
                material["reason"] = json!("response_body_incomplete");
            }
        }
    }
    pub fn finish(&self, status: &str, value: Option<&Value>) {
        let sent = *self.sent.lock().unwrap();
        if let Some(start) = sent
            && let Some(call) = self.journal.lock().unwrap().call(&self.call_id)
        {
            call.as_object_mut().unwrap().remove("_pending");
            call["status"] = json!(status);
            call["finished_at"] = json!(Utc::now());
            call["execution_ms"] = json!(start.elapsed().as_millis() as u64);
            if let Some(value) = value
                && let Some(t) = value.get("_usage")
            {
                for key in ["input_tokens", "output_tokens"] {
                    if t[key].is_u64() {
                        call[key] = t[key].clone();
                    }
                }
            }
        }
        if let Some(value) = value
            && let Some(output) = value.get("_model_output")
        {
            let mut j = self.journal.lock().unwrap();
            if let Some(material) = j
                .materials
                .iter_mut()
                .find(|m| m["call_id"] == self.call_id && m["kind"] == "model")
            {
                material["model_output"] = output.clone();
                material["state"] = json!("complete");
                material.as_object_mut().unwrap().remove("reason");
            }
        }
    }
    pub fn failure(&self, code: &str) {
        if let Some(call) = self.journal.lock().unwrap().call(&self.call_id) {
            call["error_code"] = json!(code);
        }
    }
}
pub fn call_record(
    endpoint: &Endpoint,
    request: &str,
    project: &str,
    task: &str,
    input: &Value,
) -> Value {
    let mut record = json!({"request_id":request,"project_id":project,"endpoint_id":endpoint.id,"endpoint_name":endpoint.name,"endpoint_version":endpoint.version,"kind":endpoint.kind,"operation":"summary","origin":"business","stage":task,"queue_ms":0,"execution_ms":0,"status":"running","reason":"direct","language":input["language"],"input_preview":oas_domain::truncate(input["query"].as_str().or(input["url"].as_str()).unwrap_or(task),500),"evaluation":if endpoint.kind=="model"{"model"}else if endpoint.kind=="reader"{"received"}else{"unscored"},"candidates":null,"evaluated":null,"relevant":null,"retained_chars":null});
    for (input_key, output_key) in [
        ("variant_id", "variant_id"),
        ("batch_id", "score_batch_id"),
        ("candidate_id", "candidate_id"),
        ("source_id", "source_id"),
    ] {
        if let Some(value) = input.get(input_key) {
            record[output_key] = value.clone();
        }
    }
    record
}

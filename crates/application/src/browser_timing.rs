use crate::engine::Run;
use oas_domain::observation::Phase;
use serde_json::{Value, json};
impl Run<'_> {
    pub fn browser_timing(&self, call_id: &str, offset: u64, status: &str, raw: &Value) {
        let mut trace = self.journal.lock().unwrap();
        let Some(call) = trace.call(call_id) else {
            return;
        };
        let duration = call["execution_ms"].as_u64().unwrap_or(0);
        let Some(phases) = call["browser_job"]["phases"].as_array_mut() else {
            return;
        };
        phases.push(json!({"stage":"execute","start_offset_ms":offset,"duration_ms":duration,"status":if matches!(status,"empty"|"partial"){"success"}else{status},"source":"api","scope":"call"}));
        for raw in raw.as_array().into_iter().flatten() {
            if let Ok(mut phase) = serde_json::from_value::<Phase>(raw.clone()) {
                if phase.source != "worker"
                    || phase.scope != "call"
                    || !matches!(
                        phase.stage.as_str(),
                        "validate" | "navigate" | "extract" | "archive"
                    )
                {
                    continue;
                }
                phase.start_offset_ms = offset.saturating_add(phase.start_offset_ms);
                phase.parent_stage = Some("execute".into());
                phases.push(json!(phase));
            }
        }
    }
}

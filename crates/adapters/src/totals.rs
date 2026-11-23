use serde_json::{Value, json};
pub const FIELDS: [&str; 11] = [
    "calls",
    "successes",
    "queue_ms",
    "execution_ms",
    "speed_samples",
    "speed_ms",
    "quality_numerator",
    "quality_denominator",
    "input_tokens",
    "output_tokens",
    "usage_samples",
];
pub const BOUNDS: [u64; 13] = [
    10,
    25,
    50,
    100,
    250,
    500,
    1000,
    2500,
    5000,
    10000,
    30000,
    60000,
    u64::MAX,
];
#[derive(Default, Clone)]
pub(crate) struct Totals {
    counts: [u64; 11],
    histogram: [u64; 13],
}
impl Totals {
    pub fn record(&mut self, call: &Value) {
        let success = matches!(
            call["status"].as_str(),
            Some("success" | "empty" | "partial")
        );
        let ms = call["execution_ms"].as_u64().unwrap_or(0);
        let mut numerator = 0;
        let mut denominator = 0;
        if call["kind"] == "search" && call["evaluation"] == "complete" {
            numerator = call["relevant"].as_u64().unwrap_or(0);
            denominator = call["candidates"].as_u64().unwrap_or(0);
        }
        if call["kind"] == "reader" && call["status"] != "cancelled" {
            denominator = 1;
            numerator =
                u64::from(success && call["retained_chars"].as_u64().is_some_and(|n| n > 0));
        }
        let usage = call["kind"] == "model"
            && call["input_tokens"].is_u64()
            && call["output_tokens"].is_u64();
        let values = [
            1,
            u64::from(success),
            call["queue_ms"].as_u64().unwrap_or(0),
            ms,
            u64::from(success),
            if success { ms } else { 0 },
            numerator,
            denominator,
            if usage {
                call["input_tokens"].as_u64().unwrap()
            } else {
                0
            },
            if usage {
                call["output_tokens"].as_u64().unwrap()
            } else {
                0
            },
            u64::from(usage),
        ];
        for (i, n) in values.into_iter().enumerate() {
            self.counts[i] += n;
        }
        let bucket = BOUNDS.iter().position(|bound| ms <= *bound).unwrap();
        self.histogram[bucket] += 1;
    }
    pub fn merge(&mut self, value: &Value) {
        for (i, key) in FIELDS.iter().enumerate() {
            self.counts[i] += value[key].as_u64().unwrap_or(0);
        }
        for (i, bound) in BOUNDS.iter().enumerate() {
            self.histogram[i] += value["duration_histogram"][bound.to_string()]
                .as_u64()
                .unwrap_or(0);
        }
    }
    pub fn value(&self) -> Value {
        let mut value = json!({});
        for (i, key) in FIELDS.iter().enumerate() {
            value[*key] = json!(self.counts[i]);
        }
        let total = self.histogram.iter().sum::<u64>();
        let rank = (total * 95).div_ceil(100);
        let mut cumulative = 0;
        value["p95_ms"] = if total == 0 {
            Value::Null
        } else {
            let mut p95 = 0;
            for (i, count) in self.histogram.iter().enumerate() {
                cumulative += count;
                if cumulative >= rank {
                    p95 = BOUNDS[i];
                    break;
                }
            }
            json!(p95)
        };
        value
    }
    pub fn stored(&self) -> Value {
        let mut value = self.value();
        value["histogram_samples"] = json!(self.histogram.iter().sum::<u64>());
        value["duration_histogram"] = json!({});
        for (i, bound) in BOUNDS.iter().enumerate() {
            value["duration_histogram"][bound.to_string()] = json!(self.histogram[i]);
        }
        value
    }
}

use serde_json::Value;
use std::collections::HashMap;

pub fn secrets(values: &HashMap<String, Value>) -> Vec<String> {
    fn strings(value: &Value, output: &mut Vec<String>) {
        match value {
            Value::String(s) if s.len() >= 4 => output.push(s.clone()),
            Value::Object(map) => {
                for v in map.values() {
                    strings(v, output);
                }
            }
            Value::Array(items) => {
                for v in items {
                    strings(v, output);
                }
            }
            _ => {}
        }
    }
    let mut output = Vec::new();
    for value in values.values() {
        strings(value, &mut output);
    }
    output.sort_by_key(|s| std::cmp::Reverse(s.len()));
    output.dedup();
    output
}
pub fn redact(value: &mut Value, known: &[String]) {
    match value {
        Value::String(s) => {
            for secret in known {
                *s = s.replace(secret, &"*".repeat(secret.chars().count()));
            }
        }
        Value::Array(items) => {
            for value in items {
                redact(value, known);
            }
        }
        Value::Object(map) => {
            for (key, value) in map {
                if [
                    "password",
                    "api_key",
                    "authorization",
                    "proxy_authorization",
                    "secret",
                ]
                .contains(&key.to_ascii_lowercase().as_str())
                    && !value.is_boolean()
                    && !value.is_null()
                {
                    *value = Value::String("[REDACTED]".into());
                } else {
                    redact(value, known);
                }
            }
        }
        _ => {}
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn a19_redaction_keeps_unicode_ranges_and_never_persists_credentials() {
        let text = "前缀口令🙂，雨量计记录毫米。";
        let start = "前缀口令🙂，".chars().count();
        let mut value = json!({"text":text,"api_key":"口令🙂","nested":{"message":text}});
        redact(&mut value, &["口令🙂".into()]);
        assert!(!value.to_string().contains("口令🙂"));
        assert_eq!(
            value["text"].as_str().unwrap().chars().count(),
            text.chars().count()
        );
        assert_eq!(
            value["text"]
                .as_str()
                .unwrap()
                .chars()
                .skip(start)
                .collect::<String>(),
            "雨量计记录毫米。"
        );
    }
}

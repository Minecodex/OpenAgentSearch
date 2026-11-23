use serde_json::{Value, json};
use std::collections::HashSet;
pub fn native_layout(body: &str) -> Value {
    let content = ammonia::Builder::default()
        .url_schemes(HashSet::new())
        .url_relative(ammonia::UrlRelative::Deny)
        .clean(body)
        .to_string();
    let document = format!(
        "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'\"></head><body>{content}</body></html>"
    );
    json!({"state":"partial","srcdoc":document,"missing_resource_count":1,"reason":"native_service_did_not_supply_layout_resources"})
}

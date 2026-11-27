use crate::{Command, Error, Project, Result, canonical_url};
use chrono::DateTime;
use serde_json::Value;
use std::{collections::HashSet, net::IpAddr};

pub fn allowed_fields(v: &Value, allowed: &[&str]) -> Result<()> {
    let obj = v.as_object().ok_or_else(|| Error::invalid("body"))?;
    for key in obj.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(Error::invalid(key));
        }
    }
    Ok(())
}

pub fn language_tag(raw: &str) -> Result<String> {
    if raw.len() > 63
        || raw.contains('_')
        || raw
            .split('-')
            .next()
            .is_none_or(|s| !(2..=3).contains(&s.len()))
    {
        return Err(Error::invalid("language"));
    }
    let tag = raw
        .parse::<icu_locale_core::LanguageIdentifier>()
        .map_err(|_| Error::invalid("language"))?
        .to_string();
    let (base, suffix) = tag
        .split_once('-')
        .map_or((tag.as_str(), ""), |(base, _)| (base, &tag[base.len()..]));
    let canonical = match base {
        "iw" => "he",
        "jw" => "jv",
        "in" => "id",
        "ji" => "yi",
        "tl" => "fil",
        _ => base,
    };
    Ok(format!("{canonical}{suffix}"))
}

pub fn validate_command(op: &str, c: &Command, p: &Project) -> Result<()> {
    validate_input(op, c, p, false)
}
/// Background retrieval keeps the region of the already planned summary query.
pub fn validate_refresh_query(c: &Command, p: &Project) -> Result<()> {
    validate_input("list", c, p, true)
}
fn validate_input(op: &str, c: &Command, p: &Project, regional_list: bool) -> Result<()> {
    if let Some(language) = &c.language {
        language_tag(language)?;
    }
    if let Some(r) = &c.time_range
        && !["day", "month", "year"].contains(&r.as_str())
    {
        return Err(Error::invalid("time_range"));
    }
    if op == "content" {
        if c.query.is_some()
            || c.language.is_some()
            || c.count.is_some()
            || c.source_count.is_some()
            || c.time_range.is_some()
            || c.region.is_some()
            || c.current_time.is_some()
        {
            return Err(Error::invalid("body"));
        }
        if canonical_url(c.url.as_deref().unwrap_or("")).is_none() {
            return Err(Error::new(
                "URL_NOT_ALLOWED",
                400,
                "网页地址无效。",
                "Invalid webpage URL.",
            )
            .field("url"));
        }
    } else {
        let q = c.query.as_deref().unwrap_or("").trim();
        if q.is_empty() || q.chars().count() > 2048 || c.url.is_some() {
            return Err(Error::invalid("query"));
        }
        if op == "list"
            && (c.source_count.is_some()
                || c.max_chars.is_some()
                || (c.region.is_some() && !regional_list)
                || c.current_time.is_some())
        {
            return Err(Error::invalid("body"));
        }
        if op == "summary" && c.count.is_some() {
            return Err(Error::invalid("count"));
        }
    }
    for (field, value, limit) in [
        ("count", c.count, p.search_limit),
        ("source_count", c.source_count, p.source_limit),
        (
            "max_chars",
            c.max_chars,
            if op == "content" {
                p.body_limit
            } else {
                p.summary_limit
            },
        ),
    ] {
        if value.is_some_and(|v| v == 0 || v > limit) {
            let mut e = Error::new(
                "LIMIT_EXCEEDED",
                400,
                "参数超出项目限制。",
                "Parameter exceeds project limit.",
            );
            e.details = Box::new(serde_json::json!({"field":field,"limit":limit,"received":value}));
            return Err(e);
        }
    }
    if let Some(region) = &c.region
        && (region.trim().is_empty()
            || region.chars().count() > 128
            || region.chars().any(char::is_control))
    {
        return Err(Error::invalid("region"));
    }
    if let Some(t) = &c.current_time
        && (t.ends_with("-00:00") || !t.contains('T') || DateTime::parse_from_rfc3339(t).is_err())
    {
        return Err(Error::invalid("current_time"));
    }
    Ok(())
}

pub fn validate_project(p: &Project) -> Result<()> {
    if p.name.trim().is_empty() {
        return Err(Error::invalid("name"));
    }
    if p.search_limit == 0
        || p.search_limit > 10
        || p.source_limit == 0
        || p.source_limit > p.search_limit
    {
        return Err(Error::invalid("source_limit"));
    }
    if p.body_limit == 0 || p.summary_limit == 0 || p.rewrite_count > 3 {
        return Err(Error::invalid("limits"));
    }
    if !p.search_original_query && p.rewrite_count == 0 {
        return Err(Error::new(
            "INVALID_ARGUMENT",
            400,
            "关闭原问题搜索时，额外查询数至少为 1。",
            "At least one rewritten query is required when original-query search is disabled.",
        )
        .field("rewrite_count"));
    }
    for (field, pools) in [
        ("search_pools", &p.search_pools),
        ("reader_pools", &p.reader_pools),
    ] {
        let mut seen = HashSet::new();
        if pools.len() > 100 {
            return Err(Error::invalid(field));
        }
        for pool in pools {
            if pool.is_empty() || pool.len() > 100 {
                return Err(Error::invalid(field));
            }
            for id in pool {
                if !seen.insert(id) || uuid::Uuid::parse_str(id).is_err() {
                    return Err(Error::invalid(field));
                }
            }
        }
    }
    Ok(())
}

pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            !v.is_private()
                && !v.is_loopback()
                && !v.is_link_local()
                && !v.is_unspecified()
                && !v.is_broadcast()
                && !v.is_multicast()
                && v.octets()[0] != 0
                && v.octets()[0] < 224
                && !(v.octets()[0] == 100 && (64..=127).contains(&v.octets()[1]))
        }
        IpAddr::V6(v) => {
            !v.is_loopback()
                && !v.is_unspecified()
                && !v.is_multicast()
                && (v.segments()[0] & 0xfe00) != 0xfc00
                && (v.segments()[0] & 0xffc0) != 0xfe80
                && v.to_ipv4_mapped().is_none_or(|v| public_ip(IpAddr::V4(v)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_query_search_defaults_on_and_requires_a_rewrite_when_disabled() {
        let mut project: Project = serde_json::from_value(serde_json::json!({
            "name":"Queries", "search_pools":[], "reader_pools":[], "rewrite_count":0
        }))
        .unwrap();
        assert!(project.search_original_query);
        assert!(validate_project(&project).is_ok());
        project.search_original_query = false;
        let error = validate_project(&project).unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert_eq!(error.details["field"], "rewrite_count");
        assert!(error.zh.contains("至少为 1"));
        assert!(error.en.contains("At least one"));
        project.rewrite_count = 1;
        assert!(validate_project(&project).is_ok());
    }
    #[test]
    fn url_and_network_boundaries() {
        assert!(canonical_url("file:///tmp/a").is_none());
        assert!(canonical_url("https://user:pass@example.org").is_none());
        assert!(!public_ip("127.0.0.1".parse().unwrap()));
        assert!(!public_ip("::ffff:192.168.1.1".parse().unwrap()));
        assert!(public_ip("8.8.8.8".parse().unwrap()));
        assert_eq!(
            canonical_url("HTTPS://EXAMPLE.ORG:443/a#part").unwrap(),
            "https://example.org/a"
        );
    }
}

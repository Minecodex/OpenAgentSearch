//! Explicit calendar conditions are hard constraints on semantic query reuse.
use regex::Regex;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::LazyLock,
};

static DATE: LazyLock<Regex> = LazyLock::new(|| {
    let month = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
    let day = r"[0-9]{1,2}(?:st|nd|rd|th)?";
    let cn = r"[0-9〇零一二三四五六七八九十廿卅]+";
    Regex::new(&format!(
        r"(?ix)
        (?:(?:\b(?:before|after|since|until|through)|截至|早于|晚于)[\s:]*)?
        (?:
        (?:[0-9]{{4}}[-/.][0-9]{{1,2}}(?:[-/.][0-9]{{1,2}})?)
        |(?:[0-9]{{1,2}}[-/.][0-9]{{1,2}}(?:[-/.][0-9]{{2,4}})?)
        |(?:{cn}年(?:{cn}月(?:{cn}[日号]?)?)?|{cn}月(?:{cn}[日号]?)?|{cn}[日号])
        |(?:\b{month}\.?\s+(?:[0-9]{{4}}\b|{day}\b(?:,?\s+[0-9]{{4}})?))
        |(?:\b{day}\s+{month}\.?(?:,?\s+[0-9]{{4}})?\b)
        |(?:19|20)[0-9]{{2}}
        |(?:昨天|今天|明天|后天|前天|昨日|今日|明日|下周|本周|上周|下月|本月|上月|去年|今年|明年)
        |\b(?:today|tomorrow|yesterday|(?:last|this|next)\s+(?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b
        )(?:之前|之后|以前|以后)?
    "
    ))
    .expect("valid calendar expressions")
});
// Numeric release spans and calendar spans have separate identities. Unqualified
// markers ("v2.1") keep their version role even if no product name is available.
const PRODUCT_NAMES: &str = "ubuntu|乌班图|debian|fedora|linux|unity|kde|gnome|windows|android|安卓|ios|macos|openssl|node\\.js|nodejs|node|rust|python|java|golang|go|postgresql|postgres|mysql|redis|qdrant|firefox|火狐|chrome|kubernetes|docker";
const RELEASE_NUMBER: &str = r"[0-9]{1,4}(?:\.[0-9][0-9a-z]*){0,4}(?:[-_](?:alpha|beta|rc)[0-9]*)?";
static VERSION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?ix)
        (?:(?P<known>{PRODUCT_NAMES})\s*(?:(?:version|release|版本)\s*)?v?
          |(?-u:\b)(?P<named>[a-z][a-z0-9_+\#-]*)\s*(?:\s+(?:version|release)\s*|版本\s*|[-_\s]+v)
          |(?-u:\b)v)
        (?P<number>{RELEASE_NUMBER})"
    ))
    .expect("valid release expressions")
});
static SEMVER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"(?i)\b(?P<named>[a-z][a-z0-9_+#-]+)\s+(?P<number>[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}[a-z]?(?:-(?:alpha|beta|rc)[0-9]*)?)\b"
).expect("valid semantic version")
});
type Versions = BTreeMap<String, BTreeSet<String>>;

fn releases(text: &str) -> Vec<(std::ops::Range<usize>, String, String)> {
    let mut values = Vec::new();
    for pattern in [&*VERSION, &*SEMVER] {
        for m in pattern.captures_iter(text) {
            if text[..m.get(0).unwrap().start()]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                continue;
            }
            let number = m.name("number").unwrap();
            let after = &text[number.end()..];
            if after.starts_with(['/', '-'])
                || after.starts_with(|c: char| c.is_ascii_alphanumeric())
                || values
                    .iter()
                    .any(|(span, _, _): &(std::ops::Range<usize>, String, String)| {
                        span == &number.range()
                    })
            {
                continue;
            }
            let name = m
                .name("known")
                .or(m.name("named"))
                .map(|s| s.as_str().to_ascii_lowercase())
                .unwrap_or_default();
            let name = match name.as_str() {
                "乌班图" => "ubuntu",
                "安卓" => "android",
                "火狐" => "firefox",
                "postgresql" => "postgres",
                "golang" => "go",
                "nodejs" | "node.js" => "node",
                s => s,
            }
            .to_owned();
            values.push((number.range(), name, number.as_str().to_ascii_lowercase()));
        }
    }
    values
}
fn versions(text: &str) -> Versions {
    let mut out = Versions::new();
    for (_, product, version) in releases(text) {
        out.entry(product).or_default().insert(version);
    }
    out
}
pub(super) fn compatible_versions(a: &str, b: &str) -> bool {
    let other = versions(b);
    versions(a)
        .iter()
        .all(|(product, required)| other.get(product).is_none_or(|v| v == required))
}
pub(super) fn supports_versions<'a>(
    requested: &str,
    historical: &str,
    material: impl IntoIterator<Item = &'a str>,
) -> bool {
    let required = versions(requested);
    if required.is_empty() {
        return true;
    }
    let named = versions(historical);
    let mut observed = Versions::new();
    for field in material {
        for (p, v) in versions(field) {
            observed.entry(p).or_default().extend(v);
        }
    }
    required.iter().all(|(p, wanted)| {
        if let Some(v) = named.get(p)
            && v != wanted
        {
            return false;
        }
        match observed.get(p) {
            Some(v) => wanted.is_subset(v),
            None => named.get(p) == Some(wanted),
        }
    })
}
// A definition question may point to a specific character in a named phrase.
static FOCUS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"(?P<phrase>[\p{Han}]{2,16}?)(?:中的|里的|的)[“‘『「]?(?P<term>[\p{Han}])[”’』」]?(?:字)?(?:是)?(?:什么意思|什么含义|何意)"
).expect("valid definition focus")
});
pub(super) fn compatible_focus(a: &str, b: &str) -> bool {
    let focus = |text: &str| {
        FOCUS.captures(text).and_then(|m| {
            let phrase = m
                .name("phrase")?
                .as_str()
                .trim_start_matches("请问")
                .trim_start_matches('在');
            let term = m.name("term")?.as_str();
            phrase
                .contains(term)
                .then(|| (phrase.to_owned(), term.to_owned()))
        })
    };
    match (focus(a), focus(b)) {
        (Some((a, x)), Some((b, y))) if a == b => x == y,
        _ => true,
    }
}

fn calendar_key(raw: &str) -> String {
    let literal = raw
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut body = literal.as_str();
    let mut qualifier = "";
    for (word, kind) in [
        ("before", "before"),
        ("早于", "before"),
        ("after", "after"),
        ("晚于", "after"),
        ("since", "since"),
        ("until", "until"),
        ("截至", "until"),
        ("through", "through"),
    ] {
        if let Some(rest) = body.strip_prefix(word) {
            body = rest.trim_start_matches([' ', ':']);
            qualifier = kind;
            break;
        }
    }
    for (word, kind) in [
        ("之前", "before"),
        ("以前", "before"),
        ("之后", "after"),
        ("以后", "after"),
    ] {
        if let Some(rest) = body.strip_suffix(word) {
            if !qualifier.is_empty() {
                return literal;
            }
            body = rest;
            qualifier = kind;
            break;
        }
    }
    for format in [
        "%Y-%m-%d",
        "%Y/%m/%d",
        "%Y.%m.%d",
        "%Y年%m月%d日",
        "%Y年%m月%d号",
        "%B %d, %Y",
        "%b %d, %Y",
        "%d %B %Y",
        "%d %b %Y",
    ] {
        if let Ok(date) = chrono::NaiveDate::parse_from_str(body, format) {
            return format!("{qualifier}/{date}");
        }
    }
    literal
}
pub(super) fn constraints(text: &str) -> BTreeSet<String> {
    let spans = releases(text);
    DATE.find_iter(text)
        .filter(|m| {
            if spans
                .iter()
                .any(|(span, _, _)| span.start < m.end() && span.end > m.start())
            {
                return false;
            }
            let raw = m.as_str().trim();
            if raw.bytes().next().is_some_and(|c| c.is_ascii_digit()) && raw.contains('.') {
                let parts = raw.split('.').collect::<Vec<_>>();
                if parts.len() == 2 && parts[0].len() < 4 {
                    let (Ok(a), Ok(b)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) else {
                        return false;
                    };
                    if chrono::NaiveDate::from_ymd_opt(2000, a, b).is_none()
                        && chrono::NaiveDate::from_ymd_opt(2000, b, a).is_none()
                    {
                        return false;
                    }
                }
            }
            // Avoid extracting a year from a model identifier such as HP 2000-2302tu.
            let following = &text[m.end()..];
            let before = &text[..m.start()];
            !before
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '.')
                && !following
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric())
                && !following
                    .strip_prefix('.')
                    .is_some_and(|tail| tail.starts_with(|c: char| c.is_ascii_alphanumeric()))
                && !following
                    .strip_prefix('-')
                    .is_some_and(|s| s.starts_with(|c: char| c.is_ascii_digit()))
        })
        .map(|m| calendar_key(m.as_str()))
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dotted_releases_are_typed_separately_from_calendar_dates() {
        for sample in [
            "Unity does not start in Ubuntu 13.04",
            "Ubuntu13.04",
            "Python3.11",
            "read OpenAgentSearch v1.2",
            "read v1.2",
        ] {
            assert!(constraints(sample).is_empty(), "{sample}");
        }
        assert_eq!(
            constraints("on 2026-11-27."),
            constraints("2026年11月27日天气")
        );
        assert_eq!(
            constraints("before 2026/11/27"),
            constraints("2026年11月27日之前")
        );
        assert!(constraints("在Ubuntu 22.04上升级 Node.js 18.12").is_empty());
        assert_ne!(constraints("rainfall 11.26"), constraints("rainfall 11.27"));
        assert!(constraints("OpenSSL 1.0.1c and Ubuntu 2024.04").is_empty());
        assert!(compatible_versions(
            "Ubuntu 13.04 fails",
            "Unity will not start"
        ));
        assert!(!compatible_versions(
            "Ubuntu 13.04 fails",
            "Ubuntu 14.04 freezes"
        ));
        assert!(supports_versions(
            "Ubuntu 13.04 fails",
            "Unity will not start",
            ["Unity on Ubuntu 13.04"]
        ));
        assert!(!supports_versions(
            "Ubuntu 13.04 fails",
            "Unity will not start",
            ["Ubuntu 14.04"]
        ));
        assert!(!supports_versions(
            "Ubuntu 13.04 fails",
            "Unity will not start",
            ["a generic guide"]
        ));
        assert_ne!(constraints("on 2026-11-26"), constraints("on 2026-11-27"));
    }
    #[test]
    fn definition_focus_is_checked_inside_the_same_phrase() {
        assert!(!compatible_focus(
            "聚精会神的神是什么意思",
            "聚精会神中的会是什么意思"
        ));
        assert!(compatible_focus(
            "聚精会神的神是什么意思",
            "聚精会神中的『神』字是什么意思"
        ));
        assert!(compatible_focus("聚精会神的神是什么意思", "成语释义"));
    }
    #[test]
    fn dates_in_english_chinese_and_numeric_rewrites_are_hard_conditions() {
        for (a, b) in [
            ("雨量2026-11-26", "雨量2026-11-27"),
            ("rain before November 27", "rain after November 27"),
            ("11月27日之前", "11月27日之后"),
            ("11月26日 雨量", "11月27日 雨量"),
            ("November 26, 2026 rain", "November 27, 2026 rain"),
            ("rain on 26 Nov 2026", "rain on 27 Nov 2026"),
            (
                "天气 二〇二六年十一月二十六日",
                "天气 二〇二六年十一月二十七日",
            ),
            ("today's rain", "tomorrow's rain"),
            ("release on 11/26/2026", "release on 11/26/2025"),
        ] {
            assert_ne!(constraints(a), constraints(b), "{a} {b}");
        }
        assert_eq!(
            constraints("Rain today"),
            constraints("Rain forecast today")
        );
    }
}

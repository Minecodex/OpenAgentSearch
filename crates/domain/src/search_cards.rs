use crate::{Error, Result, canonical_url};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchCard {
    pub engine: String,
    pub url: String,
    pub title: String,
    pub content: String,
}

pub fn parse(value: &Value) -> Result<Vec<SearchCard>> {
    let Some(value) = value.get("cards") else {
        return Ok(Vec::new());
    };
    let invalid = || {
        Error::new(
            "SEARCH_FAILED",
            502,
            "搜索页卡片的格式或长度无效。",
            "Invalid search-card format or length.",
        )
    };
    let cards: Vec<SearchCard> = serde_json::from_value(value.clone()).map_err(|_| invalid())?;
    if cards.len() > 10
        || cards
            .iter()
            .map(|card| card.content.chars().count())
            .sum::<usize>()
            > 8192
        || cards.iter().any(|card| {
            !["google", "baidu"].contains(&card.engine.as_str())
                || canonical_url(&card.url).is_none()
                || card.title.chars().count() > 200
                || card.content.trim().is_empty()
                || card
                    .content
                    .chars()
                    .any(|ch| ch.is_control() && !['\r', '\n', '\t'].contains(&ch))
        })
    {
        return Err(invalid());
    }
    Ok(cards)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn cards_require_a_real_page_and_bounded_readable_material() {
        let good = json!({"cards":[{"engine":"google","url":"https://www.google.com/search?q=rain","title":"天气","content":"广州\n23℃"}]});
        assert_eq!(parse(&good).unwrap().len(), 1);
        for patch in [
            json!({"url":"file:///private"}),
            json!({"content":""}),
            json!({"content":"x".repeat(8193)}),
            json!({"engine":"other"}),
            json!({"content":"bad\u{0001}"}),
        ] {
            let mut invalid = good.clone();
            for (key, value) in patch.as_object().unwrap() {
                invalid["cards"][0][key] = value.clone();
            }
            assert!(parse(&invalid).is_err());
        }
    }
}

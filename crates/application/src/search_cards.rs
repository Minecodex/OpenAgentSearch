use oas_domain::{Hit, canonical_url, search_cards::SearchCard};

/// Card material remains attributed to the actual search page and is scored
/// against the original question, like every other candidate.
pub fn candidates(cards: &[SearchCard], chinese: bool) -> Vec<Hit> {
    let mut groups = Vec::<Hit>::new();
    for card in cards {
        let key = canonical_url(&card.url);
        if let Some(hit) = groups.iter_mut().find(|hit| canonical_url(&hit.url) == key) {
            hit.content
                .as_mut()
                .unwrap()
                .push_str(&format!("\n\n{}", card.content));
            continue;
        }
        let brand = if card.engine == "google" {
            "Google"
        } else if chinese {
            "百度"
        } else {
            "Baidu"
        };
        let title = if chinese {
            format!("{brand} 搜索页卡片：{}", card.title)
        } else {
            format!("{brand} search cards: {}", card.title)
        };
        let note = if chinese {
            "搜索页卡片材料；请核对地点、日期和统计范围，查询建议不属于事实。"
        } else {
            "Search-page card material: verify its location, date and statistical scope; query suggestions are not facts."
        };
        groups.push(Hit {
            url: card.url.clone(),
            title: title.chars().take(200).collect(),
            snippet: card.content.chars().take(1000).collect(),
            content: Some(format!("{note}\n\n{}", card.content)),
            rank: 0,
            variant_id: String::new(),
            call_id: String::new(),
        });
    }
    groups
}

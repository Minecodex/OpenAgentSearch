use super::*;
use oas_domain::{Command, Hit, cache::*};
use serde_json::json;

fn query(text: &str) -> Query {
    Query::new(&Command::default(), text)
}
fn snapshot(q: &Query, n: usize, time: i64) -> SearchSnapshot {
    SearchSnapshot {
        request_id: oas_domain::id(),
        id: oas_domain::id(),
        question: q.id(),
        query: q.clone(),
        source: oas_domain::BROWSER_SEARCH.into(),
        call_id: oas_domain::id(),
        collected_at: time,
        acquisition_order: 0,
        expires_at: time + 1800000,
        hits: (0..n)
            .map(|i| Hit {
                url: format!("https://example.org/{i}"),
                title: format!("Page {i}"),
                snippet: "Evidence".into(),
                summary: None,
                cached_summary_key: None,
                cache: None,
                published_at: None,
                coverage: Coverage::Unknown,
                content: None,
                rank: i + 1,
                variant_id: "Q0".into(),
                call_id: oas_domain::id(),
            })
            .collect(),
        partial: false,
        engine_answer: None,
        cards: vec![],
    }
}
#[test]
fn raw_admission_is_independent_of_display_count_and_per_item_summary() {
    let q = query("rust cache");
    let handler = V1CacheHandler;
    let settings = CacheSettings::from_env().unwrap();
    let mut four = snapshot(&q, 4, 10);
    four.hits[0].summary = Some("Long source summary".into());
    assert!(
        handler
            .retention(Acquired::Search(&four), &settings)
            .is_none()
    );
    let five = snapshot(&q, 5, 10);
    assert!(
        handler
            .retention(Acquired::Search(&five), &settings)
            .is_some()
    );
    four.engine_answer =
        Some(json!({"provider":"google","content":"A completed answer","sources":[]}));
    assert!(
        handler
            .retention(Acquired::Search(&four), &settings)
            .is_some()
    );
    let mut duplicate = snapshot(&q, 5, 10);
    for hit in &mut duplicate.hits {
        hit.url = "https://example.org/same".into();
    }
    assert!(
        handler
            .retention(Acquired::Search(&duplicate), &settings)
            .is_none()
    );
}
#[test]
fn same_question_snapshots_count_once_and_exact_self_is_exempt() {
    let q = query("rust cache");
    let handler = V1CacheHandler;
    let selected = handler.lookup(
        &q,
        &[Recall {
            question: q.id(),
            cosine: 1.0,
            lexical: 0.8,
            ..Default::default()
        }],
        vec![
            snapshot(&q, 5, 10),
            snapshot(&q, 5, 30),
            snapshot(&q, 5, 20),
        ],
        0.92,
    );
    assert_eq!(selected.questions, vec![q.id()]);
    assert!(selected.exact);
    assert!(!selected.search_needed);
    assert_eq!(selected.snapshots.len(), 2);
    assert_eq!(selected.snapshots[0].collected_at, 30);
    assert_eq!(selected.snapshots[1].collected_at, 20);
}
#[test]
fn similar_single_hit_searches_again_and_two_questions_use_all_materials() {
    let q = query("rust cache");
    let a = query("rust caching guide");
    let b = query("rust cache tutorial");
    let recall = vec![
        Recall {
            question: a.id(),
            cosine: 0.98,
            lexical: 0.1,
            ..Default::default()
        },
        Recall {
            question: b.id(),
            cosine: 0.96,
            lexical: 0.9,
            ..Default::default()
        },
    ];
    let handler = V1CacheHandler;
    let one = handler.lookup(&q, &recall, vec![snapshot(&a, 10, 10)], 0.92);
    assert!(one.search_needed);
    assert!(!one.exact);
    let two = handler.lookup(
        &q,
        &recall,
        vec![snapshot(&a, 10, 10), snapshot(&b, 10, 20)],
        0.92,
    );
    assert!(!two.search_needed);
    assert_eq!(two.questions.len(), 2);
    assert_eq!(
        two.snapshots.iter().map(|s| s.hits.len()).sum::<usize>(),
        20
    );
}
#[test]
fn incompatible_conditions_and_low_confidence_never_reuse_materials() {
    let q = query("rust cache");
    let mut other = query("rust cache guide");
    other.time_range = Some("day".into());
    let recall = [Recall {
        question: other.id(),
        cosine: 0.99,
        lexical: 1.0,
        ..Default::default()
    }];
    let handler = V1CacheHandler;
    assert!(
        handler
            .lookup(&q, &recall, vec![snapshot(&other, 10, 1)], 0.92)
            .snapshots
            .is_empty()
    );
    let other = query("rust cache guide");
    assert!(
        handler
            .lookup(
                &q,
                &[Recall {
                    question: other.id(),
                    cosine: 0.91,
                    lexical: 1.0,
                    ..Default::default()
                }],
                vec![snapshot(&other, 10, 1)],
                0.92
            )
            .snapshots
            .is_empty()
    );
}
#[test]
fn multilingual_terms_keep_identifiers_and_dense_vectors_require_same_dimension() {
    let terms = terms("Rust 缓存如何刷新 HTTP 404");
    assert!(terms.contains("rust"));
    assert!(terms.contains("缓存"));
    assert!(terms.contains("404"));
    assert_eq!(cosine(&[1.0, 0.0], &[1.0, 0.0]), 1.0);
    assert_eq!(cosine(&[1.0], &[1.0, 0.0]), 0.0);
}

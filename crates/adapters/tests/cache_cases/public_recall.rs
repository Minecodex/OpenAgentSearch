use super::*;
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Instant,
};

/// Run against disposable Qdrant/PostgreSQL and the local encoder prepared by
/// tests/cache-public-corpus.py. Each project contains only judged candidates.
#[tokio::test]
#[ignore = "requires public corpora and a local multilingual embedding model"]
async fn public_labeled_question_recall() {
    let dir = std::path::PathBuf::from(std::env::var("OAS_CACHE_BENCH_DIRECTORY").unwrap());
    let corpus: Value =
        serde_json::from_slice(&std::fs::read(dir.join("questions.json")).unwrap()).unwrap();
    let f = Fixture::new().await;
    let mut samples = vec![];
    let mut metrics = BTreeMap::<String, [usize; 7]>::new();
    let mut reviewed = BTreeMap::<String, (usize, usize, usize, usize)>::new();
    let mut timeouts = BTreeMap::<String, usize>::new();
    let mut times = vec![];
    let mut indexing_retries = 0;
    for (i, group) in corpus["groups"].as_array().unwrap().iter().enumerate() {
        let new=f.repo.save("projects",None,json!({"name":format!("Public recall {i}"),
            "search_pools":[[BROWSER_SEARCH]],"reader_pools":[[BROWSER_READER]],"rewrite_count":0,"cache_enabled":true})).await.unwrap();
        let scope = Scope::from_project(&serde_json::from_value(new["project"].clone()).unwrap());
        let mut positives = BTreeSet::new();
        for category in ["positive", "negative"] {
            for item in group[category].as_array().unwrap() {
                let mut s = snapshot(item.as_str().unwrap(), now(), 5);
                if f.service.handler.matcher().is_some() {
                    s.query.language = Some(group["language"].as_str().unwrap().to_owned());
                    s.question = s.query.id();
                    // The public labels describe question pairs, not actual web result sets.
                    // Use the historical title as the only substantive representative material.
                    for h in &mut s.hits {
                        h.title = oas_domain::truncate(item.as_str().unwrap(), 160);
                        h.snippet.clear();
                    }
                }
                if category == "positive" {
                    positives.insert(s.question.clone());
                }
                assert_eq!(
                    f.service.acquire_search(&scope, s.clone()).await.unwrap(),
                    WriteReceipt::Published
                );
                // Index publication has the same bounded retry allowance as ordinary jobs.
                for attempt in 1..=f.service.settings.max_attempts {
                    match f.service.index_search(&scope, &s).await {
                        Ok(true) => break,
                        Err(e) if attempt < f.service.settings.max_attempts => {
                            indexing_retries += 1;
                            eprintln!(
                                "retrying index publication for group {i}, attempt {attempt}: {}",
                                e.code
                            );
                            tokio::time::sleep(std::time::Duration::from_secs(attempt as u64))
                                .await;
                        }
                        other => panic!("index publication for group {i} failed: {other:?}"),
                    }
                }
            }
        }
        let mut q = Query::new(&Command::default(), group["query"].as_str().unwrap());
        if f.service.handler.matcher().is_some() {
            q.language = Some(group["language"].as_str().unwrap().to_owned());
        }
        let started = Instant::now();
        let found = f
            .service
            .lookup(&scope, &q, &id(), &id(), f.service.lookup_deadline())
            .await;
        let elapsed = started.elapsed().as_millis() as u64;
        let lang = group["language"].as_str().unwrap();
        let mut reviewed_correct = None;
        if let Some(matcher) = f.service.handler.matcher() {
            let trace = found.verification.as_ref().expect("v2 verification trace");
            assert_eq!(trace.profile, matcher.profile());
            let review = reviewed.entry(lang.to_owned()).or_default();
            review.2 += positives.len();
            if found.bypass || found.degraded {
                assert!(
                    matches!(
                        trace.reason.as_deref(),
                        Some("DEADLINE_EXCEEDED" | "CACHE_LOOKUP_TIMEOUT")
                    ),
                    "unexpected fallback in group {i}: {trace:?}"
                );
                *timeouts.entry(lang.to_owned()).or_default() += 1;
            } else {
                let correct = trace
                    .shortlisted_question_ids
                    .iter()
                    .filter(|id| positives.contains(*id))
                    .count();
                review.0 += usize::from(!trace.shortlisted_question_ids.is_empty());
                review.3 += usize::from(!trace.decisions.is_empty());
                review.1 += correct;
                reviewed_correct = Some(correct);
            }
        } else {
            assert!(
                !found.bypass && !found.degraded,
                "index dependency failed at group {i}"
            );
        }
        let selected: BTreeSet<_> = found.questions.into_iter().collect();
        let correct = selected.intersection(&positives).count();
        let m = metrics.entry(lang.into()).or_default();
        m[0] += 1;
        m[1] += positives.len();
        m[2] += selected.len();
        m[3] += correct;
        m[4] += usize::from(selected.len() == 2 && correct < 2);
        m[5] += usize::from(positives.len() == 2 && correct < 2);
        m[6] += usize::from(positives.len() == 2);
        times.push(elapsed);
        samples.push(json!({"group":i,"language":lang,"expected":positives.len(),"selected":selected.len(),"correct":correct,"lookup_ms":elapsed,"reviewed_correct":reviewed_correct,"verification":found.verification}));
    }
    times.sort_unstable();
    let quantile = |p: usize| times[(p * times.len()).div_ceil(100) - 1];
    let by_language = metrics
        .into_iter()
        .map(|(lang, m)| {
            (
                lang,
                json!({"groups":m[0],"relevant":m[1],"returned":m[2],"correct":m[3],
        "precision":(m[2]>0).then(||m[3] as f64/m[2] as f64),"recall":m[3] as f64/m[1] as f64,
        "false_double_hits":m[4],"missed_double_hits":m[5],"expected_double_hits":m[6]}),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let reviewed_by_language: BTreeMap<_, _> = reviewed
        .into_iter()
        .map(|(lang, (batches, correct, relevant, scored))| {
            assert!(batches > 0, "no completed matcher requests for {lang}");
            let timed_out = timeouts.get(&lang).copied().unwrap_or(0);
            (
                lang,
                json!({"completed_matcher_batches":batches, "scored_model_batches":scored, "timed_out_lookups":timed_out,
            "relevant":relevant, "shortlisted_positives":correct,
            "shortlist_recall_at_8":(relevant>0).then(||correct as f64/relevant as f64)}),
            )
        })
        .collect();
    let report = json!({"model_revision":corpus["model_revision"],"ubuntu_revision":corpus["ubuntu_revision"],"lcqmc_revision":corpus["lcqmc_revision"],
        "indexing_retries":indexing_retries,"handler":f.service.binding.handler,"threshold":if f.service.handler.matcher().is_none(){Some(f.service.settings.threshold)}else{None},"matcher_profile":f.service.handler.matcher().map(|m|m.profile()),"reviewed_by_language":reviewed_by_language,"by_language":by_language,"p50_ms":quantile(50),"p95_ms":quantile(95),"p99_ms":quantile(99),"samples":samples});
    std::fs::write(
        dir.join(if f.service.handler.matcher().is_some() {
            "verified-public-recall.json"
        } else {
            "public-recall.json"
        }),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    f.close().await;
}

use super::handler::{CacheHandler, Groups, Selection, assemble, group_snapshots};
use super::now;
use super::ports::ReuseMatcher;
use async_trait::async_trait;
use oas_domain::{Hit, Result, cache::*};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

const SHORTLIST: usize = 8;
const REPRESENTATIVES: usize = 3;
const RRF_K: f64 = 60.0;

pub struct V2CacheHandler {
    matcher: Arc<dyn ReuseMatcher>,
}
impl V2CacheHandler {
    pub fn new(matcher: Arc<dyn ReuseMatcher>) -> Self {
        Self { matcher }
    }
}
fn fusion(recall: &[Recall]) -> Vec<&str> {
    let mut ranked = recall
        .iter()
        .filter_map(|r| {
            let score = [r.dense_rank, r.lexical_rank]
                .into_iter()
                .flatten()
                .filter(|v| *v > 0)
                .map(|rank| 1.0 / (RRF_K + rank as f64))
                .sum::<f64>();
            (score > 0.0).then_some((r.question.as_str(), score))
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|(a, x), (b, y)| y.total_cmp(x).then(a.cmp(b)));
    ranked.into_iter().map(|(id, _)| id).collect()
}

fn representatives(snapshot: &SearchSnapshot) -> Vec<(&Hit, String)> {
    let mut hits = snapshot.hits.iter().collect::<Vec<_>>();
    hits.sort_by_key(|h| h.rank);
    let mut seen = BTreeSet::new();
    hits.into_iter()
        .filter_map(|h| {
            let key = page_key(&h.url, false)?;
            seen.insert(key.clone()).then_some((h, key))
        })
        .take(REPRESENTATIVES)
        .collect()
}
fn material(hit: &Hit, summary: Option<&String>) -> MatchMaterial {
    MatchMaterial {
        title: oas_domain::truncate(&hit.title, 160),
        snippet: oas_domain::truncate(&hit.snippet, 320),
        summary: hit
            .summary
            .as_ref()
            .filter(|s| !s.trim().is_empty())
            .or(summary)
            .filter(|s| !s.trim().is_empty())
            .map(|s| oas_domain::truncate(s, 320)),
    }
}

/// Keep the exact snapshot identities used for a verdict so it cannot be
/// transferred to an unreviewed refresh during remote inference.
#[derive(PartialEq, Eq)]
struct Evidence {
    packet: MatchCandidate,
    snapshots: Vec<String>,
}
async fn evidence(
    input: &Selection<'_>,
    groups: &mut Groups,
) -> Result<BTreeMap<String, Evidence>> {
    let exact_id = input.query.id();
    let keys = groups
        .iter()
        .filter(|(id, _)| **id != exact_id)
        .flat_map(|(_, ss)| ss.iter())
        .flat_map(representatives)
        .filter(|(hit, _)| hit.summary.as_ref().is_none_or(|s| s.trim().is_empty()))
        .map(|(_, key)| key)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let mut summaries = BTreeMap::new();
    if !keys.is_empty() && input.scope.summary_version.is_some() {
        for page in input
            .metadata
            .pages(input.scope, input.binding, &keys, now())
            .await?
        {
            if page.summary_version == input.scope.summary_version
                && let Some(summary) = page.summary
            {
                summaries.insert(page.key, summary);
            }
        }
    }
    let mut result = BTreeMap::new();
    for (id, snapshots) in groups.iter_mut().filter(|(id, _)| **id != exact_id) {
        let mut lists = vec![];
        snapshots.retain(|snapshot| {
            let items = representatives(snapshot)
                .into_iter()
                .map(|(hit, key)| {
                    let m = material(hit, summaries.get(&key));
                    (key, m)
                })
                .filter(|(_, m)| {
                    !m.title.is_empty() || !m.snippet.is_empty() || m.summary.is_some()
                })
                .collect::<Vec<_>>();
            let fields = items.iter().flat_map(|(_, m)| {
                [
                    m.title.as_str(),
                    m.snippet.as_str(),
                    m.summary.as_deref().unwrap_or(""),
                ]
            });
            if items.is_empty() || !input.query.supported_by(&snapshot.query, fields) {
                return false;
            }
            lists.push(items);
            true
        });
        let Some(first) = snapshots.first() else {
            continue;
        };
        let mut materials = vec![];
        let mut seen = BTreeSet::new();
        for position in 0..REPRESENTATIVES {
            for list in &lists {
                if let Some((key, m)) = list.get(position)
                    && seen.insert(key)
                    && materials.len() < REPRESENTATIVES
                    && !materials.contains(m)
                {
                    materials.push(m.clone());
                }
            }
        }
        let fields = materials.iter().flat_map(|m| {
            [
                m.title.as_str(),
                m.snippet.as_str(),
                m.summary.as_deref().unwrap_or(""),
            ]
        });
        if input.query.supported_by(&first.query, fields) {
            result.insert(
                id.clone(),
                Evidence {
                    packet: MatchCandidate {
                        question_id: id.clone(),
                        question: first.query.text.clone(),
                        materials,
                    },
                    snapshots: snapshots.iter().map(|s| s.id.clone()).collect(),
                },
            );
        }
    }
    Ok(result)
}
fn accepted(
    response: &MatchResponse,
    profile: &str,
    candidates: &[MatchCandidate],
) -> Result<Vec<String>> {
    let valid_score = |v: f64| v.is_finite() && (0.0..=1.0).contains(&v);
    let order: BTreeMap<_, _> = candidates
        .iter()
        .enumerate()
        .map(|(i, c)| (c.question_id.as_str(), i))
        .collect();
    let mut seen = BTreeSet::new();
    if response.profile != profile {
        return Err(oas_domain::Error::new(
            "CACHE_MATCHER_PROFILE_MISMATCH",
            503,
            "匹配器配置指纹不同。",
            "The matcher profile does not match the request.",
        ));
    }
    if response.threshold.is_none() && response.decisions.is_empty() {
        return Ok(vec![]);
    }
    if response.decisions.len() != candidates.len()
        || response.threshold.is_some_and(|t| !valid_score(t))
        || response.decisions.iter().any(|d| {
            !valid_score(d.reusable_score)
                || !order.contains_key(d.question_id.as_str())
                || !seen.insert(&d.question_id)
        })
    {
        return Err(oas_domain::Error::new(
            "CACHE_MATCHER_PROTOCOL",
            503,
            "匹配器响应与固定配置或候选不一致。",
            "The matcher response does not match its pinned profile or candidates.",
        ));
    }
    let Some(cutoff) = response.threshold else {
        return Ok(vec![]);
    };
    let mut approved = response
        .decisions
        .iter()
        .filter(|d| d.label == ReuseLabel::Reusable && d.reusable_score >= cutoff)
        .collect::<Vec<_>>();
    approved.sort_by(|a, b| {
        b.reusable_score
            .total_cmp(&a.reusable_score)
            .then(order[a.question_id.as_str()].cmp(&order[b.question_id.as_str()]))
    });
    Ok(approved
        .into_iter()
        .map(|d| d.question_id.clone())
        .collect())
}

#[async_trait]
impl CacheHandler for V2CacheHandler {
    fn version(&self) -> &str {
        "v2"
    }
    fn matcher(&self) -> Option<&dyn ReuseMatcher> {
        Some(self.matcher.as_ref())
    }
    async fn select(&self, input: Selection<'_>, snapshots: Vec<SearchSnapshot>) -> Result<Lookup> {
        let exact = input.query.id();
        let mut groups = group_snapshots(input.query, snapshots, self.snapshots_per_question());
        let original = evidence(&input, &mut groups).await?;
        let candidates = fusion(input.recall)
            .into_iter()
            .filter_map(|id| original.get(id).map(|g| g.packet.clone()))
            .take(SHORTLIST)
            .collect::<Vec<_>>();
        let profile = self.matcher.profile();
        let mut trace = VerificationTrace {
            profile: profile.into(),
            state: "no_candidates",
            shortlisted_question_ids: candidates.iter().map(|c| c.question_id.clone()).collect(),
            question_texts: candidates
                .iter()
                .map(|c| (c.question_id.clone(), c.question.clone()))
                .collect(),
            elapsed_ms: None,
            reason: None,
            threshold: None,
            decisions: vec![],
        };
        let mut approved = vec![];
        if !candidates.is_empty() {
            if !input.metadata.valid(input.scope, input.binding).await? {
                return Err(oas_domain::Error::cancelled());
            }
            let started = tokio::time::Instant::now();
            let mut response = self
                .matcher
                .classify(
                    input.query,
                    &candidates,
                    input.embedding_version,
                    input.deadline,
                )
                .await?;
            trace.elapsed_ms = Some(started.elapsed().as_millis() as u64);
            approved = accepted(&response, profile, &candidates)?;
            // Calibration applies to the original top one/two only. A late
            // withdrawal cannot promote a different candidate into that decision.
            approved.truncate(2 - usize::from(groups.contains_key(&exact)));
            trace.state = if response.threshold.is_some() {
                "verified"
            } else {
                "uncalibrated"
            };
            trace.threshold = response.threshold;
            response.decisions.sort_by_key(|d| {
                candidates
                    .iter()
                    .position(|c| c.question_id == d.question_id)
            });
            trace.decisions = response.decisions;
            let mut selected = approved.clone();
            if groups.contains_key(&exact) {
                selected.push(exact.clone());
            }
            let fresh = input
                .metadata
                .snapshots(
                    input.scope,
                    input.binding,
                    &selected,
                    &exact,
                    self.snapshots_per_question(),
                    now(),
                )
                .await?;
            groups = group_snapshots(input.query, fresh, self.snapshots_per_question());
            let current = evidence(&input, &mut groups).await?;
            let before = approved.len();
            approved.retain(|id| {
                current
                    .get(id)
                    .is_some_and(|packet| Some(packet) == original.get(id))
            });
            if approved.len() != before {
                trace.state = "material_changed";
            }
        }
        let mut ids = vec![];
        if groups.contains_key(&exact) {
            ids.push(exact);
        }
        ids.extend(approved.into_iter().take(2 - ids.len()));
        let mut result = assemble(input.query, ids, groups);
        result.verification = Some(trace);
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fusion_uses_each_lane_once_without_a_cosine_floor() {
        let r = |s: &str, d, l, c| Recall {
            question: s.into(),
            dense_rank: d,
            lexical_rank: l,
            cosine: c,
            ..Default::default()
        };
        let rows = [
            r("dense", Some(1), None, 0.99),
            r("both", Some(8), Some(3), 0.5),
            r("words", None, Some(1), 0.1),
        ];
        assert_eq!(fusion(&rows), ["both", "dense", "words"]);
    }
    #[test]
    fn only_complete_versioned_batch_decisions_can_authorize_reuse() {
        let packet = |s: &str| MatchCandidate {
            question_id: s.into(),
            question: s.into(),
            materials: vec![],
        };
        let candidates = [packet("alpha"), packet("beta")];
        let score = |s: &str, label, v| MatchScore {
            question_id: s.into(),
            label,
            reusable_score: v,
        };
        let mut resp = MatchResponse {
            profile: "p".into(),
            threshold: Some(0.8),
            decisions: vec![
                score("beta", ReuseLabel::Conflict, 0.99),
                score("alpha", ReuseLabel::Reusable, 0.85),
            ],
        };
        assert_eq!(accepted(&resp, "p", &candidates).unwrap(), ["alpha"]);
        assert!(accepted(&resp, "other", &candidates).is_err());
        resp.threshold = None;
        assert!(accepted(&resp, "p", &candidates).unwrap().is_empty());
        resp.decisions[1].question_id = "beta".into();
        assert!(accepted(&resp, "p", &candidates).is_err());
        resp.decisions.clear();
        assert!(accepted(&resp, "p", &candidates).unwrap().is_empty());
        resp.threshold = Some(0.8);
        assert!(accepted(&resp, "p", &candidates).is_err());
    }
}

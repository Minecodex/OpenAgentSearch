use super::ports::*;
use async_trait::async_trait;
use oas_domain::{Result, cache::*};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

pub struct Selection<'a> {
    pub query: &'a Query,
    pub recall: &'a [Recall],
    pub metadata: &'a dyn Metadata,
    pub scope: &'a Scope,
    pub binding: &'a Binding,
    pub legacy_threshold: f32,
    pub deadline: tokio::time::Instant,
    pub embedding_version: &'a str,
}

/// Handlers select sources. The service owns deadlines, authorization and publication.
#[async_trait]
pub trait CacheHandler: Send + Sync {
    fn version(&self) -> &str;
    fn schema_version(&self) -> i32 {
        1
    }
    fn payload_version(&self) -> i32 {
        1
    }
    fn matcher(&self) -> Option<&dyn ReuseMatcher> {
        None
    }
    async fn select(&self, input: Selection<'_>, snapshots: Vec<SearchSnapshot>) -> Result<Lookup>;
    fn recall_limit(&self) -> usize {
        20
    }
    fn rank_score(&self, cosine: Option<f32>, lexical: f32, rank: usize) -> f32 {
        let reciprocal = 1.0 / rank.max(1) as f32;
        cosine.map_or(0.8 * lexical + 0.2 * reciprocal, |v| {
            0.75 * v.max(0.0) + 0.20 * lexical + 0.05 * reciprocal
        })
    }
    fn snapshots_per_question(&self) -> usize {
        2
    }
    fn hot_slots(&self, policy: &HotPolicy, total: usize, recent: bool) -> usize {
        policy.slots(total, usize::MAX, recent)
    }
    fn retention(&self, material: Acquired<'_>, settings: &super::CacheSettings) -> Option<i64> {
        match material {
            Acquired::Search(snapshot) => snapshot.admissible().then_some(settings.list_ttl),
            Acquired::Page(page) => {
                (!page.markdown.trim().is_empty()).then_some(settings.content_ttl)
            }
        }
    }
    fn on_selected(&self, page: SelectedPage<'_>) -> Option<JobPlan> {
        let mut input = json!({"url":page.url});
        let (kind, reason) = if let Some(current) = page.existing {
            if current.summary.is_some()
                && current.summary_version.as_deref() == page.summary_version
            {
                return None;
            }
            input["hash"] = json!(current.content_hash);
            ("summary", "selected_summary")
        } else if page.acquired {
            ("summary", "selected_summary")
        } else {
            ("content", "selected_page")
        };
        Some(JobPlan {
            kind: kind.into(),
            target: page.key.into(),
            reason: reason.into(),
            input,
            object_epoch: page.object_epoch,
        })
    }
    fn on_expired(
        &self,
        kind: &str,
        target: &str,
        epoch: i64,
        input: serde_json::Value,
    ) -> JobPlan {
        JobPlan {
            kind: kind.into(),
            target: target.into(),
            reason: "hot_expiry".into(),
            input,
            object_epoch: epoch,
        }
    }
    fn execute_job(&self, task: &Task) -> Result<JobPlan> {
        if task.payload_version != self.payload_version() || task.binding.handler != self.version()
        {
            return Err(oas_domain::Error::invalid("handler_version"));
        }
        Ok(task.plan.clone())
    }
}

pub struct V1CacheHandler;
#[async_trait]
impl CacheHandler for V1CacheHandler {
    fn version(&self) -> &str {
        "v1"
    }
    async fn select(&self, input: Selection<'_>, snapshots: Vec<SearchSnapshot>) -> Result<Lookup> {
        Ok(self.lookup(input.query, input.recall, snapshots, input.legacy_threshold))
    }
}
impl V1CacheHandler {
    pub fn lookup(
        &self,
        query: &Query,
        recall: &[Recall],
        snapshots: Vec<SearchSnapshot>,
        threshold: f32,
    ) -> Lookup {
        let mut grouped = group_snapshots(query, snapshots, self.snapshots_per_question());
        for group in grouped.values_mut() {
            group.retain(|s| {
                query.supported_by(
                    &s.query,
                    s.hits.iter().flat_map(|h| {
                        [
                            h.title.as_str(),
                            h.snippet.as_str(),
                            h.summary.as_deref().unwrap_or(""),
                        ]
                    }),
                )
            });
        }
        grouped.retain(|_, s| !s.is_empty());
        let mut questions = recall
            .iter()
            .filter(|r| r.cosine >= threshold && grouped.contains_key(&r.question))
            .collect::<Vec<_>>();
        questions.sort_by(|a, b| {
            b.cosine
                .total_cmp(&a.cosine)
                .then(b.lexical.total_cmp(&a.lexical))
                .then(a.question.cmp(&b.question))
        });
        let mut seen = BTreeSet::new();
        questions.retain(|r| seen.insert(r.question.clone()));
        questions.truncate(2);
        let ids = questions
            .iter()
            .map(|r| r.question.clone())
            .collect::<Vec<_>>();
        assemble(query, ids, grouped)
    }
}

pub(super) type Groups = BTreeMap<String, Vec<SearchSnapshot>>;
pub(super) fn group_snapshots(
    query: &Query,
    snapshots: Vec<SearchSnapshot>,
    limit: usize,
) -> Groups {
    let exact = query.id();
    let mut grouped = Groups::new();
    for s in snapshots {
        if (!s.hits.is_empty() || s.question == exact && s.engine_answer.is_some())
            && s.query.compatible(query)
        {
            grouped.entry(s.question.clone()).or_default().push(s);
        }
    }
    for values in grouped.values_mut() {
        values.sort_by(|a, b| {
            b.collected_at
                .cmp(&a.collected_at)
                .then(b.acquisition_order.cmp(&a.acquisition_order))
                .then(a.id.cmp(&b.id))
        });
        values.truncate(limit);
    }
    grouped
}
pub(super) fn assemble(query: &Query, ids: Vec<String>, mut grouped: Groups) -> Lookup {
    let exact = ids.len() == 1 && ids[0] == query.id();
    let selected = ids
        .iter()
        .filter_map(|id| grouped.remove(id))
        .flatten()
        .collect();
    Lookup {
        search_needed: ids.len() == 1 && !exact,
        questions: ids,
        snapshots: selected,
        exact,
        ..Default::default()
    }
}
pub(super) fn exact_lookup(query: &Query, snapshots: Vec<SearchSnapshot>, limit: usize) -> Lookup {
    let grouped = group_snapshots(query, snapshots, limit);
    let id = query.id();
    let ids = if grouped.contains_key(&id) {
        vec![id]
    } else {
        vec![]
    };
    assemble(query, ids, grouped)
}

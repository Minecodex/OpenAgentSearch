use super::{handler::*, ports::*};
use oas_domain::{Hit, Result, cache::*};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};
use tokio::time::{Instant, timeout_at};

#[derive(Clone)]
pub struct CacheSettings {
    pub lookup_ms: u64,
    pub list_ttl: i64,
    pub content_ttl: i64,
    pub threshold: f32,
    pub summary_tokens: usize,
    pub max_attempts: i32,
    pub task_ttl: i64,
    pub queue_capacity: i64,
}
impl CacheSettings {
    pub fn from_env() -> Result<Self> {
        fn number<T: std::str::FromStr>(key: &str, default: &str) -> Result<T> {
            std::env::var(key)
                .unwrap_or_else(|_| default.into())
                .parse()
                .map_err(|_| oas_domain::Error::invalid(key))
        }
        let v = Self {
            lookup_ms: number("OAS_CACHE_LOOKUP_TIMEOUT_MS", "2000")?,
            list_ttl: number("OAS_CACHE_LIST_TTL_SECS", "1800")?,
            content_ttl: number("OAS_CACHE_CONTENT_TTL_SECS", "21600")?,
            threshold: number("OAS_CACHE_MATCH_THRESHOLD", "0.92")?,
            summary_tokens: number("OAS_CACHE_SUMMARY_MAX_INPUT_TOKENS", "8192")?,
            max_attempts: number("OAS_CACHE_TASK_MAX_ATTEMPTS", "3")?,
            task_ttl: number("OAS_CACHE_TASK_TTL_SECS", "1800")?,
            queue_capacity: number("OAS_CACHE_QUEUE_CAPACITY", "1024")?,
        };
        if v.lookup_ms == 0
            || v.list_ttl <= 0
            || v.content_ttl <= 0
            || v.summary_tokens == 0
            || v.max_attempts <= 0
            || v.task_ttl <= 0
            || v.queue_capacity <= 0
            || !v.threshold.is_finite()
            || !(0.0..=1.0).contains(&v.threshold)
        {
            return Err(oas_domain::Error::invalid("cache_settings"));
        }
        Ok(v)
    }
}
pub struct CacheService {
    pub metadata: Arc<dyn Metadata>,
    pub index: Arc<dyn QueryIndex>,
    pub embedding: Arc<dyn Embedding>,
    pub objects: Arc<dyn Objects>,
    pub handler: Arc<dyn CacheHandler>,
    pub binding: Binding,
    pub settings: CacheSettings,
}
impl CacheService {
    pub fn lookup_deadline(&self) -> Instant {
        Instant::now() + Duration::from_millis(self.settings.lookup_ms)
    }
    pub async fn lookup(
        &self,
        scope: &Scope,
        query: &Query,
        request: &str,
        lookup: &str,
        deadline: Instant,
    ) -> Lookup {
        let mut failure = None;
        let outcome = timeout_at(deadline, async {
            if !self.metadata.valid(scope, &self.binding).await? {
                return Ok::<_, oas_domain::Error>(Lookup {
                    bypass: true,
                    ..Default::default()
                });
            }
            self.remember_query(scope, query);
            let reserve = Duration::from_millis((self.settings.lookup_ms / 5).min(200));
            let normal = timeout_at(deadline - reserve, async {
                if !self
                    .metadata
                    .index_ready(&self.binding, self.embedding.version())
                    .await?
                {
                    return Err(oas_domain::Error::unavailable());
                }
                let vectors = self
                    .embedding
                    .encode(std::slice::from_ref(&query.text))
                    .await?;
                let vector = vectors
                    .into_iter()
                    .next()
                    .ok_or_else(oas_domain::Error::unavailable)?;
                let recall = self
                    .index
                    .recall(
                        scope,
                        &self.binding,
                        query,
                        &vector,
                        self.handler.recall_limit(),
                    )
                    .await?;
                let mut ids = recall
                    .iter()
                    .map(|r| r.question.clone())
                    .collect::<Vec<_>>();
                let exact_id = query.id();
                let pin_exact = self.handler.matcher().is_some() && !ids.contains(&exact_id);
                if pin_exact {
                    ids.push(exact_id.clone());
                }
                let mut snapshots = self
                    .metadata
                    .snapshots(
                        scope,
                        &self.binding,
                        &ids,
                        &query.id(),
                        self.handler.snapshots_per_question(),
                        now(),
                    )
                    .await?;
                if pin_exact
                    && snapshots.iter().any(|s| s.question == exact_id)
                    && !self.index.exists(scope, &self.binding, &exact_id).await?
                {
                    snapshots.retain(|s| s.question != exact_id);
                }
                let input = Selection {
                    query,
                    recall: &recall,
                    metadata: self.metadata.as_ref(),
                    scope,
                    binding: &self.binding,
                    legacy_threshold: self.settings.threshold,
                    embedding_version: self.embedding.version(),
                    deadline: deadline - reserve,
                };
                let mut found = self.handler.select(input, snapshots).await?;
                let hits = Self::lookup_hits(&found, lookup);
                found.ranked = self
                    .rank(scope, &query.text, hits, Some(vector.clone()), deadline)
                    .await;
                let _ =
                    timeout_at(deadline, self.summaries(scope, &mut found.ranked, request)).await;
                if self.handler.matcher().is_some()
                    && !found.questions.is_empty()
                    && (found.snapshots.iter().any(|s| s.expires_at <= now())
                        || !self.metadata.valid(scope, &self.binding).await?)
                {
                    return Err(oas_domain::Error::cancelled());
                }
                found.vector = Some(vector);
                if !found.snapshots.is_empty()
                    && found.ranked.is_empty()
                    && !found
                        .snapshots
                        .iter()
                        .any(|s| s.question == query.id() && s.engine_answer.is_some())
                {
                    return Err(oas_domain::Error::unavailable());
                }
                Ok::<_, oas_domain::Error>(found)
            })
            .await;
            failure = Some(match normal {
                Ok(Ok(value)) => return Ok(value),
                Ok(Err(error)) => error.code,
                Err(_) => String::from("CACHE_LOOKUP_TIMEOUT"),
            });
            if self.index.exists(scope, &self.binding, &query.id()).await? {
                let snapshots = self
                    .metadata
                    .snapshots(
                        scope,
                        &self.binding,
                        &[query.id()],
                        &query.id(),
                        self.handler.snapshots_per_question(),
                        now(),
                    )
                    .await?;
                let mut result =
                    exact_lookup(query, snapshots, self.handler.snapshots_per_question());
                // Exact fallback already read permission- and status-filtered
                // metadata. It must not start a second embedding call.
                result.ranked = self.lexical_rank(&query.text, Self::lookup_hits(&result, lookup));
                result.degraded = true;
                result.bypass = result.snapshots.is_empty();
                return Ok(result);
            }
            Ok(Lookup {
                bypass: true,
                ..Default::default()
            })
        })
        .await;
        let mut result = outcome
            .ok()
            .and_then(std::result::Result::ok)
            .unwrap_or_else(|| Lookup {
                bypass: true,
                ..Default::default()
            });
        if result.verification.is_none()
            && let Some(matcher) = self.handler.matcher()
        {
            result.verification = Some(VerificationTrace {
                profile: matcher.profile().into(),
                state: "fallback",
                shortlisted_question_ids: vec![],
                question_texts: Default::default(),
                elapsed_ms: None,
                reason: Some(failure.unwrap_or_else(|| "CACHE_LOOKUP_UNAVAILABLE".into())),
                threshold: None,
                decisions: vec![],
            });
        }
        let kind = if result.bypass {
            "bypass"
        } else if result.degraded {
            "degraded_exact"
        } else if result.questions.len() == 2 {
            "h2"
        } else if result.exact {
            "h1_exact"
        } else if result.questions.len() == 1 {
            "h1_search"
        } else {
            "h0"
        };
        let _ = timeout_at(
            deadline,
            self.usage(scope, request, lookup, "lookup", lookup, kind),
        )
        .await;
        for q in &result.questions {
            let _ = timeout_at(
                deadline,
                self.usage(scope, request, lookup, "list", q, "reference"),
            )
            .await;
        }
        if result.search_needed {
            let plan = JobPlan {
                kind: "list".into(),
                target: query.id(),
                reason: "similar_single_hit".into(),
                input: json!({"query":query}),
                object_epoch: 0,
            };
            let _ = timeout_at(deadline, self.enqueue(scope, &plan, request)).await;
        }
        result
    }
    pub async fn usage(
        &self,
        scope: &Scope,
        request: &str,
        lookup: &str,
        kind: &str,
        object: &str,
        outcome: &str,
    ) {
        let event = Usage {
            event_id: point_id(&format!("{request}/{kind}/{object}")),
            request: request.into(),
            lookup: lookup.into(),
            project: scope.project.clone(),
            kind: kind.into(),
            object: object.into(),
            outcome: outcome.into(),
            at: now(),
        };
        let _ = tokio::time::timeout(Duration::from_millis(15), self.metadata.record(&event)).await;
    }
    pub async fn enqueue(&self, scope: &Scope, plan: &JobPlan, parent: &str) {
        let _ = tokio::time::timeout(
            Duration::from_millis(40),
            self.metadata.enqueue(scope, &self.binding, plan, parent),
        )
        .await;
    }
    pub fn remember_query(&self, scope: &Scope, query: &Query) {
        let (metadata, scope, query) = (self.metadata.clone(), scope.clone(), query.clone());
        tokio::spawn(async move {
            let _ = tokio::time::timeout(
                Duration::from_millis(100),
                metadata.register(&scope, &query),
            )
            .await;
        });
    }

    fn expiry(&self, material: Acquired<'_>, collected_at: i64) -> Result<Option<i64>> {
        self.handler
            .retention(material, &self.settings)
            .map(|seconds| {
                seconds
                    .checked_mul(1000)
                    .filter(|ttl| *ttl > 0)
                    .and_then(|ttl| collected_at.checked_add(ttl))
                    .ok_or_else(|| oas_domain::Error::invalid("cache_ttl"))
            })
            .transpose()
    }

    pub async fn acquire_search(
        &self,
        scope: &Scope,
        mut snapshot: SearchSnapshot,
    ) -> Result<WriteReceipt> {
        let Some(expires_at) = self.expiry(Acquired::Search(&snapshot), snapshot.collected_at)?
        else {
            return Ok(WriteReceipt::NotAdmitted);
        };
        snapshot.expires_at = expires_at;
        // The caller can detach foreground capture. A consumer must see a durable
        // acknowledgement or a retryable error before completing its task.
        match tokio::time::timeout(
            Duration::from_secs(3),
            self.metadata.save_search(scope, &self.binding, &snapshot),
        )
        .await
        {
            Ok(Ok(true)) => Ok(WriteReceipt::Published),
            Ok(Ok(false)) => Err(oas_domain::Error::cancelled()),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(oas_domain::Error::timeout()),
        }
    }
    pub async fn index_search(&self, scope: &Scope, snapshot: &SearchSnapshot) -> Result<bool> {
        if !self.metadata.valid(scope, &self.binding).await?
            || !self
                .metadata
                .allowed_source(scope, &snapshot.source)
                .await?
        {
            return Ok(false);
        }
        let texts = snapshot.hits.iter().map(feature_text).collect::<Vec<_>>();
        let mut input = vec![snapshot.query.text.clone()];
        input.extend(texts.clone());
        let mut vectors = self.embedding.encode(&input).await?.into_iter();
        let vector = vectors.next().ok_or_else(oas_domain::Error::unavailable)?;
        let features = texts.into_iter().zip(vectors).collect::<Vec<_>>();
        if self.metadata.valid(scope, &self.binding).await? {
            self.index
                .publish(scope, &self.binding, snapshot, &vector, &features)
                .await?;
            return Ok(true);
        }
        Ok(false)
    }
    pub async fn acquire_page(&self, scope: &Scope, page: Page, parent: &str) -> Result<()> {
        let Some(page) = self.prepare_page(page)? else {
            return Ok(());
        };
        let plan = JobPlan {
            kind: "publish_page".into(),
            target: page.key.clone(),
            reason: "acquired".into(),
            object_epoch: page.object_epoch,
            input: json!({"page":page}),
        };
        self.metadata
            .enqueue(scope, &self.binding, &plan, parent)
            .await
    }

    pub fn prepare_page(&self, mut page: Page) -> Result<Option<Page>> {
        let Some(expires) = self.expiry(Acquired::Page(&page), page.collected_at)? else {
            return Ok(None);
        };
        page.expires_at = expires;
        Ok(Some(page))
    }

    pub async fn publish_page(&self, scope: &Scope, page: &Page) -> Result<WriteReceipt> {
        if !self.metadata.valid(scope, &self.binding).await? {
            return Err(oas_domain::Error::cancelled());
        }
        if hash(&page.markdown) != page.content_hash {
            return Err(oas_domain::Error::invalid("content_hash"));
        }
        // Upload addresses are immutable per attempt. A DELETE sent before a
        // process crash must never remove a later upload of the same body hash.
        let mut staged = page.clone();
        staged.object_key = format!(
            "cache/{}/{}/{}/{}.md",
            self.binding.namespace,
            scope.project,
            page.content_hash,
            oas_domain::id()
        );
        let object = staged.object_key.clone();
        if !self
            .metadata
            .track_object(scope, &self.binding, &object, page.markdown.len() as i64)
            .await?
        {
            return Err(oas_domain::Error::new(
                "CACHE_CAPACITY_EXCEEDED",
                503,
                "缓存容量达到上限，等待回收空间。",
                "Cache capacity is exhausted. Waiting for reclamation.",
            ));
        }
        self.metadata.effect_started(scope).await?;
        let key = self.objects.put(scope, &staged).await?;
        if self
            .metadata
            .publish_page(scope, &self.binding, &staged, &key)
            .await?
        {
            return Ok(WriteReceipt::Published);
        }
        if self
            .metadata
            .page(scope, &self.binding, &page.key, now())
            .await?
            .is_some_and(|current| {
                (current.collected_at, current.acquisition_order)
                    >= (page.collected_at, page.acquisition_order)
            })
        {
            Ok(WriteReceipt::Superseded)
        } else {
            Err(oas_domain::Error::cancelled())
        }
    }
    pub async fn record_failure(
        self: &Arc<Self>,
        scope: &Scope,
        key: &str,
        resource: Option<&str>,
        error: &oas_domain::Error,
        epoch: i64,
    ) -> Result<()> {
        let Some(observation) = OriginObservation::from_error(error) else {
            return Ok(());
        };
        let time = error.details["collected_at"].as_i64().unwrap_or_else(now);
        let order = error.details["acquisition_order"].as_i64().unwrap_or(0);
        let retry_at = error.details["retry_after_ms"]
            .as_i64()
            .map(|ms| now().saturating_add(ms.max(0)));
        let (cache, scope, key, resource) = (
            self.clone(),
            scope.clone(),
            key.to_owned(),
            resource.map(str::to_owned),
        );
        // A cancelled foreground reply cannot cancel an already observed denial.
        let recording = tokio::spawn(async move {
            if let Some(url) = resource {
                cache
                    .metadata
                    .bind_resource(&scope, &cache.binding, &key, &url)
                    .await?;
            }
            cache
                .metadata
                .source_status(
                    &scope,
                    &cache.binding,
                    &key,
                    observation,
                    time,
                    epoch,
                    order,
                    retry_at,
                )
                .await?;
            Ok::<(), oas_domain::Error>(())
        });
        recording.await.map_err(|_| oas_domain::Error::internal())?
    }

    pub async fn read_page(&self, scope: &Scope, url: &str, request: &str) -> Result<PageRead> {
        let key = page_key(url, false).ok_or_else(|| oas_domain::Error::invalid("url"))?;
        let deadline = Instant::now() + Duration::from_millis(self.settings.lookup_ms);
        let access = timeout_at(deadline, self.metadata.source_state(scope, &key))
            .await
            .map_err(|_| oas_domain::Error::timeout())??;
        if let Some(outcome) = page_gate(access)? {
            return Ok(outcome);
        }
        let read = timeout_at(deadline, async {
            let Some(mut page) = self
                .metadata
                .page(scope, &self.binding, &key, now())
                .await?
            else {
                return Ok(None);
            };
            let pin = self
                .metadata
                .pin_object(scope, &self.binding, &page.object_key)
                .await?;
            let read = self.objects.get(&page.object_key).await;
            let _ = self.metadata.unpin_object(&pin).await;
            page.markdown = read?;
            if hash(&page.markdown) != page.content_hash {
                return Err(oas_domain::Error::unavailable());
            }
            Ok::<_, oas_domain::Error>(Some(page))
        })
        .await;
        let (candidate, mut metric) = match read {
            Ok(Ok(Some(page))) => (Some(page), "hit"),
            Ok(Ok(None)) => (None, "miss"),
            _ => (None, "bypass"),
        };
        // A denial, replacement or expiry may have committed during object I/O.
        // Never publish the earlier bytes based only on the first pointer read.
        let mut result = PageRead::Miss;
        if let Some(page) = candidate {
            let current = timeout_at(
                deadline,
                self.metadata.page(scope, &self.binding, &key, now()),
            )
            .await;
            if matches!(current,Ok(Ok(Some(ref p))) if p.object_key==page.object_key) {
                let _ = timeout_at(
                    deadline,
                    self.usage(scope, request, request, "content", &key, "reference"),
                )
                .await;
                result = PageRead::Hit(Box::new(page));
            } else {
                metric = "bypass";
                let state = timeout_at(deadline, self.metadata.source_state(scope, &key))
                    .await
                    .map_err(|_| oas_domain::Error::timeout())??;
                if let Some(outcome) = page_gate(state)? {
                    return Ok(outcome);
                }
            }
        }
        let _ = timeout_at(
            deadline,
            self.usage(scope, request, request, "content_lookup", &key, metric),
        )
        .await;
        Ok(result)
    }
    pub async fn selected(
        &self,
        scope: &Scope,
        urls: &[String],
        acquired: &BTreeSet<String>,
        request: &str,
    ) {
        for url in urls.iter().collect::<BTreeSet<_>>() {
            let Some(key) = page_key(url, false) else {
                continue;
            };
            let Ok(state) = self.metadata.source_state(scope, &key).await else {
                continue;
            };
            let object_epoch = state.epoch;
            match state.access {
                PageAccess::Denied => continue,
                PageAccess::Gone => {
                    let recovery = JobPlan {
                        kind: "content".into(),
                        target: key.clone(),
                        reason: "origin_recovery".into(),
                        input: json!({"url":url}),
                        object_epoch,
                    };
                    self.enqueue(scope, &recovery, request).await;
                    continue;
                }
                _ => (),
            }
            let page = match self
                .metadata
                .page(scope, &self.binding, &key, now())
                .await
                .ok()
                .flatten()
            {
                Some(page) => Some(page),
                None => self
                    .metadata
                    .pending_page(scope, &self.binding, &key, now())
                    .await
                    .ok()
                    .flatten(),
            };
            let plan = self.handler.on_selected(SelectedPage {
                url,
                key: &key,
                object_epoch,
                existing: page.as_ref(),
                acquired: acquired.contains(&key),
                summary_version: scope.summary_version.as_deref(),
            });
            if let Some(plan) = plan {
                self.enqueue(scope, &plan, request).await;
            }
        }
    }
    pub async fn summaries(&self, scope: &Scope, hits: &mut [Hit], _request: &str) {
        if hits.is_empty() {
            return;
        }
        let keys = hits
            .iter()
            .filter_map(|h| page_key(&h.url, false))
            .collect::<Vec<_>>();
        let pages = self
            .metadata
            .pages(scope, &self.binding, &keys, now())
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|p| (p.key.clone(), p))
            .collect::<BTreeMap<_, _>>();
        for hit in hits {
            if hit.summary.is_some() {
                continue;
            }
            if let Some(key) = page_key(&hit.url, false)
                && let Some(page) = pages.get(&key)
            {
                if page.summary_version == scope.summary_version {
                    hit.summary = page.summary.clone();
                }
                if hit.summary.is_some() {
                    hit.cached_summary_key = Some(page.key.clone());
                }
            }
        }
    }
    pub async fn rank(
        &self,
        scope: &Scope,
        query: &str,
        hits: Vec<Hit>,
        vector: Option<Vec<f32>>,
        deadline: Instant,
    ) -> Vec<Hit> {
        if hits.is_empty() {
            return hits;
        }
        let texts = hits.iter().map(feature_text).collect::<Vec<_>>();
        let semantic = timeout_at(deadline, async {
            if Instant::now() >= deadline {
                return Err(oas_domain::Error::timeout());
            }
            let q = vector.ok_or_else(oas_domain::Error::unavailable)?;
            let features = self.index.features(&self.binding, &texts).await?;
            if features.iter().any(Option::is_none) {
                return Err(oas_domain::Error::unavailable());
            }
            Ok::<_, oas_domain::Error>(
                features
                    .into_iter()
                    .map(|v| cosine(&q, &v.unwrap()))
                    .collect::<Vec<_>>(),
            )
        })
        .await
        .ok()
        .and_then(std::result::Result::ok);
        let words = terms(query);
        let mut pages = BTreeMap::<String, (f32, Hit)>::new();
        for (i, hit) in hits.into_iter().enumerate() {
            let Some(key) = page_key(&hit.url, false) else {
                continue;
            };
            let lexical = overlap(&words, &terms(&texts[i]));
            let score = self
                .handler
                .rank_score(semantic.as_ref().map(|v| v[i]), lexical, hit.rank);
            if pages.get(&key).is_none_or(|(old, h)| {
                score > *old
                    || (score == *old
                        && (
                            hit.cache.as_ref().map(|c| c.collected_at),
                            std::cmp::Reverse(hit.rank),
                        ) > (
                            h.cache.as_ref().map(|c| c.collected_at),
                            std::cmp::Reverse(h.rank),
                        ))
            }) {
                pages.insert(key, (score, hit));
            }
        }
        let keys = pages.keys().cloned().collect::<Vec<_>>();
        // Origin withdrawals also apply to newly acquired lists after semantic fallback.
        // The caller bounds this permission check by its surrounding request.
        let allowed = self
            .metadata
            .readable(scope, &keys)
            .await
            .unwrap_or_default()
            .into_iter()
            .collect::<BTreeSet<_>>();
        let mut ranked = pages
            .into_iter()
            .filter(|(key, _)| allowed.contains(key))
            .collect::<Vec<_>>();
        ranked.sort_by(|(ka, (a, ha)), (kb, (b, hb))| {
            b.total_cmp(a)
                .then(
                    hb.cache
                        .as_ref()
                        .map(|c| c.collected_at)
                        .cmp(&ha.cache.as_ref().map(|c| c.collected_at)),
                )
                .then(ha.rank.cmp(&hb.rank))
                .then(ka.cmp(kb))
        });
        ranked.into_iter().map(|(_, (_, h))| h).collect()
    }
    fn lexical_rank(&self, query: &str, hits: Vec<Hit>) -> Vec<Hit> {
        let words = terms(query);
        let mut scored = hits
            .into_iter()
            .map(|h| {
                (
                    self.handler.rank_score(
                        None,
                        overlap(&words, &terms(&feature_text(&h))),
                        h.rank,
                    ),
                    h,
                )
            })
            .collect::<Vec<_>>();
        scored.sort_by(|(a, ha), (b, hb)| {
            b.total_cmp(a)
                .then(
                    hb.cache
                        .as_ref()
                        .map(|c| c.collected_at)
                        .cmp(&ha.cache.as_ref().map(|c| c.collected_at)),
                )
                .then(ha.rank.cmp(&hb.rank))
                .then(ha.url.cmp(&hb.url))
        });
        let mut seen = BTreeSet::new();
        scored
            .into_iter()
            .filter_map(|(_, h)| {
                if page_key(&h.url, false).is_some_and(|key| seen.insert(key)) {
                    Some(h)
                } else {
                    None
                }
            })
            .collect()
    }
    fn lookup_hits(found: &Lookup, lookup: &str) -> Vec<Hit> {
        found
            .snapshots
            .iter()
            .flat_map(|snapshot| {
                snapshot.hits.iter().cloned().map(move |mut hit| {
                    hit.cache = Some(snapshot.origin(lookup));
                    hit
                })
            })
            .collect()
    }
    pub fn search_value(found: &Lookup, query: &Query, lookup: &str) -> Value {
        let mut value = json!({"hits":found.ranked,"_partial":found.snapshots.iter().any(|s|s.partial),"_cache":true,"snapshot_ids":found.snapshots.iter().map(|s|s.id.clone()).collect::<Vec<_>>()});
        let exact_id = query.id();
        let exact = found.snapshots.iter().filter(|s| s.question == exact_id);
        let newest = |s: &&SearchSnapshot| {
            (
                s.collected_at,
                s.acquisition_order,
                std::cmp::Reverse(s.id.clone()),
            )
        };
        if let Some(s) = exact.clone().max_by_key(newest)
            && !s.cards.is_empty()
        {
            value["cards"] = json!(s.cards);
            value["_cards_cache"] = json!(s.origin(lookup));
        }
        if let Some(s) = exact
            .filter(|s| s.engine_answer.is_some())
            .max_by_key(newest)
        {
            value["engine_answer"] = json!(s.engine_answer);
            value["_answer_cache"] = json!(s.origin(lookup));
        }
        value
    }
}
fn page_gate(state: PageState) -> Result<Option<PageRead>> {
    match state.access {
        PageAccess::Denied => Err(oas_domain::Error::new(
            "ACCESS_DENIED",
            502,
            "目标网页已拒绝当前访问范围。",
            "The target page denied this access scope.",
        )),
        PageAccess::Gone => Ok(Some(PageRead::Gone(state.epoch))),
        _ => Ok(None),
    }
}
pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub fn feature_text(hit: &Hit) -> String {
    format!("{}\n{}", hit.title, hit.snippet)
}
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot = a.iter().zip(b).map(|(a, b)| a * b).sum::<f32>();
    let norms =
        (a.iter().map(|v| v * v).sum::<f32>() * b.iter().map(|v| v * v).sum::<f32>()).sqrt();
    if norms > 0.0 {
        (dot / norms).clamp(-1.0, 1.0)
    } else {
        0.0
    }
}
pub fn terms(text: &str) -> BTreeSet<String> {
    static JIEBA: std::sync::OnceLock<jieba_rs::Jieba> = std::sync::OnceLock::new();
    JIEBA
        .get_or_init(jieba_rs::Jieba::new)
        .cut_for_search(text, false)
        .into_iter()
        .filter(|s| s.word.chars().any(char::is_alphanumeric))
        .map(|s| s.word.to_lowercase())
        .collect()
}
fn overlap(a: &BTreeSet<String>, b: &BTreeSet<String>) -> f32 {
    if a.is_empty() {
        0.0
    } else {
        a.intersection(b).count() as f32 / a.len() as f32
    }
}

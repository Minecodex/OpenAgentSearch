use crate::{calls::CallOutput, engine::Run};
use oas_domain::{Command, Hit, Result, cache::*, id};
use serde_json::{Value, json};
use std::time::Duration;

impl Run<'_> {
    pub fn cache_enabled(&self) -> bool {
        self.snapshot.project.cache_enabled
            && !self.cache_blocked.load(std::sync::atomic::Ordering::SeqCst)
    }
    fn cache_safe_text(&self, text: &str) -> bool {
        !oas_domain::privacy::secrets(&self.snapshot.secrets)
            .iter()
            .any(|secret| text.contains(secret))
    }
    pub async fn cache_test_result(
        &self,
        endpoint: &oas_domain::Endpoint,
        input: &Value,
        output: &CallOutput,
    ) {
        let Some(cache) = &self.engine.cache else {
            return;
        };
        if self.engine.background
            || endpoint.kind == "model"
            || !self.cache_safe_text(
                input["query"]
                    .as_str()
                    .or(input["url"].as_str())
                    .unwrap_or_default(),
            )
        {
            return;
        }
        let scope = Scope::for_endpoint(endpoint);
        let (source, collected) = self.cache_source(&output.call_id);
        if endpoint.kind == "search" {
            let command = Command {
                language: input["language"].as_str().map(str::to_owned),
                time_range: input["time_range"].as_str().map(str::to_owned),
                ..Default::default()
            };
            let query = Query::new(&command, input["query"].as_str().unwrap_or_default());
            cache.remember_query(&scope, &query);
            if !cache.embedding.configured() {
                return;
            }
            let mut hits = serde_json::from_value::<Vec<Hit>>(output.value["hits"].clone())
                .unwrap_or_default();
            for (i, h) in hits.iter_mut().enumerate() {
                h.rank = i + 1;
                h.call_id = output.call_id.clone();
            }
            let snapshot = SearchSnapshot {
                request_id: self.request.into(),
                id: id(),
                question: query.id(),
                query,
                source,
                call_id: output.call_id.clone(),
                collected_at: collected,
                acquisition_order: self.cache_order(&output.call_id),
                expires_at: 0,
                hits,
                partial: output.value["_partial"] == true,
                engine_answer: output.value.get("engine_answer").cloned(),
                cards: output.value["cards"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
            };
            let cache = cache.clone();
            let known = oas_domain::privacy::secrets(&self.snapshot.secrets);
            tokio::spawn(async move {
                if let Ok(snapshot) =
                    tokio::task::spawn_blocking(move || clean_search(snapshot, &known)).await
                    && let Err(error) = cache.acquire_search(&scope, snapshot).await
                {
                    tracing::debug!(code=%error.code,"cache capture did not commit");
                }
            });
        } else if cache.objects.configured()
            && output.value["_coverage"] == "full"
            && let Some(article) = &output.article
            && let Some(url) = input["url"].as_str()
            && let Some(key) = page_key(url, false)
        {
            let epoch = cache.metadata.page_epoch(&scope, &key).await.unwrap_or(0);
            let markdown = article.markdown_text();
            let page = Page {
                final_url: output.value["final_url"].as_str().map(str::to_owned),
                key,
                url: url.into(),
                source,
                call_id: output.call_id.clone(),
                title: article.title.clone(),
                content_hash: hash(&markdown),
                markdown,
                collected_at: collected,
                acquisition_order: self.cache_order(&output.call_id),
                expires_at: 0,
                summary: None,
                summary_version: None,
                object_epoch: epoch,
                object_key: String::new(),
            };
            self.cache_stage_page(&scope, page, false);
        }
    }
    pub fn page_identity(&self, url: &str) -> Option<String> {
        if self.cache_enabled() {
            page_key(url, false)
        } else {
            oas_domain::canonical_url(url)
        }
    }
    pub async fn pool(
        &self,
        kind: &str,
        stage: &str,
        mut input: Value,
        command: &Command,
    ) -> Result<CallOutput> {
        if !self.cache_safe_text(
            input["query"]
                .as_str()
                .or(input["url"].as_str())
                .unwrap_or_default(),
        ) {
            self.cache_blocked
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        let Some(cache) = self.engine.cache.as_ref().filter(|_| self.cache_enabled()) else {
            return self.uncached_pool(kind, stage, input, command, None).await;
        };
        let scope = Scope::from_snapshot(self.snapshot, cache.settings.summary_tokens);
        let query = Query::new(command, input["query"].as_str().unwrap_or_default());
        if kind == "search" {
            let lookup = id();
            let (span, start) = self.begin("cache_lookup", json!({"query":query.text}));
            let deadline = cache.lookup_deadline().min(self.deadline);
            let found = self
                .bounded(async {
                    Ok(cache
                        .lookup(&scope, &query, self.request, &lookup, deadline)
                        .await)
                })
                .await?;
            self.cache_ranking.lock().unwrap().insert(
                query.text.clone(),
                crate::engine::QueryRanking {
                    deadline,
                    vector: found.vector.clone(),
                },
            );
            let exact_id = query.id();
            let matched_snapshots = found.snapshots.iter().map(|s| json!({
                "snapshot_id": s.id, "question_id": s.question, "query": s.query.text,
                "exact": s.question == exact_id, "source": s.source, "collected_at": s.collected_at
            })).collect::<Vec<_>>();
            let mut info = json!({
                "lookup_id":lookup, "span_id":span, "query":query.text, "questions":found.questions,
                "snapshot_ids":found.snapshots.iter().map(|s| &s.id).collect::<Vec<_>>(),
                "matched_snapshots":matched_snapshots, "degraded":found.degraded,
                "bypass":found.bypass, "hit":!found.snapshots.is_empty(), "search_needed":found.search_needed
            });
            if let Some(verification) = &found.verification {
                info["verification"] = json!(verification);
            }
            let cached = (!found.snapshots.is_empty())
                .then(|| crate::cache::CacheService::search_value(&found, &query, &lookup));
            let mut span_output = info.clone();
            if let Some(result) = &cached {
                for key in ["cards", "engine_answer"] {
                    if let Some(material) = result.get(key) {
                        span_output[key] = material.clone();
                    }
                }
            }
            self.end(&span, "success", span_output, start);
            {
                let mut journal = self.journal.lock().unwrap();
                if !journal.evidence["cache_lookups"].is_array() {
                    journal.evidence["cache_lookups"] = json!([]);
                }
                journal.evidence["cache_lookups"]
                    .as_array_mut()
                    .unwrap()
                    .push(info);
            }
            if let Some(value) = cached {
                return Ok(CallOutput {
                    value,
                    call_id: lookup,
                    article: None,
                });
            }
            input["count"] = json!(10);
        }
        let url = input["url"].as_str().unwrap_or_default().to_owned();
        let key = page_key(&url, false);
        if kind == "reader" {
            let (span, started) = self.begin("cache_read", json!({"url":url}));
            let cached = self
                .bounded(cache.read_page(&scope, &url, self.request))
                .await;
            let cached = match cached {
                Ok(crate::cache::PageRead::Hit(page)) => Some(page),
                Ok(crate::cache::PageRead::Miss) => None,
                Ok(crate::cache::PageRead::Gone(epoch)) => {
                    cache
                        .enqueue(
                            &scope,
                            &JobPlan {
                                kind: "content".into(),
                                target: key.clone().expect("validated URL"),
                                reason: "origin_recovery".into(),
                                input: json!({"url":url}),
                                object_epoch: epoch,
                            },
                            self.request,
                        )
                        .await;
                    self.end(
                        &span,
                        "empty",
                        json!({"hit":false,"source_status":410}),
                        started,
                    );
                    return Err(PageState::gone_error());
                }
                Err(error) => {
                    self.end(&span, "error", json!({"code":error.code}), started);
                    return Err(error);
                }
            };
            if let Some(page) = cached {
                self.bounded(self.engine.transport.validate_read_target(&url))
                    .await?;
                if let Some(key) = page_key(&url, false) {
                    self.full_acquired.lock().unwrap().insert(key);
                }
                let lookup = id();
                let mut value = json!({"body":page.markdown,"title":page.title,"media_type":"text/markdown","_cache":true,"_coverage":"full","snapshot_id":page.content_hash,
                    "cache":CachedOrigin{lookup_id:lookup.clone(),snapshot_id:page.content_hash.clone(),call_id:page.call_id.clone(),source:page.source.clone(),collected_at:page.collected_at}});
                if let Some(final_url) = page.final_url {
                    if final_url != url {
                        self.bounded(self.engine.transport.validate_read_target(&final_url))
                            .await?;
                    }
                    value["final_url"] = json!(final_url);
                }
                let article = self.article(&value).await?;
                if let Some(stage) = self.journal.lock().unwrap().span(&span) {
                    stage["diagnostics"] = json!({"cache_lookup_id":lookup,"cache":value["cache"]});
                }
                self.end(
                    &span,
                    "success",
                    json!({"hit":true,"title":value["title"]}),
                    started,
                );
                return Ok(CallOutput {
                    value,
                    call_id: page.call_id,
                    article: Some(article),
                });
            }
            self.end(&span, "success", json!({"hit":false}), started);
        }
        let epoch = if let Some(key) = &key {
            self.bounded(
                cache
                    .metadata
                    .bind_resource(&scope, &cache.binding, key, &url),
            )
            .await?;
            match self.bounded(cache.metadata.page_epoch(&scope, key)).await {
                Ok(epoch) => epoch,
                Err(e) if e.code == "CANCELLED" => {
                    // Switching the cache off fences publication; an admitted read may still finish.
                    return self.uncached_pool(kind, stage, input, command, None).await;
                }
                Err(e) => return Err(e),
            }
        } else {
            0
        };
        if kind == "reader"
            && let Some(key) = &key
        {
            let _ = tokio::time::timeout(
                Duration::from_millis(20),
                cache.metadata.begin_reads(
                    &scope,
                    &cache.binding,
                    std::slice::from_ref(key),
                    self.request,
                    chrono::Utc::now().timestamp_millis() + 60000,
                ),
            )
            .await;
        }
        let read_guard = key.as_deref().map(|key| (&scope, key, epoch));
        let output = self
            .uncached_pool(kind, stage, input, command, read_guard)
            .await;
        match &output {
            Ok(output) => {
                let (source, collected) = self.cache_source(&output.call_id);
                if kind == "reader"
                    && let (Some(key), Some(resource)) = (&key, output.value["final_url"].as_str())
                {
                    let _ = tokio::time::timeout(
                        Duration::from_millis(20),
                        cache
                            .metadata
                            .bind_resource(&scope, &cache.binding, key, resource),
                    )
                    .await;
                }
                if kind == "search" {
                    let mut hits = serde_json::from_value::<Vec<Hit>>(output.value["hits"].clone())
                        .unwrap_or_default();
                    for (index, hit) in hits.iter_mut().enumerate() {
                        hit.rank = index + 1;
                        hit.call_id = output.call_id.clone();
                    }
                    let snapshot = SearchSnapshot {
                        request_id: self.request.into(),
                        id: id(),
                        question: query.id(),
                        query: query.clone(),
                        source,
                        call_id: output.call_id.clone(),
                        collected_at: collected,
                        acquisition_order: self.cache_order(&output.call_id),
                        expires_at: 0,
                        hits: hits.clone(),
                        partial: output.value["_partial"] == true,
                        engine_answer: output.value.get("engine_answer").cloned(),
                        cards: output.value["cards"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default(),
                    };
                    let cache_write = cache.clone();
                    let scope_write = scope.clone();
                    let capture_source = snapshot.source.clone();
                    let known = oas_domain::privacy::secrets(&self.snapshot.secrets);
                    tokio::spawn(async move {
                        if let Ok(snapshot) =
                            tokio::task::spawn_blocking(move || clean_search(snapshot, &known))
                                .await
                            && let Err(error) =
                                cache_write.acquire_search(&scope_write, snapshot).await
                        {
                            tracing::debug!(code=%error.code,"cache capture did not commit");
                        }
                    });
                    for hit in &hits {
                        if hit.coverage == Coverage::Full
                            && let Some(md) = &hit.content
                        {
                            let Some(key) = page_key(&hit.url, false) else {
                                continue;
                            };
                            self.full_acquired.lock().unwrap().insert(key.clone());
                            let page = Page {
                                final_url: None,
                                key,
                                url: hit.url.clone(),
                                source: capture_source.clone(),
                                call_id: output.call_id.clone(),
                                title: hit.title.clone(),
                                markdown: md.clone(),
                                collected_at: collected,
                                acquisition_order: self.cache_order(&output.call_id),
                                expires_at: 0,
                                content_hash: hash(md),
                                summary: None,
                                summary_version: None,
                                object_epoch: 0,
                                object_key: String::new(),
                            };
                            self.cache_stage_page(&scope, page, true);
                        }
                    }
                } else if kind == "reader"
                    && output.value["_coverage"] == "full"
                    && let (Some(article), Some(key)) = (&output.article, key)
                {
                    self.full_acquired.lock().unwrap().insert(key.clone());
                    self.check_reader_dispatch(&url).await?;
                    let md = article.markdown_text();
                    let page = Page {
                        final_url: output.value["final_url"].as_str().map(str::to_owned),
                        key,
                        url: url.clone(),
                        source,
                        call_id: output.call_id.clone(),
                        title: article.title.clone(),
                        markdown: md.clone(),
                        collected_at: collected,
                        acquisition_order: self.cache_order(&output.call_id),
                        expires_at: 0,
                        content_hash: hash(&md),
                        summary: None,
                        summary_version: None,
                        object_epoch: epoch,
                        object_key: String::new(),
                    };
                    self.cache_stage_page(&scope, page, false);
                }
            }
            Err(error) => {
                if !matches!(
                    error.code.as_str(),
                    "URL_NOT_ALLOWED" | "CANCELLED" | "ACCESS_DENIED"
                ) && !OriginObservation::from_error(error)
                    .is_some_and(OriginObservation::stops_fetch)
                {
                    let mut plan = if kind == "search" {
                        JobPlan {
                            kind: "list".into(),
                            target: query.id(),
                            reason: "foreground_failed".into(),
                            input: json!({"query":query}),
                            object_epoch: 0,
                        }
                    } else {
                        JobPlan {
                            kind: "content".into(),
                            target: page_key(&url, false).unwrap_or_else(|| url.clone()),
                            reason: "foreground_failed".into(),
                            input: json!({"url":url}),
                            object_epoch: epoch,
                        }
                    };
                    if let Some(retry) = error.details["retry_after_ms"].as_i64() {
                        plan.input["retry_at"] =
                            json!(crate::cache::now().saturating_add(retry.max(0)));
                    }
                    cache.enqueue(&scope, &plan, self.request).await;
                }
            }
        }
        if kind == "reader"
            && (output
                .as_ref()
                .map_or(true, |p| p.value["_coverage"] != "full"))
            && let Some(key) = page_key(&url, false)
        {
            let (cache, scope, request) = (cache.clone(), scope.clone(), self.request.to_owned());
            tokio::spawn(async move {
                let _ = cache.metadata.end_reads(&scope, &[key], &request).await;
            });
        }
        output
    }
    fn cache_stage_page(&self, scope: &Scope, mut page: Page, inline: bool) {
        if !self.cache_safe_text(&page.url) {
            return;
        }
        let Some(cache) = &self.engine.cache else {
            return;
        };
        let (cache, scope, request, known) = (
            cache.clone(),
            scope.clone(),
            self.request.to_owned(),
            oas_domain::privacy::secrets(&self.snapshot.secrets),
        );
        tokio::spawn(async move {
            let key = page.key.clone();
            let _ = cache
                .metadata
                .begin_reads(
                    &scope,
                    &cache.binding,
                    std::slice::from_ref(&key),
                    &request,
                    chrono::Utc::now().timestamp_millis() + 60000,
                )
                .await;
            if inline {
                let Ok(epoch) = cache.metadata.page_epoch(&scope, &key).await else {
                    let _ = cache
                        .metadata
                        .end_reads(&scope, std::slice::from_ref(&key), &request)
                        .await;
                    return;
                };
                page.object_epoch = epoch;
            }
            if let Ok(Some(page)) =
                tokio::task::spawn_blocking(move || clean_page(page, &known)).await
                && let Err(error) = cache.acquire_page(&scope, page, &request).await
            {
                tracing::debug!(code=%error.code,"page capture did not queue");
            }
            let _ = cache.metadata.end_reads(&scope, &[key], &request).await;
        });
    }
    fn cache_order(&self, call: &str) -> i64 {
        self.journal
            .lock()
            .unwrap()
            .call(call)
            .and_then(|c| c["started_at"].as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .and_then(|t| t.timestamp_nanos_opt())
            .unwrap_or(0)
    }
    pub fn cache_source(&self, call: &str) -> (String, i64) {
        let mut journal = self.journal.lock().unwrap();
        let c = journal.call(call);
        (
            c.as_ref()
                .and_then(|v| v["endpoint_id"].as_str())
                .unwrap_or_default()
                .into(),
            c.and_then(|v| v["started_at"].as_str())
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|t| t.timestamp_millis())
                .unwrap_or_else(|| chrono::Utc::now().timestamp_millis()),
        )
    }
    pub async fn check_reader_dispatch(&self, url: &str) -> Result<()> {
        let Some(cache) = self
            .engine
            .cache
            .as_ref()
            .filter(|_| self.snapshot.project.cache_enabled)
        else {
            return Ok(());
        };
        let key = page_key(url, false).ok_or_else(|| oas_domain::Error::invalid("url"))?;
        let scope = self
            .test_cache_scope
            .clone()
            .unwrap_or_else(|| Scope::from_project(&self.snapshot.project));
        let state = self
            .bounded(cache.metadata.source_state(&scope, &key))
            .await?;
        state.require_network(false)
    }
    pub async fn cache_selected(&self, urls: &[String]) {
        if let Some(cache) = self.engine.cache.as_ref().filter(|_| self.cache_enabled()) {
            let (cache, scope, urls, request) = (
                cache.clone(),
                Scope::from_snapshot(self.snapshot, cache.settings.summary_tokens),
                urls.iter()
                    .filter(|u| self.cache_safe_text(u))
                    .cloned()
                    .collect::<Vec<_>>(),
                self.request.to_owned(),
            );
            let acquired = self.full_acquired.lock().unwrap().clone();
            tokio::spawn(async move {
                cache.selected(&scope, &urls, &acquired, &request).await;
            });
        }
    }
    pub async fn cache_rank(&self, query: &str, hits: Vec<Hit>) -> Vec<Hit> {
        let Some(cache) = self.engine.cache.as_ref().filter(|_| self.cache_enabled()) else {
            return hits;
        };
        let (rank, earliest, healthy) = {
            let queries = self.cache_ranking.lock().unwrap();
            (
                queries.get(query).cloned(),
                queries.values().map(|r| r.deadline).min(),
                queries.values().any(|r| r.vector.is_some()),
            )
        };
        let deadline = rank
            .as_ref()
            .map(|r| r.deadline)
            .or(earliest)
            .unwrap_or_else(tokio::time::Instant::now);
        let vector = match rank {
            Some(rank) => rank.vector,
            None if healthy && tokio::time::Instant::now() < deadline => {
                // A rewrites-only summary may still need a vector for its original question.
                tokio::time::timeout_at(deadline, cache.embedding.encode(&[query.into()]))
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .and_then(|v| v.into_iter().next())
            }
            None => None,
        };
        cache
            .rank(
                &Scope::from_project(&self.snapshot.project),
                query,
                hits,
                vector,
                deadline,
            )
            .await
    }
    pub async fn cache_summaries(&self, hits: &mut [Hit]) {
        let Some(cache) = self.engine.cache.as_ref().filter(|_| self.cache_enabled()) else {
            return;
        };
        let cached = self.journal.lock().unwrap().evidence["cache_lookups"]
            .as_array()
            .is_some_and(|v| v.iter().any(|v| v["hit"] == true));
        if !cached {
            let _ = tokio::time::timeout(
                Duration::from_millis(100),
                cache.summaries(
                    &Scope::from_snapshot(self.snapshot, cache.settings.summary_tokens),
                    hits,
                    self.request,
                ),
            )
            .await;
        }
        let keys = hits
            .iter()
            .filter_map(|h| h.cached_summary_key.clone())
            .collect::<Vec<_>>();
        if !keys.is_empty() {
            let (cache, scope, request) = (
                cache.clone(),
                Scope::from_snapshot(self.snapshot, cache.settings.summary_tokens),
                self.request.to_owned(),
            );
            tokio::spawn(async move {
                for key in keys {
                    cache
                        .usage(&scope, &request, &request, "content", &key, "reference")
                        .await;
                }
            });
        }
    }
}

fn safe_url(url: &str, known: &[String]) -> bool {
    !known.iter().any(|secret| url.contains(secret))
}
fn cleaned(text: &str, known: &[String]) -> String {
    let mut value = serde_json::json!(text);
    oas_domain::privacy::redact(&mut value, known);
    value.as_str().unwrap().into()
}
fn clean_page(mut page: Page, known: &[String]) -> Option<Page> {
    if !safe_url(&page.url, known)
        || page
            .final_url
            .as_ref()
            .is_some_and(|url| !safe_url(url, known))
    {
        return None;
    }
    page.title = cleaned(&page.title, known);
    page.markdown = cleaned(&page.markdown, known);
    page.markdown = oas_domain::article::Article::markdown(&page.title, &page.markdown)
        .ok()?
        .markdown_text();
    page.markdown = cleaned(&page.markdown, known);
    page.content_hash = hash(&page.markdown);
    Some(page)
}
fn clean_search(mut snapshot: SearchSnapshot, known: &[String]) -> SearchSnapshot {
    snapshot.hits.retain(|h| safe_url(&h.url, known));
    for hit in &mut snapshot.hits {
        hit.title = cleaned(&hit.title, known);
        hit.snippet = cleaned(&hit.snippet, known);
        hit.summary = hit.summary.as_ref().map(|s| cleaned(s, known));
        hit.content = hit.content.as_ref().map(|s| cleaned(s, known));
    }
    if snapshot.engine_answer.as_ref().is_some_and(|a| {
        a["sources"].as_array().is_some_and(|s| {
            s.iter()
                .any(|s| s["url"].as_str().is_some_and(|u| !safe_url(u, known)))
        })
    }) {
        snapshot.engine_answer = None;
    }
    if let Some(answer) = &mut snapshot.engine_answer {
        for key in ["content", "text", "answer"] {
            if let Some(text) = answer[key].as_str() {
                answer[key] = serde_json::json!(cleaned(text, known));
            }
        }
    }
    for card in &mut snapshot.cards {
        for key in ["title", "content"] {
            if let Some(text) = card[key].as_str() {
                card[key] = serde_json::json!(cleaned(text, known));
            }
        }
    }
    snapshot
}

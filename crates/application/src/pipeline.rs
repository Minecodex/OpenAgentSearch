use crate::engine::{Run, protocol, terminal};
use futures::{StreamExt, stream};
use oas_domain::{Command, Error, Hit, Result, canonical_url, success};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

impl Run<'_> {
    pub async fn execute(&mut self, op: &str, command: &Command) -> Result<Value> {
        if op == "content" {
            let url = command.url.as_deref().unwrap();
            let page = self
                .pool("reader", "extract", json!({"url":url}), command)
                .await?;
            let article = page.article.as_ref().unwrap();
            let data = article.data(
                url,
                page.value["final_url"].as_str(),
                command
                    .max_chars
                    .unwrap_or(self.snapshot.project.body_limit),
            );
            self.material(&page.call_id, url, &page.value, Some(article), None);
            self.article_length(
                &page.call_id,
                data["lengths"]["text"]["retained"].as_u64().unwrap_or(0),
            );
            if data["text"].as_str().is_none_or(str::is_empty)
                || data["markdown"].as_str().is_none_or(str::is_empty)
            {
                return Err(Error::new(
                    "CONTENT_LIMIT_TOO_SMALL",
                    400,
                    "字数上限不足以返回有效正文，请增大上限。",
                    "The character limit cannot retain readable content. Increase the limit.",
                )
                .field("max_chars"));
            }
            let mut response = success(self.request, data);
            self.cache_selected(&[url.to_owned()]).await;
            if response["data"]["truncated"] == true {
                self.warnings(&mut response, &["content_truncated"]);
            }
            return Ok(response);
        }
        let question = command.query.as_deref().unwrap().trim();
        let language = command.language.clone();
        let mut queries = vec![(0, question.to_owned())];
        let mut loss = false;
        if op == "summary" {
            let endpoint = self.model_endpoint()?;
            if !self.request_fits(
                endpoint,
                "score",
                &json!({"query":question,"batch_id":"B1","candidates":[{"candidate_id":"c1","title":"","snippet":""}]}),
            ).await? {
                return Err(Error::new(
                    "MODEL_CONTEXT_EXCEEDED",
                    502,
                    "问题和模型指令超出输入预算。",
                    "The query and model instructions exceed the input budget.",
                ));
            }
            if self.snapshot.project.rewrite_count > 0 {
                let input = json!({"query":question,"language":language,"rewrite_count":self.snapshot.project.rewrite_count});
                let mut rewriting = self.fork();
                rewriting.deadline = tokio::time::Instant::now()
                    + (self.total_deadline - tokio::time::Instant::now()) / 6;
                match rewriting.model("rewrite", &input).await {
                    Ok(output) => {
                        let (accepted, entries) = crate::rewrite::accepted(
                            question,
                            &output.value,
                            self.snapshot.project.rewrite_count,
                        );
                        let reason = accepted.is_empty().then_some("no_usable_rewrite");
                        crate::rewrite::annotate(
                            &mut self.journal.lock().unwrap(),
                            Some(&output.call_id),
                            self.snapshot.project.rewrite_count,
                            entries,
                            accepted.len(),
                            reason,
                            self.snapshot.project.search_original_query,
                        );
                        for query in accepted {
                            queries.push((queries.len(), query));
                        }
                    }
                    Err(error) => {
                        if terminal(&error) {
                            return Err(error);
                        }
                        crate::rewrite::annotate(
                            &mut self.journal.lock().unwrap(),
                            None,
                            self.snapshot.project.rewrite_count,
                            Vec::new(),
                            0,
                            Some(&error.code),
                            self.snapshot.project.search_original_query,
                        );
                    }
                }
            }
            if !self.snapshot.project.search_original_query {
                queries.retain(|(i, _)| *i != 0);
                if queries.is_empty() {
                    return Err(Error::new(
                        "QUERY_REWRITE_FAILED",
                        502,
                        "未生成可用的改写查询，且项目已关闭原问题搜索。请稍后重试或启用原问题搜索。",
                        "No usable rewritten query was generated and original-query search is disabled. Retry or enable original-query search.",
                    ));
                }
            }
        }
        self.journal.lock().unwrap().plan_variants(&queries);
        let jobs=queries.iter().map(|(i,query)|{
            let child=self.fork();let query_language=language.clone();let mut input=json!({"query":query,"language":language,"time_range":command.time_range,"count":command.count.unwrap_or(self.snapshot.project.search_limit),"variant_id":format!("Q{i}")});
            if let Some(region)=&command.region {input["region"]=json!(region);}
            async move{
                let variant=format!("Q{i}");
                let result=child.pool("search","search",input,command).await;
                let result=result.and_then(|output|{
                    let parsed:Vec<Hit>=serde_json::from_value(output.value["hits"].clone()).map_err(|_|protocol("SEARCH_FAILED"))?;
                    let mut normalized=Vec::new();let mut raw=Vec::new();let mut partial=output.value["_partial"]==true;
                    let mut parsed=parsed;
                    let cards=oas_domain::search_cards::parse(&output.value)?;
                    if op=="summary" {
                        let mut material=crate::search_cards::candidates(&cards,query_language.as_deref().is_none_or(|value|value.starts_with("zh")));
                        if let Some(origin) = output.value.get("_cards_cache") {
                            let origin: oas_domain::cache::CachedOrigin = serde_json::from_value(origin.clone()).map_err(|_| protocol("SEARCH_FAILED"))?;
                            for hit in &mut material { hit.cache = Some(origin.clone()); }
                        }
                        material.extend(parsed);parsed=material;
                    }
                    if op=="summary" && let Some(refs)=output.value["engine_answer"]["sources"].as_array() {
                        for source in refs {
                            let Some(url)=source["url"].as_str().filter(|s|canonical_url(s).is_some()) else{continue};
                            if !parsed.iter().any(|h|h.url==url) {
                                let title=source["title"].as_str().unwrap_or("");
                                parsed.push(Hit{url:url.into(),title:title.into(),snippet:title.into(),summary:None,cached_summary_key:None,cache:output.value.get("_answer_cache").and_then(|v|serde_json::from_value(v.clone()).ok()),published_at:None,coverage:oas_domain::cache::Coverage::Unknown,content:None,rank:0,variant_id:String::new(),call_id:String::new()});
                            }
                        }
                    }
                    for(rank,mut hit)in parsed.into_iter().enumerate(){
                        if child.page_identity(&hit.url).is_none(){partial=true;continue;}
                        hit.variant_id=variant.clone();hit.call_id=hit.cache.as_ref().map(|c|c.call_id.clone()).unwrap_or_else(||output.call_id.clone());if hit.rank == 0 || output.value["_cache"]!=true {hit.rank=rank+1;}
                        let mut item=json!({"url":hit.url,"title":hit.title,"snippet":hit.snippet,"rank":hit.rank,"call_id":hit.call_id});
                        if let Some(origin)=&hit.cache{item["cache"]=json!(origin);}
                        raw.push(item);normalized.push(hit);
                    }
                    child.journal.lock().unwrap().variant_result(&variant,if partial{"partial"}else{"success"},Some(json!(raw)),if output.value["_cache"]==true {None}else{Some(&output.call_id)});
                    if output.value["_cache"]==true && let Some(v)=child.journal.lock().unwrap().evidence["variants"].as_array_mut().and_then(|v|v.iter_mut().find(|v|v["variant_id"]==variant)){v["cache_lookup_id"]=json!(output.call_id);}
                    Ok((normalized,partial,output.value.get("engine_answer").cloned(),cards))
                });
                if let Err(error)=&result{child.journal.lock().unwrap().variant_result(&variant,if error.code=="CANCELLED"{"cancelled"}else{"error"},None,None);}
                (*i,result)
            }
        }).collect::<Vec<_>>();
        let mut replies = stream::iter(jobs)
            .buffer_unordered(4)
            .collect::<Vec<_>>()
            .await;
        replies.sort_by_key(|r| r.0);
        let mut hits = Vec::<Hit>::new();
        let mut engine_answer = None;
        let mut search_cards = Vec::new();
        let mut successes = 0;
        let mut last_error = Error::unavailable();
        for (variant, result) in replies {
            match result {
                Ok((values, partial, card, cards)) => {
                    if variant == 0 {
                        engine_answer = card;
                    }
                    search_cards.extend(cards);
                    successes += 1;
                    loss |= partial;
                    hits.extend(values);
                }
                Err(error) => {
                    if terminal(&error) {
                        return Err(error);
                    }
                    loss = true;
                    last_error = error;
                }
            }
        }
        if successes == 0 {
            return Err(last_error);
        }
        let mut indexes = HashMap::new();
        let mut unique = Vec::new();
        for hit in &hits {
            let key = self.page_identity(&hit.url).unwrap();
            if let std::collections::hash_map::Entry::Vacant(entry) = indexes.entry(key) {
                entry.insert(unique.len());
                unique.push(hit.clone());
            }
        }
        let (span, started) = self.begin("dedup", json!({"raw_candidates":hits.len()}));
        self.end(
            &span,
            "success",
            json!({"unique_candidates":unique.len()}),
            started,
        );
        if self.cache_enabled() && self.engine.cache.is_some() {
            let cached = self.journal.lock().unwrap().evidence["cache_lookups"]
                .as_array()
                .is_some_and(|values| {
                    !values.is_empty() && values.iter().all(|v| v["hit"] == true)
                });
            if !cached || op != "list" {
                unique = self.cache_rank(question, hits.clone()).await;
            }
        }
        if op == "list" {
            let limit = command.count.unwrap_or(self.snapshot.project.search_limit);
            let mut visible = unique.iter().take(limit).cloned().collect::<Vec<_>>();
            self.cache_summaries(&mut visible).await;
            let items = unique
                .iter()
                .take(limit)
                .zip(&visible)
                .map(|(hit, shown)| {
                    let mut item = json!({"url":hit.url,"title":hit.title,"snippet":hit.snippet});
                    if let Some(summary) = &shown.summary {
                        item["summary"] = json!(summary);
                    }
                    item
                })
                .collect::<Vec<_>>();
            self.cache_selected(&visible.iter().map(|h| h.url.clone()).collect::<Vec<_>>())
                .await;
            let mut response = success(self.request, json!({"items":items}));
            if let Some(card) = engine_answer {
                response["data"]["engine_answer"] = card;
            }
            if !search_cards.is_empty() {
                response["data"]["cards"] = json!(search_cards);
            }
            response["status"] = json!(if items.is_empty()
                && response["data"]["engine_answer"].is_null()
                && search_cards.is_empty()
            {
                "empty"
            } else if loss {
                "partial"
            } else {
                "success"
            });
            if loss {
                self.warnings(&mut response, &["source_incomplete"]);
            }
            return Ok(response);
        }
        if unique.is_empty() {
            return Ok(self.empty());
        }
        let mut candidates=unique.iter().enumerate().map(|(i,hit)|{
            let matches=hits.iter().filter(|h|self.page_identity(&h.url)==self.page_identity(&hit.url)).map(|h|{let mut m=json!({"variant_id":h.variant_id,"call_id":h.call_id,"url":h.url,"rank":h.rank});if let Some(origin)=&h.cache{m["cache"]=json!(origin);}m}).collect::<Vec<_>>();
            json!({"candidate_id":format!("c{}",i+1),"url":hit.url,"title":hit.title,"snippet_preview":hit.snippet,"hits":matches,"relevant":null,"score":null,"score_batch_id":null,"score_call_id":null,"selected":false,"selection_reason":null,"source_id":null,"material":null,"reader_call_ids":[]})
        }).collect::<Vec<_>>();
        self.evidence("candidates", json!(candidates));
        let mut scoring = self.fork();
        scoring.deadline =
            tokio::time::Instant::now() + (self.total_deadline - tokio::time::Instant::now()) / 3;
        loss |= scoring.score(question, &mut candidates).await?;
        let mut selected = (0..candidates.len())
            .filter(|i| candidates[*i]["relevant"] == true)
            .collect::<Vec<_>>();
        selected.sort_by_key(|i| std::cmp::Reverse(candidates[*i]["score"].as_u64().unwrap_or(0)));
        selected.truncate(
            command
                .source_count
                .unwrap_or(self.snapshot.project.source_limit),
        );
        for candidate in &mut candidates {
            candidate["selection_reason"] = json!(if candidate["relevant"] == false {
                "irrelevant"
            } else if candidate["relevant"].is_null() {
                "unscored"
            } else {
                "source_limit"
            });
        }
        for (order, index) in selected.iter().enumerate() {
            candidates[*index]["selected"] = json!(true);
            candidates[*index]["source_id"] = json!(format!("s{}", order + 1));
            candidates[*index]["selection_reason"] = json!("selected");
        }
        self.evidence("candidates", json!(candidates));
        if selected.is_empty() {
            if candidates
                .iter()
                .any(|candidate| candidate["relevant"].is_null())
            {
                return Err(protocol("MODEL_FAILED"));
            }
            return Ok(self.empty());
        }
        if self.snapshot.project.summary_snippets_only {
            self.cache_selected(
                &selected
                    .iter()
                    .map(|i| unique[*i].url.clone())
                    .collect::<Vec<_>>(),
            )
            .await;
        }
        let remaining = self
            .total_deadline
            .saturating_duration_since(tokio::time::Instant::now());
        let reserve = Duration::from_millis(self.model_endpoint()?.timeout_ms).min(remaining / 3);
        self.deadline = self.total_deadline - reserve;
        let jobs = selected
            .into_iter()
            .enumerate()
            .map(|(order, index)| {
                let child = self.fork();
                let hit = unique[index].clone();
                let candidate = candidates[index].clone();
                let language = language.clone();
                async move {
                    (
                        order,
                        child
                            .source(index, &hit, &candidate, language.as_deref(), command)
                            .await,
                    )
                }
            })
            .collect::<Vec<_>>();
        let mut results = stream::iter(jobs)
            .buffer_unordered(4)
            .collect::<Vec<_>>()
            .await;
        results.sort_by_key(|r| r.0);
        let mut sources = Vec::new();
        let mut reasons = HashSet::new();
        let mut source_error = None;
        for (_, result) in results {
            let result = result?;
            loss |= result.loss;
            for reason in result.reasons {
                reasons.insert(reason);
            }
            if let Some(error) = result.error {
                source_error = Some(error);
            }
            if let Some(source) = result.source {
                sources.push(source);
            }
        }
        let material_deadline = self.deadline;
        self.deadline = self.total_deadline;
        if sources.is_empty() {
            return if loss {
                Err(source_error.unwrap_or_else(|| protocol("CONTENT_UNAVAILABLE")))
            } else {
                Ok(self.empty())
            };
        }
        let max_chars = command
            .max_chars
            .unwrap_or(self.snapshot.project.summary_limit);
        let analysis = self
            .summarize_sources(
                &mut sources,
                question,
                language.as_deref(),
                max_chars,
                material_deadline,
            )
            .await?;
        loss |= analysis.loss;
        reasons.extend(analysis.reasons);
        let Some(answer) = analysis.answer else {
            return if let Some(error) = analysis.error.or(source_error) {
                Err(error)
            } else {
                Ok(self.empty())
            };
        };
        let citations = answer["citations"].as_array().unwrap();
        for segment in self.journal.lock().unwrap().evidence["segments"]
            .as_array_mut()
            .unwrap()
        {
            segment["cited"] = json!(
                citations
                    .iter()
                    .any(|c| c["source_id"] == segment["source_id"]
                        && c["segment_id"] == segment["segment_id"])
            );
        }
        let mut response = success(
            self.request,
            json!({"summary":answer["summary"],"sources":sources,"citations":citations}),
        );
        if loss {
            response["status"] = json!("partial");
            reasons.insert("source_incomplete");
            let mut reasons = reasons.into_iter().collect::<Vec<_>>();
            reasons.sort();
            self.warnings(&mut response, &reasons);
        }
        Ok(response)
    }
    pub(crate) async fn synthesize_summaries(
        &self,
        sources: &[Value],
        question: &str,
        language: Option<&str>,
        max_chars: usize,
    ) -> Result<Value> {
        let mut synthesis = sources.to_vec();
        let model = self.model_endpoint()?.clone();
        for round in 1..=2 {
            let input = json!({"query":question,"language":language,"max_chars":max_chars,"sources":synthesis});
            if self.request_fits(&model, "synthesis", &input).await? {
                break;
            }
            let before = self
                .token_count(
                    model.options["tokenizer"].as_str().unwrap_or("cl100k_base"),
                    json!(synthesis).to_string(),
                )
                .await?;
            let remaining = self
                .total_deadline
                .saturating_duration_since(tokio::time::Instant::now());
            let compression_deadline =
                self.total_deadline - Duration::from_millis(model.timeout_ms).min(remaining / 2);
            synthesis = self
                .compress(&synthesis, question, compression_deadline, round)
                .await?;
            if self
                .token_count(
                    model.options["tokenizer"].as_str().unwrap_or("cl100k_base"),
                    json!(synthesis).to_string(),
                )
                .await?
                >= before
            {
                return Err(protocol("MODEL_FAILED"));
            }
        }
        let input =
            json!({"query":question,"language":language,"max_chars":max_chars,"sources":synthesis});
        if !self.request_fits(&model, "synthesis", &input).await? {
            return Err(protocol("MODEL_CONTEXT_EXCEEDED"));
        }
        Ok(self.model("synthesis", &input).await?.value)
    }
}

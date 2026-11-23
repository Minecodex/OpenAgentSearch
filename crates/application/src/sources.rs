use crate::engine::{Run, protocol, terminal};
use oas_domain::{Command, Error, Hit, Result, article::Article, truncate};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::Arc};

pub(crate) struct SourceResult {
    pub source: Option<Value>,
    pub loss: bool,
    pub reasons: Vec<&'static str>,
    pub error: Option<Error>,
}
impl SourceResult {
    fn missing(error: Error) -> Self {
        Self {
            source: None,
            loss: true,
            reasons: vec![],
            error: Some(error),
        }
    }
}
impl Run<'_> {
    pub async fn source(
        &self,
        index: usize,
        hit: &Hit,
        candidate: &Value,
        language: Option<&str>,
        command: &Command,
    ) -> Result<SourceResult> {
        let(span,started)=self.begin("source",json!({"candidate_id":candidate["candidate_id"],"source_id":candidate["source_id"],"url":hit.url}));
        let mut child = self.fork();
        child.parent = Some(span.clone());
        let result = child
            .source_inner(index, hit, candidate, language, command)
            .await;
        self.end(&span,match &result{Ok(v)if v.loss=>"partial",Ok(_)=>"success",Err(e)if e.code=="CANCELLED"=>"cancelled",Err(_)=>"error"},match &result{Ok(v)=>json!({"source_id":candidate["source_id"],"segments":v.source.as_ref().and_then(|s|s["segments"].as_array()).map_or(0,Vec::len),"reason":v.error.as_ref().map(|e|&e.code)}),Err(e)=>json!({"code":e.code})},started);
        result
    }
    async fn source_inner(
        &self,
        index: usize,
        hit: &Hit,
        candidate: &Value,
        language: Option<&str>,
        command: &Command,
    ) -> Result<SourceResult> {
        let source = candidate["source_id"].as_str().unwrap();
        if tokio::time::Instant::now() >= self.deadline {
            return Ok(SourceResult::missing(self.deadline_error()));
        }
        let mut page = None;
        let mut kind = "body";
        if self.snapshot.project.summary_snippets_only {
            let text = [hit.title.trim(), hit.snippet.trim()]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            if text.is_empty() {
                self.journal
                    .lock()
                    .unwrap()
                    .candidate(index, &json!({"material_reason":"empty_search_item"}));
                return Ok(SourceResult {
                    source: None,
                    loss: false,
                    reasons: Vec::new(),
                    error: None,
                });
            }
            let article = Arc::new(Article::plain_text(&hit.title, &text)?);
            let value = json!({
                "body":article.markdown_text(),
                "media_type":"text/markdown",
                "title":hit.title,
            });
            page = Some((value, article, hit.call_id.clone(), "search_snippet"));
            kind = "snippet";
        } else if let Some(body) = hit.content.as_ref().filter(|v| !v.trim().is_empty()) {
            let value = json!({"body":body,"media_type":"text/markdown","title":hit.title});
            if let Ok(article) = self.article(&value).await {
                page = Some((value, article, hit.call_id.clone(), "inline_body"));
            }
        }
        let read = if let Some(page) = page {
            Ok(page)
        } else {
            self.pool("reader","extract",json!({"url":hit.url,"language":language,"source_id":source,"candidate_id":candidate["candidate_id"]}),command).await.map(|page|(page.value,page.article.unwrap(),page.call_id,"reader_body"))
        };
        let mut loss = false;
        let reasons = Vec::new();
        let mut last_error = None;
        let (value, article, call, material_kind) = match read {
            Ok(value) => value,
            Err(error) => {
                if terminal(&error) {
                    return Err(error);
                }
                self.journal
                    .lock()
                    .unwrap()
                    .candidate(index, &json!({"material_reason":error.code}));
                if error.code == "STAGE_BUDGET_EXCEEDED" {
                    let mut result = SourceResult::missing(error);
                    result.reasons.push("material_budget_exhausted");
                    return Ok(result);
                }
                if !self.snapshot.project.allow_snippets
                    || matches!(error.code.as_str(), "ACCESS_DENIED" | "URL_NOT_ALLOWED")
                    || hit.snippet.trim().is_empty()
                {
                    return Ok(SourceResult::missing(error));
                }
                kind = "snippet";
                loss = true;
                last_error = Some(error);
                let value =
                    json!({"body":hit.snippet,"media_type":"text/markdown","title":hit.title});
                let article = Arc::new(Article::markdown(&hit.title, &hit.snippet)?);
                (value, article, hit.call_id.clone(), "snippet")
            }
        };
        let data = article.data(
            &hit.url,
            value["final_url"].as_str(),
            self.snapshot.project.body_limit,
        );
        self.material(&call, &hit.url, &value, Some(&article), Some(source));
        if data["text"].as_str().is_none_or(str::is_empty) {
            return Ok(SourceResult::missing(
                oas_domain::Error::new(
                    "CONTENT_LIMIT_TOO_SMALL",
                    400,
                    "项目正文字数上限不足以保留有效材料。",
                    "The project article limit cannot retain readable evidence.",
                )
                .field("body_limit"),
            ));
        }
        self.article_length(
            &call,
            data["lengths"]["text"]["retained"].as_u64().unwrap_or(0),
        );
        self.journal.lock().unwrap().candidate(index,&json!({"material":material_kind,"article_preview":truncate(&article.text(),500),"lengths":data["lengths"]}));
        let ranks = candidate["hits"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|h| h["rank"].as_u64())
            .collect::<Vec<_>>();
        let variants = candidate["hits"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|h| h["variant_id"].as_str())
            .collect::<HashSet<_>>();
        let mut variants = variants.into_iter().collect::<Vec<_>>();
        variants.sort();
        self.journal.lock().unwrap().evidence["sources"].as_array_mut().unwrap().push(json!({"source_id":source,"url":hit.url,"title":hit.title,"score":candidate["score"],"ranks":ranks,"variant_ids":variants}));

        loss |= data["truncated"] == true;
        Ok(SourceResult {
            source: Some(
                json!({"id":source,"url":hit.url,"title":hit.title,"score":candidate["score"],"kind":kind,
                "segments":[{"id":"p1","text":data["text"]}]}),
            ),
            loss,
            reasons,
            error: last_error,
        })
    }
}
pub(crate) fn split_passages(
    text: &str,
    maximum: usize,
    mut fits: impl FnMut(usize, &str) -> Result<bool>,
) -> Result<Vec<(usize, String)>> {
    if fits(1, text)? {
        return Ok(vec![(0, text.to_owned())]);
    }
    let chars = text.chars().collect::<Vec<_>>();
    let mut start = 0;
    let mut result = Vec::new();
    while start < chars.len() && result.len() < maximum {
        let mut lo = start + 1;
        let mut hi = (start + 512).min(chars.len());
        let mut end = start;
        while hi < chars.len()
            && fits(
                result.len() + 1,
                &chars[start..hi].iter().collect::<String>(),
            )?
        {
            end = hi;
            lo = hi + 1;
            hi = (start + 2 * (hi - start)).min(chars.len());
        }
        while lo <= hi {
            let middle = lo + (hi - lo) / 2;
            let value = chars[start..middle].iter().collect::<String>();
            if fits(result.len() + 1, &value)? {
                end = middle;
                lo = middle + 1;
            } else {
                hi = middle - 1;
            }
        }
        if end == start {
            return Err(protocol("MODEL_CONTEXT_EXCEEDED"));
        }
        let fitting_end = end;
        if end < chars.len()
            && let Some(boundary) = chars[start..end]
                .windows(2)
                .rposition(|v| v == ['\n', '\n'])
            && boundary > (end - start) / 2
        {
            end = start + boundary + 2;
        } else if end < chars.len()
            && let Some(boundary) = chars[start..end].iter().rposition(|c| *c == '\n')
            && boundary > (end - start) / 2
        {
            end = start + boundary + 1;
        }
        if end != fitting_end
            && !fits(
                result.len() + 1,
                &chars[start..end].iter().collect::<String>(),
            )?
        {
            end = fitting_end;
        }
        result.push((start, chars[start..end].iter().collect()));
        start = end;
    }
    Ok(result)
}

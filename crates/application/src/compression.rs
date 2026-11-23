use crate::engine::{Run, protocol};
use futures::{StreamExt, stream};
use oas_domain::Result;
use serde_json::{Value, json};

impl Run<'_> {
    pub async fn compress(
        &self,
        sources: &[Value],
        question: &str,
        deadline: tokio::time::Instant,
        round: usize,
    ) -> Result<Vec<Value>> {
        let endpoint = self.model_endpoint()?;
        let mut jobs = Vec::new();
        for (si, source) in sources.iter().enumerate() {
            let mut batch = Vec::new();
            let mut batch_index = 0;
            for segment in source["segments"].as_array().unwrap() {
                let mut trial = batch.clone();
                trial.push(segment.clone());
                let mut trial_source = source.clone();
                trial_source["segments"] = json!(trial);
                if !self
                    .request_fits(
                        endpoint,
                        "compress",
                        &json!({"query":question,"source":trial_source,"round":round}),
                    )
                    .await?
                {
                    if batch.is_empty() {
                        return Err(protocol("MODEL_CONTEXT_EXCEEDED"));
                    }
                    let mut input = source.clone();
                    input["segments"] = json!(std::mem::take(&mut batch));
                    jobs.push((si, batch_index, input));
                    batch_index += 1;
                    let mut one = source.clone();
                    one["segments"] = json!([segment]);
                    if !self
                        .request_fits(
                            endpoint,
                            "compress",
                            &json!({"query":question,"source":one,"round":round}),
                        )
                        .await?
                    {
                        return Err(protocol("MODEL_CONTEXT_EXCEEDED"));
                    }
                }
                batch.push(segment.clone());
            }
            if !batch.is_empty() {
                let mut input = source.clone();
                input["segments"] = json!(batch);
                jobs.push((si, batch_index, input));
            }
        }
        let pending = jobs
            .into_iter()
            .map(|(si, bi, source)| {
                let mut child = self.fork();
                child.deadline = deadline;
                let input = json!({"query":question,"source":source,"round":round});
                async move { (si, bi, child.model("compress", &input).await) }
            })
            .collect::<Vec<_>>();
        let mut replies = stream::iter(pending)
            .buffer_unordered(4)
            .collect::<Vec<_>>()
            .await;
        replies.sort_by_key(|r| (r.0, r.1));
        let mut result = sources.to_vec();
        for source in &mut result {
            source["segments"] = json!([]);
        }
        for (si, _, reply) in replies {
            let reply = reply?;
            let references = reply.value["citations"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c["segment_id"].clone())
                .collect::<Vec<_>>();
            result[si]["segments"].as_array_mut().unwrap().push(json!({"id":references[0],"references":references,"summary":reply.value["summary"]}));
        }
        Ok(result)
    }
}

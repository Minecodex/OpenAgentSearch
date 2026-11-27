use async_trait::async_trait;
use oas_application::cache::{Embedding, Objects, QueryIndex, terms};
use oas_domain::{Result, cache::*};
use object_store::{ObjectStore, ObjectStoreExt, PutPayload, aws::AmazonS3Builder, path::Path};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

pub fn unavailable() -> oas_domain::Error {
    oas_domain::Error::new(
        "CACHE_UNAVAILABLE",
        503,
        "缓存依赖暂不可用，业务将继续使用项目路由。",
        "Cache dependencies are unavailable. Requests continue through project routing.",
    )
}
fn env(key: &str) -> String {
    std::env::var(key).unwrap_or_default()
}
#[derive(Clone)]
pub struct HttpEmbedding {
    client: reqwest::Client,
    url: String,
    key: String,
    model: String,
    dimension: usize,
    version: String,
}
impl HttpEmbedding {
    pub fn new() -> Result<Self> {
        let base = env("OAS_CACHE_EMBEDDING_BASE_URL");
        let model = env("OAS_CACHE_EMBEDDING_MODEL");
        let dimension = env("OAS_CACHE_EMBEDDING_DIMENSIONS").parse().unwrap_or(0);
        let revision = env("OAS_CACHE_EMBEDDING_VERSION");
        let version = hash(&format!("{base}/{model}/{dimension}/{revision}/l2-v1"));
        let url = if base.ends_with("/embeddings") {
            base
        } else if base.trim_end_matches('/').ends_with("/v1") {
            format!("{}/embeddings", base.trim_end_matches('/'))
        } else if !base.is_empty() {
            format!("{}/v1/embeddings", base.trim_end_matches('/'))
        } else {
            base
        };
        Ok(Self {
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|_| unavailable())?,
            url,
            key: env("OAS_CACHE_EMBEDDING_API_KEY"),
            model,
            dimension,
            version,
        })
    }
    pub fn configured(&self) -> bool {
        !self.url.is_empty() && !self.model.is_empty() && (1..=65536).contains(&self.dimension)
    }
    pub fn dimension(&self) -> usize {
        self.dimension
    }
}
#[async_trait]
impl Embedding for HttpEmbedding {
    fn configured(&self) -> bool {
        HttpEmbedding::configured(self)
    }
    fn version(&self) -> &str {
        &self.version
    }
    async fn encode(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if !self.configured() {
            return Err(unavailable());
        }
        let mut result = Vec::new();
        for batch in texts.chunks(32) {
            let mut req = self
                .client
                .post(&self.url)
                .json(&json!({"model":self.model,"input":batch,"encoding_format":"float"}));
            if !self.key.is_empty() {
                req = req.bearer_auth(&self.key);
            }
            let body: Value = req
                .send()
                .await
                .map_err(|_| unavailable())?
                .error_for_status()
                .map_err(|_| unavailable())?
                .json()
                .await
                .map_err(|_| unavailable())?;
            let mut indexed = BTreeMap::new();
            for row in body["data"].as_array().ok_or_else(unavailable)? {
                let index = row["index"].as_u64().ok_or_else(unavailable)? as usize;
                let mut vector = row["embedding"]
                    .as_array()
                    .ok_or_else(unavailable)?
                    .iter()
                    .map(|v| {
                        v.as_f64()
                            .filter(|v| v.is_finite())
                            .map(|v| v as f32)
                            .ok_or_else(unavailable)
                    })
                    .collect::<Result<Vec<_>>>()?;
                if vector.len() != self.dimension
                    || index >= batch.len()
                    || indexed.contains_key(&index)
                {
                    return Err(unavailable());
                }
                let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
                if !norm.is_finite() || norm <= 0.0 {
                    return Err(unavailable());
                }
                for v in &mut vector {
                    *v /= norm;
                }
                indexed.insert(index, vector);
            }
            if indexed.len() != batch.len() {
                return Err(unavailable());
            }
            result.extend(indexed.into_values());
        }
        Ok(result)
    }
}

#[derive(Clone)]
pub struct QdrantIndex {
    client: reqwest::Client,
    url: String,
    key: String,
    questions: String,
    features: String,
    dimension: usize,
    shards: usize,
    replication: usize,
    ready: Arc<tokio::sync::Mutex<bool>>,
    publishing: Arc<tokio::sync::Mutex<()>>,
}
impl QdrantIndex {
    pub fn new(binding: &Binding, encoding: &HttpEmbedding) -> Self {
        let suffix = format!(
            "{}_{}",
            binding.namespace.replace('-', ""),
            &encoding.version()[..12]
        );
        Self {
            client: reqwest::Client::new(),
            url: env("OAS_CACHE_QDRANT_URL").trim_end_matches('/').into(),
            key: env("OAS_CACHE_QDRANT_API_KEY"),
            questions: format!("oas_q_{suffix}"),
            features: format!("oas_f_{suffix}"),
            dimension: encoding.dimension(),
            shards: env("OAS_CACHE_QDRANT_SHARDS")
                .parse::<usize>()
                .unwrap_or(1)
                .max(1),
            replication: env("OAS_CACHE_QDRANT_REPLICATION_FACTOR")
                .parse::<usize>()
                .unwrap_or(1)
                .max(1),
            ready: Arc::new(tokio::sync::Mutex::new(false)),
            publishing: Arc::new(tokio::sync::Mutex::new(())),
        }
    }
    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        input: Option<&Value>,
    ) -> Result<Value> {
        if self.url.is_empty() {
            return Err(unavailable());
        }
        let timeout = if method == reqwest::Method::PUT
            || method == reqwest::Method::DELETE
            || path.contains("/points/delete")
        {
            30
        } else {
            5
        };
        let mut r = self
            .client
            .request(method, format!("{}{path}", self.url))
            .timeout(Duration::from_secs(timeout));
        if !self.key.is_empty() {
            r = r.header("api-key", &self.key);
        }
        if let Some(input) = input {
            r = r.json(input);
        }
        r.send()
            .await
            .map_err(|_| unavailable())?
            .error_for_status()
            .map_err(|_| unavailable())?
            .json()
            .await
            .map_err(|_| unavailable())
    }
    pub async fn ensure(&self) -> Result<()> {
        let mut ready = self.ready.lock().await;
        if *ready {
            return Ok(());
        }
        if self.dimension == 0 {
            return Err(unavailable());
        }
        let version = self.request(reqwest::Method::GET, "/", None).await?;
        let mut numbers = version["version"]
            .as_str()
            .unwrap_or("")
            .split('.')
            .filter_map(|s| s.parse::<u32>().ok());
        if (numbers.next().unwrap_or(0), numbers.next().unwrap_or(0)) < (1, 20) {
            return Err(unavailable());
        }
        for collection in [&self.questions, &self.features] {
            let path = format!("/collections/{collection}");
            if self
                .request(reqwest::Method::GET, &path, None)
                .await
                .is_err()
            {
                self.request(reqwest::Method::PUT,&path,Some(&json!({"vectors":{"size":self.dimension,"distance":"Cosine","on_disk":true},"shard_number":self.shards,"replication_factor":self.replication,"write_consistency_factor":self.replication,"on_disk_payload":true,"hnsw_config":{"on_disk":true}}))).await?;
            }
            for (field, schema) in [
                ("project", json!("keyword")),
                ("access_epoch", json!("integer")),
                ("language", json!("keyword")),
                ("time_range", json!("keyword")),
                ("region", json!("keyword")),
                ("expires_at", json!("integer")),
                (
                    "text",
                    json!({"type":"text","tokenizer":"whitespace","lowercase":true,"scoring":true}),
                ),
            ] {
                self.request(
                    reqwest::Method::PUT,
                    &format!("{path}/index?wait=false"),
                    Some(&json!({"field_name":field,"field_schema":schema})),
                )
                .await?;
            }
        }
        *ready = true;
        Ok(())
    }
    fn text(text: &str) -> String {
        terms(text).into_iter().collect::<Vec<_>>().join(" ")
    }
}
#[async_trait]
impl QueryIndex for QdrantIndex {
    async fn purge(&self, questions: &[String], features: &[String]) -> Result<()> {
        let _publishing = self.publishing.lock().await;
        for (collection, ids) in [(&self.questions, questions), (&self.features, features)] {
            if !ids.is_empty() {
                self.request(
                    reqwest::Method::POST,
                    &format!("/collections/{collection}/points/delete?wait=true"),
                    Some(&json!({"points":ids})),
                )
                .await?;
            }
        }
        Ok(())
    }
    async fn collect(
        &self,
        binding: &Binding,
        now: i64,
        reclaim_previous: bool,
        retired: &[String],
    ) -> Result<()> {
        if self.url.is_empty() {
            return Ok(());
        }
        let collections = self
            .request(reqwest::Method::GET, "/collections", None)
            .await?;
        let current = binding.namespace.replace('-', "");
        for row in collections["result"]["collections"]
            .as_array()
            .ok_or_else(unavailable)?
        {
            let Some(name) = row["name"].as_str() else {
                continue;
            };
            let own_old = retired.iter().any(|ns| {
                name.starts_with(&format!("oas_q_{}_", ns.replace('-', "")))
                    || name.starts_with(&format!("oas_f_{}_", ns.replace('-', "")))
            });
            let own_current = name.starts_with(&format!("oas_q_{current}_"))
                || name.starts_with(&format!("oas_f_{current}_"));
            if own_old
                || own_current
                    && reclaim_previous
                    && name != self.questions
                    && name != self.features
            {
                self.request(
                    reqwest::Method::DELETE,
                    &format!("/collections/{name}"),
                    None,
                )
                .await?;
            } else if name == self.questions || name == self.features {
                self.request(
                    reqwest::Method::POST,
                    &format!("/collections/{name}/points/delete?wait=true"),
                    Some(&json!({"filter":{"must":[{"key":"expires_at","range":{"lte":now}}]}})),
                )
                .await?;
            }
        }
        Ok(())
    }
    async fn recall(
        &self,
        scope: &Scope,
        _binding: &Binding,
        query: &Query,
        vector: &[f32],
        limit: usize,
    ) -> Result<Vec<Recall>> {
        self.ensure().await?;
        let filter = json!({"must":[{"key":"project","match":{"value":scope.project}},{"key":"access_epoch","match":{"value":scope.access_epoch}},{"key":"expires_at","range":{"gt":chrono::Utc::now().timestamp_millis()}},{"key":"language","match":{"value":query.language.as_deref().unwrap_or("")}},{"key":"time_range","match":{"value":query.time_range.as_deref().unwrap_or("")}},{"key":"region","match":{"value":query.region.as_deref().unwrap_or("")}}]});
        let path = format!("/collections/{}/points/query", self.questions);
        let dense_input = json!({"query":vector,"filter":filter,"limit":limit,"with_payload":true});
        let dense = self.request(reqwest::Method::POST, &path, Some(&dense_input));
        let words = json!({"query":{"text":Self::text(&query.text)},"using":"text","filter":filter,"limit":limit,"with_payload":true,"with_vector":true});
        let lexical = self.request(reqwest::Method::POST, &path, Some(&words));
        let (dense, lexical) = tokio::try_join!(dense, lexical)?;
        let mut values = BTreeMap::<String, Recall>::new();
        for (rank, row) in dense["result"]["points"]
            .as_array()
            .ok_or_else(unavailable)?
            .iter()
            .enumerate()
        {
            let Some(q) = row["payload"]["question"].as_str() else {
                continue;
            };
            values.insert(
                q.into(),
                Recall {
                    question: q.into(),
                    cosine: row["score"].as_f64().unwrap_or(0.0) as f32,
                    lexical: 0.0,
                    dense_rank: Some(rank + 1),
                    lexical_rank: None,
                },
            );
        }
        for (rank, row) in lexical["result"]["points"]
            .as_array()
            .ok_or_else(unavailable)?
            .iter()
            .enumerate()
        {
            let Some(q) = row["payload"]["question"].as_str() else {
                continue;
            };
            let v = row["vector"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|v| v.as_f64().unwrap_or(0.0) as f32)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let score = row["score"].as_f64().unwrap_or(0.0) as f32;
            let item = values.entry(q.into()).or_insert_with(|| Recall {
                question: q.into(),
                cosine: oas_application::cache::cosine(vector, &v),
                ..Default::default()
            });
            item.lexical = score / (1.0 + score);
            item.lexical_rank = Some(rank + 1);
        }
        Ok(values.into_values().collect())
    }
    async fn exists(&self, scope: &Scope, _binding: &Binding, question: &str) -> Result<bool> {
        let point = super::index_gc::question_id(&scope.project, scope.access_epoch, question);
        let result = self
            .request(
                reqwest::Method::POST,
                &format!("/collections/{}/points", self.questions),
                Some(&json!({"ids":[point],"with_payload":true})),
            )
            .await;
        if result
            .as_ref()
            .is_ok_and(|r| r["result"].as_array().is_some_and(|v| !v.is_empty()))
        {
            return Ok(true);
        }
        // Exact identities remain usable while a replacement vector index is
        // being built. No distance is ever compared across model versions.
        let prefix = self
            .questions
            .rsplit_once('_')
            .map(|(p, _)| format!("{p}_"))
            .unwrap_or_default();
        let collections = self
            .request(reqwest::Method::GET, "/collections", None)
            .await?;
        for name in collections["result"]["collections"]
            .as_array()
            .ok_or_else(unavailable)?
            .iter()
            .filter_map(|r| r["name"].as_str())
            .filter(|name| name.starts_with(&prefix) && *name != self.questions)
        {
            let r = self
                .request(
                    reqwest::Method::POST,
                    &format!("/collections/{name}/points"),
                    Some(&json!({"ids":[point],"with_payload":true})),
                )
                .await?;
            if r["result"].as_array().is_some_and(|v| !v.is_empty()) {
                return Ok(true);
            }
        }
        Ok(false)
    }
    async fn publish(
        &self,
        scope: &Scope,
        _binding: &Binding,
        snapshot: &SearchSnapshot,
        vector: &[f32],
        features: &[(String, Vec<f32>)],
    ) -> Result<()> {
        self.ensure().await?;
        let _publishing = self.publishing.lock().await;
        let id =
            super::index_gc::question_id(&scope.project, scope.access_epoch, &snapshot.question);
        let previous = self
            .request(
                reqwest::Method::POST,
                &format!("/collections/{}/points", self.questions),
                Some(&json!({"ids":[id],"with_payload":true})),
            )
            .await?;
        let expires = previous["result"][0]["payload"]["expires_at"]
            .as_i64()
            .unwrap_or(0)
            .max(snapshot.expires_at);
        let previous_features = if features.is_empty() {
            json!({"result":[]})
        } else {
            self.request(reqwest::Method::POST,&format!("/collections/{}/points",self.features),Some(&json!({"ids":features.iter().map(|(text,_)|point_id(text)).collect::<Vec<_>>(),"with_payload":true}))).await?
        };
        let retained = previous_features["result"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| {
                Some((
                    p["id"].as_str()?.to_owned(),
                    p["payload"]["expires_at"].as_i64()?,
                ))
            })
            .collect::<BTreeMap<_, _>>();
        let points=features.iter().map(|(text,vector)|{let id=point_id(text);let until=retained.get(&id).copied().unwrap_or(0).max(expires);json!({"id":id,"vector":vector,"payload":{"text":Self::text(text),"project":scope.project,"expires_at":until}})}).collect::<Vec<_>>();
        if !points.is_empty() {
            self.request(
                reqwest::Method::PUT,
                &format!("/collections/{}/points?wait=true", self.features),
                Some(&json!({"points":points})),
            )
            .await?;
        }
        self.request(reqwest::Method::PUT,&format!("/collections/{}/points?wait=true",self.questions),Some(&json!({"points":[{"id":id,"vector":vector,"payload":{"project":scope.project,"access_epoch":scope.access_epoch,"question":snapshot.question,"text":Self::text(&snapshot.query.text),"expires_at":expires,"language":snapshot.query.language.as_deref().unwrap_or(""),"time_range":snapshot.query.time_range.as_deref().unwrap_or(""),"region":snapshot.query.region.as_deref().unwrap_or("")}}]}))).await?;
        Ok(())
    }
    async fn features(
        &self,
        _binding: &Binding,
        texts: &[String],
    ) -> Result<Vec<Option<Vec<f32>>>> {
        let ids = texts.iter().map(|t| point_id(t)).collect::<Vec<_>>();
        let result = self
            .request(
                reqwest::Method::POST,
                &format!("/collections/{}/points", self.features),
                Some(&json!({"ids":ids,"with_vector":true,"with_payload":false})),
            )
            .await?;
        let mut features = BTreeMap::new();
        for point in result["result"].as_array().ok_or_else(unavailable)? {
            let v = point["vector"]
                .as_array()
                .ok_or_else(unavailable)?
                .iter()
                .map(|v| v.as_f64().unwrap_or(0.0) as f32)
                .collect::<Vec<_>>();
            features.insert(point["id"].as_str().unwrap_or("").to_owned(), v);
        }
        Ok(ids.iter().map(|id| features.get(id).cloned()).collect())
    }
}

pub struct S3Objects {
    store: Option<Arc<dyn ObjectStore>>,
}
impl S3Objects {
    pub fn new() -> Result<Self> {
        let bucket = env("OAS_CACHE_S3_BUCKET");
        if bucket.is_empty() {
            return Ok(Self { store: None });
        }
        let mut builder = AmazonS3Builder::new()
            .with_bucket_name(bucket)
            .with_region(
                std::env::var("OAS_CACHE_S3_REGION").unwrap_or_else(|_| "us-east-1".into()),
            )
            .with_access_key_id(env("OAS_CACHE_S3_ACCESS_KEY"))
            .with_secret_access_key(env("OAS_CACHE_S3_SECRET_KEY"));
        let endpoint = env("OAS_CACHE_S3_ENDPOINT");
        if !endpoint.is_empty() {
            builder = builder
                .with_allow_http(endpoint.starts_with("http://"))
                .with_endpoint(endpoint)
                .with_virtual_hosted_style_request(false);
        }
        Ok(Self {
            store: Some(Arc::new(builder.build().map_err(|_| unavailable())?)),
        })
    }
}
#[async_trait]
impl Objects for S3Objects {
    async fn delete(&self, key: &str) -> Result<()> {
        self.store
            .as_ref()
            .ok_or_else(unavailable)?
            .delete(&Path::from(key))
            .await
            .map_err(|_| unavailable())?;
        Ok(())
    }
    fn configured(&self) -> bool {
        self.store.is_some()
    }
    async fn put(&self, scope: &Scope, page: &Page) -> Result<String> {
        let key = if page.object_key.is_empty() {
            format!(
                "cache/{}/{}/{}.md",
                scope.project,
                page.content_hash,
                oas_domain::id()
            )
        } else {
            page.object_key.clone()
        };
        self.store
            .as_ref()
            .ok_or_else(unavailable)?
            .put(
                &Path::from(key.clone()),
                PutPayload::from(page.markdown.clone()),
            )
            .await
            .map_err(|_| unavailable())?;
        Ok(key)
    }
    async fn get(&self, key: &str) -> Result<String> {
        let bytes = self
            .store
            .as_ref()
            .ok_or_else(unavailable)?
            .get(&Path::from(key))
            .await
            .map_err(|_| unavailable())?
            .bytes()
            .await
            .map_err(|_| unavailable())?;
        String::from_utf8(bytes.to_vec()).map_err(|_| unavailable())
    }
}

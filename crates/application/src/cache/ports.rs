use async_trait::async_trait;
use oas_domain::{Result, cache::*};

#[async_trait]
pub trait Metadata: Send + Sync {
    async fn begin_reads(
        &self,
        scope: &Scope,
        binding: &Binding,
        keys: &[String],
        request: &str,
        expires: i64,
    ) -> Result<()>;
    async fn end_reads(&self, scope: &Scope, keys: &[String], request: &str) -> Result<()>;
    async fn reading(&self, scope: &Scope, key: &str) -> Result<bool>;
    async fn source_state(&self, scope: &Scope, key: &str) -> Result<PageState>;
    async fn allowed_source(&self, scope: &Scope, source: &str) -> Result<bool>;
    async fn pages(
        &self,
        scope: &Scope,
        binding: &Binding,
        keys: &[String],
        now: i64,
    ) -> Result<Vec<Page>>;
    async fn index_ready(&self, binding: &Binding, encoding: &str) -> Result<bool>;
    async fn effect_started(&self, scope: &Scope) -> Result<()>;
    async fn track_object(
        &self,
        scope: &Scope,
        binding: &Binding,
        key: &str,
        bytes: i64,
    ) -> Result<bool>;
    async fn pin_object(&self, scope: &Scope, binding: &Binding, key: &str) -> Result<String>;
    async fn unpin_object(&self, pin: &str) -> Result<()>;
    async fn valid(&self, scope: &Scope, binding: &Binding) -> Result<bool>;
    async fn register(&self, scope: &Scope, query: &Query) -> Result<()>;
    async fn snapshots(
        &self,
        scope: &Scope,
        binding: &Binding,
        questions: &[String],
        exact_question: &str,
        per_question: usize,
        now: i64,
    ) -> Result<Vec<SearchSnapshot>>;
    async fn save_search(
        &self,
        scope: &Scope,
        binding: &Binding,
        snapshot: &SearchSnapshot,
    ) -> Result<bool>;
    async fn page(
        &self,
        scope: &Scope,
        binding: &Binding,
        key: &str,
        now: i64,
    ) -> Result<Option<Page>>;
    async fn pending_page(
        &self,
        scope: &Scope,
        binding: &Binding,
        key: &str,
        now: i64,
    ) -> Result<Option<Page>>;
    async fn publish_page(
        &self,
        scope: &Scope,
        binding: &Binding,
        page: &Page,
        object: &str,
    ) -> Result<bool>;
    async fn page_epoch(&self, scope: &Scope, key: &str) -> Result<i64>;
    async fn bind_resource(
        &self,
        scope: &Scope,
        binding: &Binding,
        key: &str,
        url: &str,
    ) -> Result<()>;
    #[allow(clippy::too_many_arguments)]
    async fn source_status(
        &self,
        scope: &Scope,
        binding: &Binding,
        key: &str,
        observation: OriginObservation,
        collected: i64,
        epoch: i64,
        order: i64,
        retry_at: Option<i64>,
    ) -> Result<Option<i64>>;
    async fn save_summary(
        &self,
        scope: &Scope,
        binding: &Binding,
        key: &str,
        hash: &str,
        summary: &str,
        version: &str,
    ) -> Result<bool>;
    async fn enqueue(
        &self,
        scope: &Scope,
        binding: &Binding,
        plan: &JobPlan,
        parent: &str,
    ) -> Result<()>;
    async fn record(&self, usage: &Usage) -> Result<()>;
    async fn readable(&self, scope: &Scope, keys: &[String]) -> Result<Vec<String>>;
}
#[async_trait]
pub trait QueryIndex: Send + Sync {
    async fn purge(&self, questions: &[String], features: &[String]) -> Result<()>;
    async fn collect(
        &self,
        binding: &Binding,
        now: i64,
        reclaim_previous: bool,
        retired: &[String],
    ) -> Result<()>;
    async fn recall(
        &self,
        scope: &Scope,
        binding: &Binding,
        query: &Query,
        vector: &[f32],
        limit: usize,
    ) -> Result<Vec<Recall>>;
    async fn exists(&self, scope: &Scope, binding: &Binding, question: &str) -> Result<bool>;
    async fn publish(
        &self,
        scope: &Scope,
        binding: &Binding,
        snapshot: &SearchSnapshot,
        vector: &[f32],
        features: &[(String, Vec<f32>)],
    ) -> Result<()>;
    async fn features(&self, binding: &Binding, texts: &[String]) -> Result<Vec<Option<Vec<f32>>>>;
}
#[async_trait]
pub trait ReuseMatcher: Send + Sync {
    fn profile(&self) -> &str;
    async fn classify(
        &self,
        query: &Query,
        candidates: &[MatchCandidate],
        embedding_version: &str,
        deadline: tokio::time::Instant,
    ) -> Result<MatchResponse>;
}

#[async_trait]
pub trait Embedding: Send + Sync {
    fn configured(&self) -> bool {
        true
    }
    fn version(&self) -> &str;
    async fn encode(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
}
#[async_trait]
pub trait Objects: Send + Sync {
    async fn delete(&self, key: &str) -> Result<()>;
    fn configured(&self) -> bool {
        true
    }
    async fn put(&self, scope: &Scope, page: &Page) -> Result<String>;
    async fn get(&self, key: &str) -> Result<String>;
}
#[derive(Debug, Clone, Copy)]
pub enum Acquired<'a> {
    Search(&'a SearchSnapshot),
    Page(&'a Page),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteReceipt {
    Published,
    NotAdmitted,
    Superseded,
}

pub enum PageRead {
    Hit(Box<Page>),
    Miss,
    Gone(i64),
}

pub struct SelectedPage<'a> {
    pub url: &'a str,
    pub key: &'a str,
    pub object_epoch: i64,
    pub existing: Option<&'a Page>,
    pub acquired: bool,
    pub summary_version: Option<&'a str>,
}

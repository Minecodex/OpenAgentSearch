mod public_recall;
use oas_adapters::{
    cache::{self, CacheMetadata},
    repository::Repository,
};
use oas_application::cache::{
    Acquired, CacheHandler, CacheService, CacheSettings, Metadata, V1CacheHandler, WriteReceipt,
};
use oas_domain::{BROWSER_READER, BROWSER_SEARCH, Command, Hit, Project, Result, cache::*, id};
use serde_json::{Value, json};
use std::sync::Arc;

struct Fixture {
    repo: Repository,
    db: String,
    admin: sqlx::PgPool,
    service: Arc<CacheService>,
    metadata: CacheMetadata,
    project: Project,
    scope: Scope,
}
impl Fixture {
    async fn new() -> Self {
        let url = std::env::var("OAS_TEST_DATABASE_URL").expect("disposable database required");
        assert!(url.contains("oas-local-") || url.contains("oas-plan2-db"));
        let admin = sqlx::PgPool::connect(&url).await.unwrap();
        let db = format!("oas_cache_case_{}", uuid::Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE DATABASE {db}"))
            .execute(&admin)
            .await
            .unwrap();
        let options = url
            .parse::<sqlx::postgres::PgConnectOptions>()
            .unwrap()
            .database(&db);
        let repo = Repository::connect(options, &"01".repeat(32))
            .await
            .unwrap();
        repo.migrate().await.unwrap();
        repo.bootstrap("admin", "local-cache-fixture")
            .await
            .unwrap();
        let service = cache::build(repo.clone()).await.unwrap();
        let raw=repo.save("projects",None,json!({"name":"Cache regression fixture","search_pools":[[BROWSER_SEARCH]],"reader_pools":[[BROWSER_READER]],"rewrite_count":0,"cache_enabled":true})).await.unwrap();
        let project: Project = serde_json::from_value(raw["project"].clone()).unwrap();
        let metadata = CacheMetadata {
            repo: repo.clone(),
            settings: service.settings.clone(),
        };
        let scope = Scope::from_project(&project);
        Self {
            repo,
            db,
            admin,
            service,
            metadata,
            project,
            scope,
        }
    }
    async fn close(self) {
        self.repo.close().await;
        sqlx::query(&format!("DROP DATABASE {} WITH (FORCE)", self.db))
            .execute(&self.admin)
            .await
            .unwrap();
    }
    async fn selected(&self, question: &Query, current: &Query) -> Vec<SearchSnapshot> {
        self.metadata
            .snapshots(
                &self.scope,
                &self.service.binding,
                &[question.id()],
                &current.id(),
                2,
                now(),
            )
            .await
            .unwrap()
    }
    async fn count(&self, table: &str) -> i64 {
        assert!(
            [
                "cache_pages",
                "cache_jobs",
                "cache_snapshots",
                "cache_registry"
            ]
            .contains(&table)
        );
        sqlx::query_scalar(&format!("SELECT count(*) FROM {table} WHERE scope=$1"))
            .bind(&self.scope.project)
            .fetch_one(&self.repo.pool)
            .await
            .unwrap()
    }
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn snapshot(name: &str, time: i64, links: usize) -> SearchSnapshot {
    let query = Query::new(&Command::default(), name);
    SearchSnapshot{request_id:id(),id:id(),question:query.id(),query,source:BROWSER_SEARCH.into(),call_id:id(),collected_at:time,acquisition_order:0,expires_at:time+1800000,partial:false,engine_answer:None,cards:vec![],hits:(0..links).map(|i| serde_json::from_value::<Hit>(json!({"url":format!("https://example.org/guide/{i}"),"title":"Guide","snippet":"Notes","rank":i+1})).unwrap()).collect()}
}

#[tokio::test]
async fn disabled_inventory_expires_even_without_a_hot_board_and_does_not_consume_future_capacity()
{
    let f = Fixture::new().await;
    let s = snapshot("closing soon", now(), 5);
    let url = s.hits[0].url.clone();
    assert_eq!(
        f.service.acquire_search(&f.scope, s.clone()).await.unwrap(),
        WriteReceipt::Published
    );
    let page = Page {
        final_url: None,
        key: page_key(&url, false).unwrap(),
        url,
        source: BROWSER_READER.into(),
        call_id: id(),
        title: "Guide".into(),
        markdown: "body".into(),
        collected_at: now(),
        acquisition_order: 0,
        expires_at: now() + 3600000,
        content_hash: hash("body"),
        summary: None,
        summary_version: None,
        object_epoch: 0,
        object_key: String::new(),
    };
    assert!(
        f.metadata
            .track_object(&f.scope, &f.service.binding, "fixture/immutable", 4)
            .await
            .unwrap()
    );
    assert!(
        f.metadata
            .publish_page(&f.scope, &f.service.binding, &page, "fixture/immutable")
            .await
            .unwrap()
    );
    let mut input = json!(f.project);
    let fields = input.as_object_mut().unwrap();
    for key in ["id", "version", "cache_epoch", "cache_access_epoch"] {
        fields.remove(key);
    }
    fields.insert("cache_enabled".into(), json!(false));
    fields.insert("expected_version".into(), json!(f.project.version));
    f.repo
        .save("projects", Some(&f.scope.project), input)
        .await
        .unwrap();
    for table in ["cache_pages", "cache_snapshots"] {
        sqlx::query(&format!("UPDATE {table} SET expires_at=$1"))
            .bind(now() - 1)
            .execute(&f.repo.pool)
            .await
            .unwrap();
    }
    cache::hotness::refresh(&f.metadata, &f.service.binding, f.service.handler.as_ref())
        .await
        .unwrap();
    // Isolate metadata GC from index transport. The fixture hasn't published any points.
    let service = with_index(&f, Arc::new(HealthyIndex));
    cache::garbage::collect(&f.metadata, &service)
        .await
        .unwrap();
    assert_eq!(
        (
            f.count("cache_pages").await,
            f.count("cache_snapshots").await
        ),
        (0, 0)
    );
    let totals: (i64, i64) =
        sqlx::query_as("SELECT snapshots,object_bytes FROM cache_storage_totals")
            .fetch_one(&f.repo.pool)
            .await
            .unwrap();
    assert_eq!(
        totals,
        (0, 4),
        "physical bytes are charged through the orphan grace period"
    );
    sqlx::query("DELETE FROM cache_gc_objects WHERE object_key='fixture/immutable'")
        .execute(&f.repo.pool)
        .await
        .unwrap();
    let bytes: i64 = sqlx::query_scalar("SELECT object_bytes FROM cache_storage_totals")
        .fetch_one(&f.repo.pool)
        .await
        .unwrap();
    assert_eq!(bytes, 0);
    f.close().await;
}

#[tokio::test]
async fn stale_hot_members_of_closed_projects_cannot_starve_enabled_projects() {
    let f = Fixture::new().await;
    let binding = &f.service.binding;
    let stale = "00000000-0000-4000-8000-000000000010";
    let mut body = json!(f.project);
    body["cache_enabled"] = json!(false);
    body["id"] = json!(stale);
    sqlx::query("INSERT INTO resources(id,kind,body) VALUES($1::text::uuid,'projects',$2)")
        .bind(stale)
        .bind(body)
        .execute(&f.repo.pool)
        .await
        .unwrap();
    let s = snapshot("active hot topic", now() - 2_000_000, 5);
    f.metadata.save_search(&f.scope, binding, &s).await.unwrap();
    f.metadata
        .record(&Usage {
            event_id: id(),
            request: id(),
            lookup: id(),
            project: f.scope.project.clone(),
            kind: "list".into(),
            object: s.question.clone(),
            outcome: "reference".into(),
            at: now(),
        })
        .await
        .unwrap();
    sqlx::query("INSERT INTO cache_snapshots(id,namespace,scope,question,source,collected_at,expires_at,body) SELECT gen_random_uuid(),$1,$2,i::text,$3,0,1,$4 FROM generate_series(1,256) q(i)")
        .bind(&binding.namespace).bind(stale).bind(BROWSER_SEARCH).bind(json!(s)).execute(&f.repo.pool).await.unwrap();
    sqlx::query("INSERT INTO cache_hot_members SELECT $1,'list',i::text,true,true,0 FROM generate_series(1,256) q(i)").bind(stale).execute(&f.repo.pool).await.unwrap();
    cache::hotness::refresh(&f.metadata, binding, f.service.handler.as_ref())
        .await
        .unwrap();
    let scheduled: Vec<String> =
        sqlx::query_scalar("SELECT scope FROM cache_jobs WHERE reason='hot_expiry'")
            .fetch_all(&f.repo.pool)
            .await
            .unwrap();
    assert_eq!(scheduled, vec![f.scope.project.clone()]);
    f.close().await;
}

#[tokio::test]
async fn permissions_and_material_are_checked_before_selecting_two_snapshots() {
    let f = Fixture::new().await;
    let t = now();
    let first = snapshot("manual", t, 5);
    f.metadata
        .save_search(&f.scope, &f.service.binding, &first)
        .await
        .unwrap();
    let denied = "https://example.org/retired-citation";
    let key = page_key(denied, false).unwrap();
    for i in 1..=3 {
        let mut ai = snapshot("manual", t + i, 0);
        ai.engine_answer = Some(json!({"content":"Answer","sources":[{"url":denied}]}));
        f.metadata
            .save_search(&f.scope, &f.service.binding, &ai)
            .await
            .unwrap();
    }
    assert_eq!(
        f.selected(
            &first.query,
            &Query::new(&Command::default(), "similar manual")
        )
        .await[0]
            .hits
            .len(),
        5
    );
    assert_eq!(f.selected(&first.query, &first.query).await.len(), 2);
    f.metadata
        .source_status(
            &f.scope,
            &f.service.binding,
            &key,
            OriginObservation::TargetDenied,
            t + 10,
            0,
            0,
            None,
        )
        .await
        .unwrap();
    let after = f.selected(&first.query, &first.query).await;
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].id, first.id);
    let state = f.metadata.source_state(&f.scope, &key).await.unwrap();
    assert_eq!(state.access, PageAccess::Denied);
    assert!(
        f.metadata
            .source_status(
                &f.scope,
                &f.service.binding,
                &key,
                OriginObservation::Http(200),
                t + 11,
                state.epoch,
                0,
                None,
            )
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query("UPDATE resources SET body=jsonb_set(body,'{cache_access_epoch}',to_jsonb($2::bigint)) WHERE id::text=$1")
        .bind(&f.scope.project).bind(f.scope.access_epoch+1).execute(&f.repo.pool).await.unwrap();
    assert_eq!(
        f.metadata
            .source_state(&f.scope, &key)
            .await
            .unwrap_err()
            .code,
        "ACCESS_DENIED"
    );
    let mut refreshed = f.scope.clone();
    refreshed.access_epoch += 1;
    assert_eq!(
        f.metadata
            .source_state(&refreshed, &key)
            .await
            .unwrap()
            .access,
        PageAccess::Open
    );
    f.close().await;
}

#[tokio::test]
async fn receipts_separate_policy_rejection_capacity_and_committed_material() {
    let f = Fixture::new().await;
    let short = snapshot("three-page query", now(), 3);
    assert_eq!(
        f.service
            .acquire_search(&f.scope, short.clone())
            .await
            .unwrap(),
        WriteReceipt::NotAdmitted
    );
    let v2 = cache::build_with_handler(f.repo.clone(), Arc::new(ThreePagePolicy))
        .await
        .unwrap();
    assert_ne!(v2.binding.namespace, f.service.binding.namespace);
    assert_eq!(
        v2.acquire_search(&f.scope, short.clone()).await.unwrap(),
        WriteReceipt::Published
    );
    let expires: i64 =
        sqlx::query_scalar("SELECT expires_at-collected_at FROM cache_snapshots WHERE id::text=$1")
            .bind(&short.id)
            .fetch_one(&f.repo.pool)
            .await
            .unwrap();
    assert_eq!(expires, 3000);
    let task = f
        .metadata
        .claim(&v2.binding, true, true)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(task.payload_version, 2);
    let cap = cache::garbage::limits().unwrap().1;
    sqlx::query("UPDATE cache_storage_totals SET snapshots=$1")
        .bind(cap)
        .execute(&f.repo.pool)
        .await
        .unwrap();
    let err = v2
        .acquire_search(&f.scope, snapshot("quota reached", now(), 5))
        .await
        .unwrap_err();
    assert_eq!(err.code, "CACHE_CAPACITY_EXCEEDED");
    assert_eq!(f.count("cache_snapshots").await, 1);
    f.close().await;
}

#[tokio::test]
async fn expired_lease_waits_for_browser_cleanup_and_preserves_the_original_budget() {
    let f = Fixture::new().await;
    let binding = &f.service.binding;
    let plan = JobPlan {
        kind: "list".into(),
        target: id(),
        reason: "similar_single_hit".into(),
        input: json!({}),
        object_epoch: 0,
    };
    f.metadata
        .enqueue(&f.scope, binding, &plan, "test")
        .await
        .unwrap();
    let original = f
        .metadata
        .claim(binding, true, true)
        .await
        .unwrap()
        .unwrap();
    let request = id();
    f.metadata
        .execution_started(&original, &request, json!({"request_id":request}))
        .await
        .unwrap();
    f.metadata.dispatched(&original).await.unwrap();
    let job = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO browser_jobs(id,pod_uid,owner,body,state) VALUES($1,'pod','owner',$2,'open')",
    )
    .bind(job)
    .bind(json!({"request_id":request}))
    .execute(&f.repo.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE cache_jobs SET lease_until=$1 WHERE id::text=$2")
        .bind(now() - 10)
        .bind(&original.id)
        .execute(&f.repo.pool)
        .await
        .unwrap();
    assert!(
        f.metadata
            .claim(binding, true, true)
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query("DELETE FROM browser_jobs WHERE id=$1")
        .bind(job)
        .execute(&f.repo.pool)
        .await
        .unwrap();
    let recovered = f
        .metadata
        .claim(binding, true, true)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovered.id, original.id);
    assert_ne!(recovered.lease, original.lease);
    assert_eq!(recovered.attempt, 1);
    assert_eq!(recovered.deadline, original.deadline);
    assert!(f.metadata.dispatched(&original).await.is_err());
    f.metadata.complete(&original, None, None).await.unwrap();
    assert!(f.metadata.valid(&recovered.scope, binding).await.unwrap());
    f.close().await;
}

#[tokio::test]
async fn reclaiming_a_committed_search_keeps_its_durable_receipt() {
    let f = Fixture::new().await;
    let s = snapshot("completed before disconnect", now(), 5);
    let plan = JobPlan {
        kind: "list".into(),
        target: s.question.clone(),
        reason: "similar_single_hit".into(),
        input: json!({"query":s.query}),
        object_epoch: 0,
    };
    let binding = &f.service.binding;
    f.metadata
        .enqueue(&f.scope, binding, &plan, "scenario")
        .await
        .unwrap();
    let first = f
        .metadata
        .claim(binding, true, true)
        .await
        .unwrap()
        .unwrap();
    f.metadata.dispatched(&first).await.unwrap();
    assert_eq!(
        f.service
            .acquire_search(&first.scope, s.clone())
            .await
            .unwrap(),
        WriteReceipt::Published
    );
    // Simulate acknowledgement loss after commit and an expired old API lease.
    sqlx::query("UPDATE cache_jobs SET lease_until=$1 WHERE id::text=$2")
        .bind(now() - 1)
        .bind(&first.id)
        .execute(&f.repo.pool)
        .await
        .unwrap();
    let retry = f
        .metadata
        .claim(binding, true, true)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retry.id, first.id);
    assert_eq!(
        f.metadata
            .committed_version(&retry, &retry.scope)
            .await
            .unwrap(),
        Some(s.id)
    );
    assert_eq!(retry.attempt, 1);
    f.metadata.complete(&retry, None, None).await.unwrap();
    let state: (String, i32) =
        sqlx::query_as("SELECT state,attempts FROM cache_jobs WHERE id::text=$1")
            .bind(&retry.id)
            .fetch_one(&f.repo.pool)
            .await
            .unwrap();
    assert_eq!(state, ("completed".into(), 1));
    f.close().await;
}

#[tokio::test]
async fn locked_statistics_cannot_displace_an_exact_hit() {
    let f = Fixture::new().await;
    let service = with_index(&f, Arc::new(HealthyIndex));
    let s = snapshot("verified guide", now(), 5);
    service.acquire_search(&f.scope, s.clone()).await.unwrap();
    sqlx::query("UPDATE cache_index_control SET ready=true,encoding='fixture'")
        .execute(&f.repo.pool)
        .await
        .unwrap();
    let _ = oas_application::cache::terms("warm tokenizer");
    let mut lock = f.repo.pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE cache_registry IN SHARE MODE")
        .execute(&mut *lock)
        .await
        .unwrap();
    let found = service
        .lookup(&f.scope, &s.query, &id(), &id(), service.lookup_deadline())
        .await;
    assert!(found.exact);
    assert!(!found.bypass);
    assert_eq!(found.ranked.len(), 5);
    lock.rollback().await.unwrap();
    f.close().await;
}

struct ThreePagePolicy;
#[async_trait::async_trait]
impl CacheHandler for ThreePagePolicy {
    fn version(&self) -> &str {
        "fixture-v2"
    }
    fn schema_version(&self) -> i32 {
        2
    }
    fn payload_version(&self) -> i32 {
        2
    }
    fn retention(&self, m: Acquired<'_>, _: &CacheSettings) -> Option<i64> {
        match m {
            Acquired::Search(s) if s.hits.len() >= 3 => Some(s.hits.len() as i64),
            _ => None,
        }
    }
    fn recall_limit(&self) -> usize {
        20
    }
    fn snapshots_per_question(&self) -> usize {
        2
    }
    fn rank_score(&self, c: Option<f32>, l: f32, r: usize) -> f32 {
        V1CacheHandler.rank_score(c, l, r)
    }
    fn hot_slots(&self, p: &HotPolicy, n: usize, r: bool) -> usize {
        p.slots(n, n, r)
    }
    async fn select(
        &self,
        input: oas_application::cache::Selection<'_>,
        snapshots: Vec<SearchSnapshot>,
    ) -> Result<Lookup> {
        V1CacheHandler.select(input, snapshots).await
    }
    fn on_selected(&self, page: oas_application::cache::SelectedPage<'_>) -> Option<JobPlan> {
        V1CacheHandler.on_selected(page)
    }
    fn on_expired(&self, k: &str, t: &str, e: i64, i: Value) -> JobPlan {
        V1CacheHandler.on_expired(k, t, e, i)
    }
    fn execute_job(&self, t: &Task) -> Result<JobPlan> {
        Ok(t.plan.clone())
    }
}
use async_trait::async_trait;
use oas_application::cache::{Embedding, QueryIndex};
struct HealthyIndex;
#[async_trait]
impl Embedding for HealthyIndex {
    fn version(&self) -> &str {
        "fixture"
    }
    async fn encode(&self, t: &[String]) -> Result<Vec<Vec<f32>>> {
        Ok(t.iter().map(|_| vec![1.0]).collect())
    }
}
#[async_trait]
impl QueryIndex for HealthyIndex {
    async fn purge(&self, _: &[String], _: &[String]) -> Result<()> {
        Ok(())
    }
    async fn collect(&self, _: &Binding, _: i64, _: bool, _: &[String]) -> Result<()> {
        Ok(())
    }
    async fn recall(
        &self,
        _: &Scope,
        _: &Binding,
        q: &Query,
        _: &[f32],
        _: usize,
    ) -> Result<Vec<Recall>> {
        Ok(vec![Recall {
            question: q.id(),
            cosine: 1.0,
            lexical: 1.0,
            ..Default::default()
        }])
    }
    async fn exists(&self, _: &Scope, _: &Binding, _: &str) -> Result<bool> {
        Ok(true)
    }
    async fn publish(
        &self,
        _: &Scope,
        _: &Binding,
        _: &SearchSnapshot,
        _: &[f32],
        _: &[(String, Vec<f32>)],
    ) -> Result<()> {
        Ok(())
    }
    async fn features(&self, _: &Binding, t: &[String]) -> Result<Vec<Option<Vec<f32>>>> {
        Ok(t.iter().map(|_| Some(vec![1.0])).collect())
    }
}
fn with_index(f: &Fixture, index: Arc<dyn QueryIndex>) -> CacheService {
    CacheService {
        metadata: f.service.metadata.clone(),
        objects: f.service.objects.clone(),
        binding: f.service.binding.clone(),
        handler: f.service.handler.clone(),
        settings: f.service.settings.clone(),
        embedding: Arc::new(HealthyIndex),
        index,
    }
}

#[tokio::test]
async fn rolling_windows_and_inventory_use_the_same_deliverable_material() {
    let f = Fixture::new().await;
    let at = now();
    let mut s = snapshot("windowed reports", at, 5);
    s.query.time_range = Some("day".into());
    s.question = s.query.id();
    let key = page_key(&s.hits[0].url, false).unwrap();
    s.hits[0].published_at = Some(at - 86_399_999);
    // A duplicate URL with an unverified publication date must not inherit its sibling's evidence.
    s.hits[1].url = s.hits[0].url.clone();
    s.hits[2].published_at = Some(at - 86_400_001);
    s.hits[3].published_at = Some(at + 1000);
    s.engine_answer = Some(json!({"content":"previous answer","sources":[]}));
    s.cards = vec![json!({"title":"old card"})];
    f.metadata
        .save_search(&f.scope, &f.service.binding, &s)
        .await
        .unwrap();
    sqlx::query("UPDATE cache_snapshots SET indexed=true")
        .execute(&f.repo.pool)
        .await
        .unwrap();
    let select = |t| {
        let q = s.question.clone();
        let f = &f;
        async move {
            f.metadata
                .snapshots(
                    &f.scope,
                    &f.service.binding,
                    std::slice::from_ref(&q),
                    &q,
                    2,
                    t,
                )
                .await
                .unwrap()
        }
    };
    let selected = select(at).await;
    assert_eq!(selected[0].hits.len(), 1);
    assert_eq!(selected[0].hits[0].published_at, s.hits[0].published_at);
    assert!(selected[0].engine_answer.is_none() && selected[0].cards.is_empty());
    assert!(select(at + 2).await.is_empty());
    assert_eq!(select(at + 1000).await[0].hits[0].url, s.hits[3].url);
    // Exclude the future-dated item at all subsequent inventory samples.
    for url in [&s.hits[0].url, &s.hits[3].url] {
        let id = page_key(url, false).unwrap();
        f.metadata
            .source_status(
                &f.scope,
                &f.service.binding,
                &id,
                OriginObservation::Http(410),
                at,
                0,
                0,
                None,
            )
            .await
            .unwrap();
    }
    assert_eq!(
        f.metadata
            .source_state(&f.scope, &key)
            .await
            .unwrap()
            .access,
        PageAccess::Gone
    );
    let filters = cache::management::Filters {
        scope: Some(&f.scope.project),
        origin: None,
        operation: None,
        kind: None,
        since: at - 1000,
        until: at + 1000,
    };
    let view = cache::management::overview(&f.repo, &f.service.binding.namespace, &filters)
        .await
        .unwrap();
    assert_eq!(view["inventory"]["questions"], 0);
    assert_eq!(view["inventory"]["snapshots"], 0);
    f.close().await;
}

#[tokio::test]
async fn repeated_gc_reserves_physical_bytes_without_evicting_live_pages_twice() {
    let f = Fixture::new().await;
    let (quota, _) = cache::garbage::limits().unwrap();
    let size = quota / 100;
    let at = now();
    sqlx::query("INSERT INTO cache_hot_boards VALUES($1,'content',$2)")
        .bind(&f.scope.project)
        .bind(at)
        .execute(&f.repo.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO cache_gc_objects SELECT 'blob-'||n,$1,$2 FROM generate_series(1,95) n",
    )
    .bind(at)
    .bind(size)
    .execute(&f.repo.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO cache_pages(namespace,scope,page_key,source,collected_at,expires_at,object_epoch,object_key,body) SELECT $1,$2,'page-'||n,$3,$4,$5,0,'blob-'||n,jsonb_build_object('size_bytes',$6::bigint) FROM generate_series(1,95) n")
        .bind(&f.service.binding.namespace).bind(&f.scope.project).bind(BROWSER_READER).bind(at).bind(at+3600000).bind(size).execute(&f.repo.pool).await.unwrap();
    let service = with_index(&f, Arc::new(HealthyIndex));
    for _ in 0..2 {
        cache::garbage::collect(&f.metadata, &service)
            .await
            .unwrap();
        assert_eq!(f.count("cache_pages").await, 80);
        let charged: i64 = sqlx::query_scalar("SELECT object_bytes FROM cache_storage_totals")
            .fetch_one(&f.repo.pool)
            .await
            .unwrap();
        assert_eq!(charged, 95 * size);
    }
    f.close().await;
}

#[tokio::test]
async fn v2_fuses_then_reviews_eight_eligible_candidates_and_reserves_the_exact_source() {
    use oas_application::cache::{ReuseMatcher, Selection, V2CacheHandler};
    struct Verify;
    #[async_trait::async_trait]
    impl ReuseMatcher for Verify {
        fn profile(&self) -> &str {
            "unit-profile"
        }
        async fn classify(
            &self,
            _: &Query,
            items: &[MatchCandidate],
            _: &str,
            _: tokio::time::Instant,
        ) -> Result<MatchResponse> {
            assert_eq!(items.len(), 8);
            assert_eq!(items[0].question, "Guide 1");
            for candidate in items {
                let distinct_pages = if candidate.question == "Guide 2" {
                    1
                } else {
                    3
                };
                assert_eq!(candidate.materials.len(), distinct_pages);
                assert!(!candidate.question.contains("14.04"));
            }
            let scores = items
                .iter()
                .rev()
                .map(|c| MatchScore {
                    question_id: c.question_id.clone(),
                    label: ReuseLabel::Reusable,
                    reusable_score: if c.question == "Guide 3" { 0.99 } else { 0.9 },
                })
                .collect();
            Ok(MatchResponse {
                profile: self.profile().into(),
                threshold: Some(0.8),
                decisions: scores,
            })
        }
    }
    let f = Fixture::new().await;
    let policy = Arc::new(V2CacheHandler::new(Arc::new(Verify)));
    let service = cache::build_with_handler(f.repo.clone(), policy.clone())
        .await
        .unwrap();
    let now = now();
    let exact = snapshot("Ubuntu 13.04 startup", now, 5);
    service
        .acquire_search(&f.scope, exact.clone())
        .await
        .unwrap();
    let mut snapshots = vec![exact.clone()];
    let mut recall = vec![];
    let mut best = String::new();
    for i in 0..12 {
        let mut s = snapshot(
            &if i == 0 {
                "Ubuntu 14.04".into()
            } else {
                format!("Guide {i}")
            },
            now,
            5,
        );
        for (j, h) in s.hits.iter_mut().enumerate() {
            h.title = format!("Ubuntu 13.04 page {}", if i == 2 { 0 } else { j });
        }
        if i == 3 {
            best = s.question.clone();
        }
        service.acquire_search(&f.scope, s.clone()).await.unwrap();
        recall.push(Recall {
            question: s.question.clone(),
            dense_rank: (i != 1).then_some(i + 1),
            lexical_rank: if i <= 1 { Some(i + 1) } else { None },
            cosine: 0.1,
            ..Default::default()
        });
        snapshots.push(s);
    }
    let input = Selection {
        query: &exact.query,
        recall: &recall,
        scope: &f.scope,
        binding: &service.binding,
        metadata: service.metadata.as_ref(),
        legacy_threshold: 0.92,
        embedding_version: "fixture",
        deadline: service.lookup_deadline(),
    };
    let found = policy.select(input, snapshots).await.unwrap();
    assert_eq!(found.questions, vec![exact.question, best]);
    assert!(!found.search_needed);
    assert_eq!(found.verification.unwrap().decisions.len(), 8);
    f.close().await;
}

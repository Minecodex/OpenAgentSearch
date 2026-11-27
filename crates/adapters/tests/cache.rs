#![cfg(feature = "database-tests")]
#[path = "cache_cases/mod.rs"]
mod cache_cases;
use oas_adapters::{
    cache::{self, CacheMetadata},
    repository::Repository,
};
use oas_application::cache::Metadata;
use oas_domain::{Command, Hit, Project, cache::*};
use serde_json::json;
use sqlx::Row;

#[tokio::test]
async fn persistent_cache_guards_queue_body_versions_and_real_index_storage() {
    let url = std::env::var("OAS_TEST_DATABASE_URL")
        .expect("A disposable cache test database is required");
    assert!(url.contains("oas-plan2-db") || url.contains("oas-local-"));
    let admin = sqlx::PgPool::connect(&url).await.unwrap();
    let database = format!("oas_cache_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {database}"))
        .execute(&admin)
        .await
        .unwrap();
    let options = url
        .parse::<sqlx::postgres::PgConnectOptions>()
        .unwrap()
        .database(&database);
    let repo = Repository::connect(options, &"01".repeat(32))
        .await
        .unwrap();
    repo.migrate().await.unwrap();
    repo.bootstrap("admin", "cache-test-only").await.unwrap();
    let cache = cache::build(repo.clone()).await.unwrap();
    let made=repo.save("projects",None,json!({"name":"Cache transaction fixture","search_pools":[[oas_domain::BROWSER_SEARCH]],"reader_pools":[[oas_domain::BROWSER_READER]],"rewrite_count":0,"cache_enabled":true})).await.unwrap();
    let project: Project = serde_json::from_value(made["project"].clone()).unwrap();
    let scope = Scope::from_project(&project);
    let metadata = CacheMetadata {
        repo: repo.clone(),
        settings: cache.settings.clone(),
    };
    assert!(metadata.valid(&scope, &cache.binding).await.unwrap());
    let time = chrono::Utc::now().timestamp_millis();
    let query = Query::new(&Command::default(), &format!("Rust cache {}", project.id));
    metadata.register(&scope, &query).await.unwrap();
    let hits = (0..10)
        .map(|i| Hit {
            url: format!("https://example.org/{}/{i}", project.id),
            title: format!("Rust cache {i}"),
            snippet: "Cache guide".into(),
            summary: None,
            cached_summary_key: None,
            cache: None,
            published_at: None,
            coverage: Coverage::Unknown,
            content: None,
            rank: i + 1,
            variant_id: "Q0".into(),
            call_id: oas_domain::id(),
        })
        .collect();
    let snapshot = SearchSnapshot {
        request_id: oas_domain::id(),
        id: oas_domain::id(),
        question: query.id(),
        query: query.clone(),
        source: oas_domain::BROWSER_SEARCH.into(),
        call_id: oas_domain::id(),
        collected_at: time,
        acquisition_order: 0,
        expires_at: time + 1800000,
        hits,
        partial: false,
        engine_answer: None,
        cards: vec![],
    };
    assert!(
        metadata
            .save_search(&scope, &cache.binding, &snapshot)
            .await
            .unwrap()
    );
    assert_eq!(
        metadata
            .snapshots(&scope, &cache.binding, &[query.id()], &query.id(), 2, time)
            .await
            .unwrap()[0]
            .hits
            .len(),
        10
    );
    let mut page = Page {
        final_url: None,
        key: page_key(&snapshot.hits[0].url, false).unwrap(),
        url: snapshot.hits[0].url.clone(),
        source: oas_domain::BROWSER_READER.into(),
        call_id: oas_domain::id(),
        title: "Rust cache".into(),
        markdown: "# Rust cache\n\nCurrent material.".into(),
        collected_at: time,
        acquisition_order: 0,
        expires_at: time + 21600000,
        content_hash: hash("# Rust cache\n\nCurrent material."),
        summary: None,
        summary_version: None,
        object_epoch: 0,
        object_key: String::new(),
    };
    assert!(
        metadata
            .publish_page(&scope, &cache.binding, &page, "fixture/current.md")
            .await
            .unwrap()
    );
    assert!(
        metadata
            .save_summary(
                &scope,
                &cache.binding,
                &page.key,
                &page.content_hash,
                "Current summary",
                "model-v1"
            )
            .await
            .unwrap()
    );
    let old = page.clone();
    page.collected_at += 1;
    page.markdown = "Newer material".into();
    page.content_hash = hash(&page.markdown);
    assert!(
        metadata
            .publish_page(&scope, &cache.binding, &page, "fixture/new.md")
            .await
            .unwrap()
    );
    assert!(
        !metadata
            .publish_page(&scope, &cache.binding, &old, "fixture/old.md")
            .await
            .unwrap()
    );
    assert!(
        metadata
            .page(&scope, &cache.binding, &page.key, time)
            .await
            .unwrap()
            .unwrap()
            .summary
            .is_none()
    );
    assert!(
        !metadata
            .save_summary(
                &scope,
                &cache.binding,
                &page.key,
                &old.content_hash,
                "Late old summary",
                "model-v1"
            )
            .await
            .unwrap()
    );
    metadata
        .source_status(
            &scope,
            &cache.binding,
            &page.key,
            OriginObservation::Http(410),
            time + 10,
            0,
            0,
            None,
        )
        .await
        .unwrap();
    assert!(
        metadata
            .page(&scope, &cache.binding, &page.key, time)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        !metadata
            .publish_page(&scope, &cache.binding, &page, "fixture/late.md")
            .await
            .unwrap()
    );
    page.collected_at = time + 20;
    verify_restore(
        &metadata,
        &scope,
        &cache.binding,
        &mut page,
        "fixture/restored.md",
    )
    .await;

    // Queue overflow preserves the newest demands and never executes old epochs.
    let mut settings = cache.settings.clone();
    settings.queue_capacity = 2;
    let small = CacheMetadata {
        repo: repo.clone(),
        settings,
    };
    sqlx::query("DELETE FROM cache_jobs WHERE scope=$1")
        .bind(&scope.project)
        .execute(&repo.pool)
        .await
        .unwrap();
    for n in 0..3 {
        small
            .enqueue(
                &scope,
                &cache.binding,
                &JobPlan {
                    kind: "content".into(),
                    target: format!("target-{n}"),
                    reason: "selected_page".into(),
                    input: json!({"url":format!("https://example.org/{n}")}),
                    object_epoch: 0,
                },
                "test",
            )
            .await
            .unwrap();
    }
    let evicted = sqlx::query_scalar::<_, String>(
        "SELECT target FROM cache_jobs WHERE scope=$1 AND state='evicted'",
    )
    .bind(&scope.project)
    .fetch_one(&repo.pool)
    .await
    .unwrap();
    assert_eq!(evicted, "target-0");
    let task = small
        .claim(&cache.binding, true, true)
        .await
        .unwrap()
        .unwrap();
    small.dispatched(&task).await.unwrap();
    small.dispatched(&task).await.unwrap();
    let attempts =
        sqlx::query_scalar::<_, i32>("SELECT attempts FROM cache_jobs WHERE id::text=$1")
            .bind(&task.id)
            .fetch_one(&repo.pool)
            .await
            .unwrap();
    assert_eq!(attempts, 1);
    let mut input = made["project"].clone();
    let fields = input.as_object_mut().unwrap();
    fields.remove("id");
    fields.remove("cache_epoch");
    fields.remove("cache_access_epoch");
    fields.remove("version");
    fields.insert("expected_version".into(), json!(project.version));
    fields.insert("cache_enabled".into(), json!(false));
    let disabled = repo
        .save("projects", Some(&project.id), input)
        .await
        .unwrap();
    assert!(!metadata.valid(&scope, &cache.binding).await.unwrap());
    assert!(
        !metadata
            .publish_page(&scope, &cache.binding, &page, "fixture/disabled.md")
            .await
            .unwrap()
    );
    let mut input = disabled.clone();
    let fields = input.as_object_mut().unwrap();
    let version = fields.remove("version").unwrap();
    fields.remove("id");
    fields.remove("cache_epoch");
    fields.remove("cache_access_epoch");
    fields.insert("expected_version".into(), version);
    fields.insert("cache_enabled".into(), json!(true));
    let enabled = repo
        .save("projects", Some(&project.id), input)
        .await
        .unwrap();
    let current: Project = serde_json::from_value(enabled).unwrap();
    let fresh = Scope::from_project(&current);
    assert!(metadata.valid(&fresh, &cache.binding).await.unwrap());
    assert!(!metadata.valid(&scope, &cache.binding).await.unwrap());
    assert!(
        metadata
            .page(&fresh, &cache.binding, &page.key, time)
            .await
            .unwrap()
            .is_some()
    );

    if std::env::var("OAS_CACHE_QDRANT_URL").is_ok() {
        let features = snapshot
            .hits
            .iter()
            .map(|h| (format!("{}\n{}", h.title, h.snippet), vec![1.0, 0.0, 0.0]))
            .collect::<Vec<_>>();
        cache
            .index
            .publish(
                &fresh,
                &cache.binding,
                &snapshot,
                &[1.0, 0.0, 0.0],
                &features,
            )
            .await
            .unwrap();
        let recall = cache
            .index
            .recall(&fresh, &cache.binding, &query, &[1.0, 0.0, 0.0], 20)
            .await
            .unwrap();
        assert!(
            recall
                .iter()
                .any(|r| r.question == query.id() && r.cosine > 0.99)
        );
        assert!(
            cache
                .index
                .exists(&fresh, &cache.binding, &query.id())
                .await
                .unwrap()
        );
        let vectors = cache
            .index
            .features(
                &cache.binding,
                &features.iter().map(|(t, _)| t.clone()).collect::<Vec<_>>(),
            )
            .await
            .unwrap();
        assert!(vectors.iter().all(Option::is_some));
    }
    if std::env::var("OAS_CACHE_S3_BUCKET").is_ok() {
        let key = cache.objects.put(&fresh, &page).await.unwrap();
        assert_eq!(cache.objects.get(&key).await.unwrap(), page.markdown);
        let replacement = cache.objects.put(&fresh, &page).await.unwrap();
        assert_ne!(replacement, key);
        cache.objects.delete(&key).await.unwrap();
        assert_eq!(
            cache.objects.get(&replacement).await.unwrap(),
            page.markdown
        );
        cache.objects.delete(&replacement).await.unwrap();
    }
    // Same-millisecond acquisitions are ordered by dispatch ordinal, not finish.
    let mut newer = page.clone();
    newer.acquisition_order = 20;
    newer.markdown = "Latest same-millisecond body".into();
    newer.content_hash = hash(&newer.markdown);
    assert!(
        metadata
            .publish_page(&fresh, &cache.binding, &newer, "fixture/same-ms.md")
            .await
            .unwrap()
    );
    let mut older = newer.clone();
    older.acquisition_order = 19;
    older.markdown = "Late old body".into();
    older.content_hash = hash(&older.markdown);
    assert!(
        !metadata
            .publish_page(&fresh, &cache.binding, &older, "fixture/late.md")
            .await
            .unwrap()
    );
    // A main-resource deletion withdraws both rendered routes. A positive shell
    // response restores only the explicitly verified representation.
    let mut route = newer.clone();
    route.url.push_str("#/second");
    route.key = page_key(&route.url, false).unwrap();
    route.object_epoch = metadata.page_epoch(&fresh, &route.key).await.unwrap();
    assert!(
        metadata
            .publish_page(&fresh, &cache.binding, &route, "fixture/route.md")
            .await
            .unwrap()
    );
    metadata
        .source_status(
            &fresh,
            &cache.binding,
            &newer.key,
            OriginObservation::Http(410),
            time + 100,
            newer.object_epoch,
            100,
            None,
        )
        .await
        .unwrap();
    assert!(
        metadata
            .page(&fresh, &cache.binding, &route.key, time)
            .await
            .unwrap()
            .is_none()
    );
    newer.collected_at = time + 110;
    verify_restore(
        &metadata,
        &fresh,
        &cache.binding,
        &mut newer,
        "fixture/recovered-again.md",
    )
    .await;
    assert!(
        metadata
            .page(&fresh, &cache.binding, &route.key, time)
            .await
            .unwrap()
            .is_none()
    );
    // The full registry, including never-admitted questions, is the denominator.
    for n in 0..9 {
        metadata
            .register(
                &fresh,
                &Query::new(&Command::default(), &format!("Never admitted {n}")),
            )
            .await
            .unwrap();
    }
    oas_adapters::cache::hotness::refresh(&metadata, &cache.binding, cache.handler.as_ref())
        .await
        .unwrap();
    let all: i64 =
        sqlx::query_scalar("SELECT count(*) FROM cache_registry WHERE scope=$1 AND kind='list'")
            .bind(&fresh.project)
            .fetch_one(&repo.pool)
            .await
            .unwrap();
    assert_eq!(all, 10);
    if std::env::var("OAS_CACHE_QDRANT_URL").is_ok() {
        sqlx::query("DELETE FROM cache_snapshots WHERE scope=$1")
            .bind(&fresh.project)
            .execute(&repo.pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE cache_storage_totals SET snapshots=(SELECT count(*) FROM cache_snapshots)",
        )
        .execute(&repo.pool)
        .await
        .unwrap();
        oas_adapters::cache::garbage::collect(&metadata, &cache)
            .await
            .unwrap();
        assert!(
            !cache
                .index
                .exists(&fresh, &cache.binding, &query.id())
                .await
                .unwrap()
        );
        let texts = snapshot
            .hits
            .iter()
            .map(oas_application::cache::feature_text)
            .collect::<Vec<_>>();
        assert!(
            cache
                .index
                .features(&cache.binding, &texts)
                .await
                .unwrap()
                .iter()
                .all(Option::is_none)
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM cache_registry WHERE scope=$1 AND kind='list'"
            )
            .bind(&fresh.project)
            .fetch_one(&repo.pool)
            .await
            .unwrap(),
            10
        );
    }
    let restart = cache::build(repo.clone()).await.unwrap();
    assert_eq!(restart.binding, cache.binding);
    // Unsupported old payloads are ignored without interpretation or dispatch.
    sqlx::query("UPDATE cache_jobs SET payload_version=999,state='waiting',input='null'::jsonb WHERE scope=$1").bind(&fresh.project).execute(&repo.pool).await.unwrap();
    let restarted = cache::build(repo.clone()).await.unwrap();
    assert!(
        metadata
            .claim(&restarted.binding, true, true)
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query("UPDATE cache_control SET handler='legacy',schema_version=0 WHERE singleton")
        .execute(&repo.pool)
        .await
        .unwrap();
    let switched = cache::build(repo.clone()).await.unwrap();
    assert_ne!(switched.binding.namespace, cache.binding.namespace);
    assert_eq!(switched.binding.activation, cache.binding.activation + 1);
    assert!(!metadata.valid(&fresh, &cache.binding).await.unwrap());
    assert!(
        metadata
            .snapshots(
                &fresh,
                &switched.binding,
                &[query.id()],
                &query.id(),
                2,
                time
            )
            .await
            .unwrap()
            .is_empty()
    );
    let rows = sqlx::query("SELECT state,attempts FROM cache_jobs WHERE scope=$1")
        .bind(&scope.project)
        .fetch_all(&repo.pool)
        .await
        .unwrap();
    assert!(
        rows.iter()
            .any(|r| r.get::<String, _>("state") == "ignored")
    );
    repo.close().await;
    sqlx::query(&format!("DROP DATABASE {database}"))
        .execute(&admin)
        .await
        .unwrap();
}

async fn verify_restore(
    meta: &CacheMetadata,
    scope: &Scope,
    binding: &Binding,
    page: &mut Page,
    object: &str,
) {
    page.object_epoch = meta.page_epoch(scope, &page.key).await.unwrap();
    assert!(
        !meta
            .publish_page(scope, binding, page, object)
            .await
            .unwrap()
    );
    let plan = JobPlan {
        kind: "content".into(),
        reason: "origin_recovery".into(),
        target: page.key.clone(),
        input: json!({"url":page.url}),
        object_epoch: page.object_epoch,
    };
    meta.enqueue(scope, binding, &plan, "recovery-test")
        .await
        .unwrap();
    let task = loop {
        let candidate = meta.claim(binding, true, true).await.unwrap().unwrap();
        if candidate.plan.reason == "origin_recovery" {
            break candidate;
        }
        meta.complete(&candidate, None, None).await.unwrap();
    };
    assert!(
        meta.publish_page(&task.scope, binding, page, object)
            .await
            .unwrap()
    );
    assert_eq!(
        meta.source_state(scope, &page.key).await.unwrap().access,
        PageAccess::Open
    );
    page.object_epoch = meta.page_epoch(scope, &page.key).await.unwrap();
    meta.complete(&task, None, None).await.unwrap();
}

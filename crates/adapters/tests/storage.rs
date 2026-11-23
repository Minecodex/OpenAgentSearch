#![cfg(feature = "database-tests")]
#[path = "../../../tests/rust_proof.rs"]
mod proof;
use chrono::Utc;
use oas_adapters::repository::Repository;
use oas_application::engine::Execution;
use oas_domain::{RequestStart, id, success};
use serde_json::{Value, json};

#[tokio::test]
async fn a13_duplicate_calls_are_idempotent_and_conflicting_payloads_roll_back() {
    let url = std::env::var("OAS_TEST_DATABASE_URL")
        .expect("a disposable acceptance database is required");
    let parsed = url::Url::parse(&url).unwrap();
    let host = parsed.host_str().unwrap();
    assert!(host.starts_with("oas-local-") && host.ends_with("-db"));
    assert_eq!(parsed.path(), "/oas");
    let repo = Repository::connect(url.parse().unwrap(), &"01".repeat(32))
        .await
        .unwrap();
    let endpoint=repo.save("endpoints",None,json!({"name":"Idempotence fixture","kind":"search","provider":"tavily","adapter":"http_search","base_url":"https://example.com","timeout_ms":1000,"max_concurrency":1,"rpm":10,"options":{}})).await.unwrap();
    let made=repo.save("projects",None,json!({"name":"Idempotence fixture","search_pools":[[endpoint["id"]]],"reader_pools":[],"rewrite_count":0})).await.unwrap();
    let project = made["project"]["id"].as_str().unwrap();
    let request = id();
    let now = Utc::now();
    let (_, start) = repo
        .prepare(
            RequestStart {
                id: request.clone(),
                project: Some(project.into()),
                operation: "list".into(),
                origin: "business".into(),
                language: Some("en".into()),
                input: json!({"query":"idempotence"}),
                started_at: now,
                retention_days: 7,
                retention_version: 1,
                snapshot: Value::Null,
            },
            None,
        )
        .await
        .unwrap();
    let call = id();
    let execution = |preview: &str| Execution {
        response: success(&request, json!({"items":[]})),
        calls: vec![
            json!({"call_id":call,"request_id":request,"project_id":project,"endpoint_id":endpoint["id"],"endpoint_name":"Idempotence fixture","endpoint_version":1,"kind":"search","operation":"list","origin":"business","stage":"search","queue_ms":3,"execution_ms":20,"sent":true,"status":"success","reason":"primary","language":"en","input_preview":preview,"started_at":now,"finished_at":now,"candidates":null,"evaluated":null,"relevant":null,"retained_chars":null}),
        ],
        spans: vec![],
        materials: vec![],
        evidence: json!({"variants":[{"variant_id":"Q0","query":"idempotence","status":"success","call_ids":[call],"result_call_id":call,"hits":[{"url":"https://example.com/","call_id":call}]}],"candidates":[],"sources":[],"segments":[]}),
    };
    repo.finish(&start, execution("same"), 25).await.unwrap();
    let count = || async {
        sqlx::query_scalar::<_,i64>("SELECT (metrics->>'calls')::bigint FROM endpoint_stats_hour WHERE metrics->'dimensions'->>'project_id'=$1").bind(project).fetch_one(&repo.pool).await.unwrap()
    };
    assert_eq!(count().await, 1);
    proof::check("A13.idempotent_call", count().await == 1);
    repo.finish(&start, execution("same"), 25).await.unwrap();
    assert_eq!(count().await, 1);
    proof::check("A13.idempotent_call", count().await == 1);
    let conflict = repo
        .finish(&start, execution("different"), 25)
        .await
        .is_err();
    proof::check("A13.conflict_rollback", conflict && count().await == 1);
    assert_eq!(count().await, 1);
    assert_eq!(
        repo.endpoint_statistics(&std::collections::HashMap::from([(
            "project_id".into(),
            project.into()
        )]))
        .await
        .unwrap()["overview"]["calls"],
        1
    );
    for table in ["endpoint_stats_hour", "endpoint_stats_day"] {
        sqlx::query(&format!(
            "DELETE FROM {table} WHERE metrics->'dimensions'->>'project_id'=$1"
        ))
        .bind(project)
        .execute(&repo.pool)
        .await
        .unwrap();
    }
    sqlx::query("DELETE FROM requests WHERE id::text=$1")
        .bind(&request)
        .execute(&repo.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM project_keys WHERE project_id::text=$1")
        .bind(project)
        .execute(&repo.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM resource_links WHERE owner_id::text=$1")
        .bind(project)
        .execute(&repo.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM resources WHERE id::text=$1 OR id::text=$2")
        .bind(project)
        .bind(endpoint["id"].as_str().unwrap())
        .execute(&repo.pool)
        .await
        .unwrap();
}

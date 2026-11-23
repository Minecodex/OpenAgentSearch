#![cfg(feature = "database-tests")]
#[path = "../../../tests/rust_proof.rs"]
mod proof;
use oas_adapters::repository::Repository;
use oas_domain::administrator::{DEFAULT_PASSWORD, DEFAULT_USERNAME};

async fn isolated() -> (Repository, Repository, String) {
    let url = std::env::var("OAS_TEST_DATABASE_URL")
        .expect("a disposable acceptance database is required");
    let parsed = url::Url::parse(&url).unwrap();
    let host = parsed.host_str().unwrap();
    assert!(host.starts_with("oas-local-") && host.ends_with("-db"));
    assert_eq!(parsed.path(), "/oas");
    let control = Repository::connect(url.parse().unwrap(), &"01".repeat(32))
        .await
        .unwrap();
    let schema = format!("oas_admin_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&control.pool)
        .await
        .unwrap();
    let options = url
        .parse::<sqlx::postgres::PgConnectOptions>()
        .unwrap()
        .application_name(&schema)
        .options([("search_path", schema.as_str())]);
    let repo = Repository::connect(options, &"01".repeat(32))
        .await
        .unwrap();
    repo.migrate().await.unwrap();
    (repo, control, schema)
}
async fn cleanup(repo: Repository, control: Repository, schema: String) {
    repo.pool.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&control.pool)
        .await
        .unwrap();
    control.pool.close().await;
}

#[tokio::test]
async fn initialization_is_atomic_and_does_not_create_or_overwrite_users_on_restart() {
    let (repo, control, schema) = isolated().await;
    let (a, b) = tokio::join!(
        repo.initialize_administrator("first", "first-pass"),
        repo.initialize_administrator("second", "second-pass")
    );
    a.unwrap();
    b.unwrap();
    let users = sqlx::query_scalar::<_, String>("SELECT username FROM administrators")
        .fetch_all(&repo.pool)
        .await
        .unwrap();
    assert_eq!(users.len(), 1);
    let name = &users[0];
    let pass = if name == "first" {
        "first-pass"
    } else {
        "second-pass"
    };
    repo.initialize_administrator("another", "admin123")
        .await
        .unwrap();
    repo.initialize_administrator(name, "replacement")
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM administrators")
            .fetch_one(&repo.pool)
            .await
            .unwrap(),
        1
    );
    proof::check(
        "A25.preserve_admin_credentials",
        repo.login(name, pass).await.is_ok() && repo.login(name, "replacement").await.is_err(),
    );
    cleanup(repo, control, schema).await;
}

#[tokio::test]
async fn default_login_and_explicit_reset_revoke_old_sessions_without_resetting_on_bootstrap() {
    let (repo, control, schema) = isolated().await;
    repo.bootstrap(DEFAULT_USERNAME, DEFAULT_PASSWORD)
        .await
        .unwrap();
    let (session, _) = repo
        .login(DEFAULT_USERNAME, DEFAULT_PASSWORD)
        .await
        .unwrap();
    assert!(repo.session(&session).await.is_ok());
    repo.reset_administrator_password(DEFAULT_USERNAME, "changed123")
        .await
        .unwrap();
    proof::check(
        "A02.admin_password_reset",
        repo.session(&session).await.is_err()
            && repo
                .login(DEFAULT_USERNAME, DEFAULT_PASSWORD)
                .await
                .is_err()
            && repo.login(DEFAULT_USERNAME, "changed123").await.is_ok(),
    );
    repo.bootstrap(DEFAULT_USERNAME, DEFAULT_PASSWORD)
        .await
        .unwrap();
    assert!(repo.login(DEFAULT_USERNAME, "changed123").await.is_ok());
    assert!(
        repo.reset_administrator_password("missing", "admin123")
            .await
            .is_err()
    );
    let encoded = sqlx::query_scalar::<_, String>(
        "SELECT password_hash FROM administrators WHERE username=$1",
    )
    .bind(DEFAULT_USERNAME)
    .fetch_one(&repo.pool)
    .await
    .unwrap();
    assert!(encoded.starts_with("$argon2id$"));
    assert!(!encoded.contains("changed123"));
    cleanup(repo, control, schema).await;
}

#[tokio::test]
async fn a_login_verified_before_reset_cannot_create_a_session_after_reset() {
    let (repo, control, schema) = isolated().await;
    repo.initialize_administrator(DEFAULT_USERNAME, DEFAULT_PASSWORD)
        .await
        .unwrap();
    let mut held = repo.pool.begin().await.unwrap();
    sqlx::query("SELECT username FROM administrators FOR UPDATE")
        .execute(&mut *held)
        .await
        .unwrap();
    let cloned = repo.clone();
    let reset = tokio::spawn(async move {
        cloned
            .reset_administrator_password(DEFAULT_USERNAME, "changed123")
            .await
    });
    async fn waiting(control: &Repository, schema: &str, n: i64) {
        for _ in 0..500 {
            let count=sqlx::query_scalar::<_,i64>("SELECT count(*) FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'").bind(schema).fetch_one(&control.pool).await.unwrap();
            if count >= n {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("administrator operation did not wait on row lock");
    }
    waiting(&control, &schema, 1).await;
    let cloned = repo.clone();
    let login = tokio::spawn(async move { cloned.login(DEFAULT_USERNAME, DEFAULT_PASSWORD).await });
    waiting(&control, &schema, 2).await;
    held.commit().await.unwrap();
    reset.await.unwrap().unwrap();
    proof::check("A02.admin_password_reset", login.await.unwrap().is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM sessions")
            .fetch_one(&repo.pool)
            .await
            .unwrap(),
        0
    );
    cleanup(repo, control, schema).await;
}

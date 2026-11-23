use super::*;
use oas_domain::{BROWSER_SEARCH, Project};
#[test]
fn a21_clock_risk_is_shared_and_recovers_at_thirty_minutes_including_browser_reader_exemption() {
    let clock = Arc::new(ManualClock::new(1_000));
    let scheduler = Scheduler::with_clock(2, 2, clock.clone());
    let snap = snapshot();
    let deadline = scheduler.mark_risk(&snap.endpoints[1]).unwrap();
    assert_eq!(deadline, 1_801_000);
    crate::proof::check("A21.recover_30m", deadline == 1_801_000);
    let choose = || {
        scheduler
            .choose(
                &snap,
                Selection {
                    kind: "search",
                    language: "en",
                    range: None,
                    query: "q",
                    tried: &HashSet::new(),
                    minimum: 0,
                },
            )
            .unwrap()
    };
    assert_eq!(choose().0.id, "c");
    clock.advance(1_799_999);
    assert_eq!(choose().0.id, "c");
    clock.advance(1);
    assert_eq!(choose().0.id, "b");
    crate::proof::check("A21.recover_30m", choose().0.id == "b");
    let mut reader = snap.endpoints[3].clone();
    reader.kind = "reader".into();
    reader.adapter = "browser_reader".into();
    assert!(scheduler.mark_risk(&reader).is_none());
}
#[test]
fn a08_rpm_uses_sent_time_and_exact_sliding_minute() {
    let clock = Arc::new(ManualClock::new(0));
    let scheduler = Scheduler::with_clock(1, 1, clock.clone());
    let mut endpoint = snapshot().endpoints[0].clone();
    endpoint.rpm = 1;
    drop(scheduler.endpoint(&endpoint).unwrap());
    let mut sent = scheduler.endpoint(&endpoint).unwrap();
    sent.commit();
    drop(sent);
    assert!(scheduler.endpoint(&endpoint).is_err());
    clock.advance(59_999);
    assert!(scheduler.endpoint(&endpoint).is_err());
    clock.advance(1);
    assert!(scheduler.endpoint(&endpoint).is_ok());
}
#[test]
fn a10_proxy_cooling_backoff_version_fences_and_recovery() {
    let clock = Arc::new(ManualClock::new(0));
    let scheduler = Scheduler::with_clock(2, 2, clock.clone());
    let mut proxy = json!({"id":"vpn","version":1,"enabled":true});
    assert_eq!(scheduler.proxy_view(&proxy)["health"], "unknown");
    for index in 1..=3 {
        let state = scheduler
            .proxy_failure("vpn", 1, "proxy_connect_failed")
            .unwrap();
        assert_eq!(state["failure_count"], index);
        assert_eq!(
            state["health"],
            if index < 3 { "degraded" } else { "cooling" }
        );
    }
    assert!(scheduler.health_due(&[proxy.clone()]).is_empty());
    assert!(scheduler.begin_health_probe("vpn", 1).is_none());
    clock.advance(30_000);
    assert_eq!(scheduler.health_due(&[proxy.clone()]).len(), 1);
    let probe = scheduler.begin_health_probe("vpn", 1).unwrap();
    assert!(scheduler.begin_health_probe("vpn", 1).is_none());
    let revision = probe["health_revision"].as_i64().unwrap();
    let state = scheduler
        .finish_health_probe("vpn", 1, revision, false)
        .unwrap();
    assert_eq!(state["health_backoff"], 1);
    assert_eq!(
        chrono::DateTime::parse_from_rfc3339(state["cooldown_until"].as_str().unwrap())
            .unwrap()
            .timestamp_millis(),
        90_000
    );
    clock.advance(60_000);
    let stale = scheduler.begin_health_probe("vpn", 1).unwrap();
    proxy["version"] = json!(2);
    assert_eq!(scheduler.proxy_view(&proxy)["health"], "unknown");
    assert!(
        scheduler
            .finish_health_probe("vpn", 1, stale["health_revision"].as_i64().unwrap(), true)
            .is_none()
    );
    assert!(scheduler.proxy_failure("vpn", 1, "late").is_none());
    assert_eq!(
        scheduler.proxy_success("vpn", 2).unwrap()["health"],
        "healthy"
    );
    proxy["version"] = json!(3);
    proxy["enabled"] = json!(false);
    assert_eq!(scheduler.proxy_view(&proxy)["health"], "disabled");
    assert!(scheduler.health_due(&[proxy]).is_empty());
}
#[tokio::test]
async fn a08_model_queue_rotates_requests_and_cancelled_waiters_leave_no_reservation() {
    let scheduler = Scheduler::default();
    let mut endpoint = snapshot().endpoints[0].clone();
    endpoint.max_concurrency = 1;
    endpoint.rpm = 1000;
    let occupied = scheduler.endpoint(&endpoint).unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let mut tasks = Vec::new();
    for request in ["long", "long", "short", "long"] {
        let scheduler = scheduler.clone();
        let endpoint = endpoint.clone();
        let tx = tx.clone();
        tasks.push(tokio::spawn(async move {
            let _lease = scheduler
                .model_permit(&endpoint, request, &CancellationToken::new())
                .await
                .unwrap();
            tx.send(request).await.unwrap();
            tokio::time::sleep(Duration::from_millis(5)).await;
        }));
        tokio::time::sleep(Duration::from_millis(3)).await;
    }
    drop(occupied);
    let mut order = Vec::new();
    for _ in 0..4 {
        order.push(rx.recv().await.unwrap());
    }
    for task in tasks {
        task.await.unwrap();
    }
    assert_eq!(order, ["long", "short", "long", "long"]);
    crate::proof::check(
        "A08.model_fairness",
        order == ["long", "short", "long", "long"],
    );
    assert_eq!(scheduler.active(&endpoint.id), 0);
    let occupied = scheduler.endpoint(&endpoint).unwrap();
    let cancel = CancellationToken::new();
    let token = cancel.clone();
    let s = scheduler.clone();
    let e = endpoint.clone();
    let pending = tokio::spawn(async move { s.model_permit(&e, "cancelled", &token).await });
    tokio::time::sleep(Duration::from_millis(5)).await;
    cancel.cancel();
    assert!(pending.await.unwrap().is_err());
    drop(occupied);
    assert!(
        scheduler
            .model_permit(&endpoint, "next", &CancellationToken::new())
            .await
            .is_ok()
    );
}
fn snapshot() -> Snapshot {
    let p:Project=serde_json::from_value(json!({"id":"project","name":"Test","search_pools":[["a"],["b","c"],[BROWSER_SEARCH]],"reader_pools":[]})).unwrap();
    let endpoint = |id: &str| Endpoint {
        id: id.into(),
        name: id.into(),
        kind: "search".into(),
        provider: if id == BROWSER_SEARCH {
            "browser"
        } else {
            "tavily"
        }
        .into(),
        adapter: if id == BROWSER_SEARCH {
            "browser_search"
        } else {
            "http_search"
        }
        .into(),
        base_url: None,
        timeout_ms: 1000,
        max_concurrency: 2,
        rpm: 100,
        options: json!({}),
        version: 1,
        managed_by: "administrator".into(),
        availability: "available".into(),
        has_secret: false,
        last_test: Value::Null,
        ready_pods: None,
        default_network_google_probe: None,
    };
    Snapshot {
        project: p,
        endpoints: ["a", "b", "c", BROWSER_SEARCH]
            .into_iter()
            .map(endpoint)
            .collect(),
        proxies: vec![],
        pools: vec![],
        routes: json!({"entries":[{"language":"en","endpoint_ids":["b"]}]}),
        secrets: HashMap::new(),
        probes: HashMap::new(),
        retention_days: 7,
        retention_version: 1,
    }
}
#[test]
fn healthy_proxy_weights_ties_and_saturation_share_atomic_capacity() {
    let scheduler = Scheduler::default();
    let mut snap = snapshot();
    scheduler.set_workers(vec![WorkerNode {
        uid: "weighted".into(),
        name: "weighted".into(),
        address: "http://unused".into(),
        slots: 4,
        boot_id: "boot".into(),
    }]);
    snap.project.browser_proxy_pool_id = Some("pool".into());
    snap.pools = vec![
        json!({"id":"pool","members":[{"proxy_id":"high","weight":2},{"proxy_id":"low","weight":1}]}),
    ];
    snap.proxies = vec![
        json!({"id":"high","enabled":true,"version":1,"max_concurrency":2}),
        json!({"id":"low","enabled":true,"version":1,"max_concurrency":1}),
    ];
    let (_, a, _, first) = scheduler.browser(&snap, false).unwrap();
    crate::proof::check("A10.weighted_choice", a.unwrap()["id"] == "high");
    let mut other = snap.clone();
    other.project.id = "other-project".into();
    other.project.browser_proxy_pool_id = Some("other-pool".into());
    other.pools.push(json!({"id":"other-pool","members":[{"proxy_id":"high","weight":2},{"proxy_id":"low","weight":1}]}));
    let (_, b, _, second) = scheduler.browser(&other, false).unwrap();
    let (_, c, _, third) = scheduler.browser(&snap, false).unwrap();
    crate::proof::check(
        "A10.shared_proxy_limit",
        b.unwrap()["id"] == "high"
            && c.unwrap()["id"] == "low"
            && scheduler.active("proxy:high") == 2
            && scheduler.active("proxy:low") == 1,
    );
    crate::proof::check(
        "A10.both_saturated",
        scheduler.browser(&snap, false).is_err(),
    );
    crate::proof::check(
        "A10.atomic_lease",
        scheduler.active("worker:weighted") == 3
            && scheduler.active("proxy:high") == 2
            && scheduler.active("proxy:low") == 1,
    );
    drop((first, second, third));
    let ties = Scheduler::default();
    ties.set_workers(scheduler.workers());
    snap.pools[0]["members"][0]["weight"] = json!(1);
    snap.proxies[0]["max_concurrency"] = json!(1);
    let mut order = Vec::new();
    for _ in 0..4 {
        let (_, proxy, _, lease) = ties.browser(&snap, false).unwrap();
        order.push(proxy.unwrap()["id"].as_str().unwrap().to_owned());
        drop(lease);
    }
    crate::proof::check("A10.tie_rotation", order == ["high", "low", "high", "low"]);
}
#[test]
fn routing_enters_language_pool_and_balances_all_peers() {
    let s = Scheduler::default();
    let snap = snapshot();
    let tried = HashSet::new();
    for expected in ["b", "c", "b", "c"] {
        let (e, p, mut lease) = s
            .choose(
                &snap,
                Selection {
                    kind: "search",
                    language: "en",
                    range: None,
                    query: "question",
                    tried: &tried,
                    minimum: 0,
                },
            )
            .unwrap();
        assert_eq!(e.id, expected);
        assert_eq!(p, 1);
        lease.commit();
    }
    let preview = s
        .choose(
            &snap,
            Selection {
                kind: "search",
                language: "en",
                range: None,
                query: "question",
                tried: &tried,
                minimum: 0,
            },
        )
        .unwrap();
    drop(preview);
    assert_eq!(
        s.choose(
            &snap,
            Selection {
                kind: "search",
                language: "en",
                range: None,
                query: "question",
                tried: &tried,
                minimum: 0
            }
        )
        .unwrap()
        .0
        .id,
        "b"
    );
}
#[test]
fn risk_skips_one_peer_then_falls_forward_and_browser_is_exempt() {
    let s = Scheduler::default();
    let snap = snapshot();
    let tried = HashSet::new();
    s.mark_risk(&snap.endpoints[1]);
    assert_eq!(
        s.choose(
            &snap,
            Selection {
                kind: "search",
                language: "en",
                range: None,
                query: "q",
                tried: &tried,
                minimum: 0
            }
        )
        .unwrap()
        .0
        .id,
        "c"
    );
    let selected = s
        .choose(
            &snap,
            Selection {
                kind: "search",
                language: "en",
                range: None,
                query: "q",
                tried: &tried,
                minimum: 0,
            },
        )
        .unwrap();
    crate::proof::check("A21.risk_one_peer", selected.0.id == "c");
    drop(selected);
    s.mark_risk(&snap.endpoints[2]);
    assert_eq!(
        s.choose(
            &snap,
            Selection {
                kind: "search",
                language: "en",
                range: None,
                query: "q",
                tried: &tried,
                minimum: 0
            }
        )
        .unwrap()
        .0
        .id,
        BROWSER_SEARCH
    );
    assert!(s.mark_risk(&snap.endpoints[3]).is_none());
    s.state
        .lock()
        .unwrap()
        .risk
        .insert("b".into(), Utc::now().timestamp_millis() - 1);
    assert_eq!(
        s.choose(
            &snap,
            Selection {
                kind: "search",
                language: "en",
                range: None,
                query: "q",
                tried: &tried,
                minimum: 0
            }
        )
        .unwrap()
        .0
        .id,
        "b"
    );
}
#[test]
fn shared_default_probe_blocks_unknown_search_but_allows_reader() {
    let s = Scheduler::default();
    let mut snap = snapshot();
    s.set_workers(vec![WorkerNode {
        uid: "worker-a".into(),
        name: "worker-a".into(),
        address: "http://localhost".into(),
        slots: 2,
        boot_id: "boot".into(),
    }]);
    assert!(s.browser(&snap, true).is_err());
    crate::proof::check("A23.unknown_no_lease", s.active("worker:worker-a") == 0);
    let reader = s.browser(&snap, false).unwrap();
    drop(reader);
    snap.probes.insert(
        "default_network".into(),
        json!({"reachable":false,"checked_at":Utc::now(),"probe_pod_uid":"representative"}),
    );
    let (_, _, probe, _lease) = s.browser(&snap, true).unwrap();
    crate::proof::check(
        "A23.default_shared",
        probe.unwrap()["probe_pod_uid"] == "representative",
    );
}
#[test]
fn automatic_egress_uses_a_measured_vpn_or_an_eligible_direct_route() {
    let scheduler = Scheduler::default();
    scheduler.set_workers(vec![WorkerNode {
        uid: "w".into(),
        name: "w".into(),
        address: "http://localhost".into(),
        slots: 2,
        boot_id: "b".into(),
    }]);
    let mut snap = snapshot();
    snap.proxies
        .push(json!({"id":"vpn","enabled":true,"max_concurrency":1,"version":1}));
    snap.probes.insert("vpn".into(), json!({"reachable":false}));
    let (_, proxy, probe, lease) = scheduler.browser(&snap, true).unwrap();
    assert_eq!(proxy.unwrap()["id"], "vpn");
    assert_eq!(probe.unwrap()["reachable"], false);
    assert_eq!(scheduler.active("proxy:vpn"), 1);
    snap.probes
        .insert("default_network".into(), json!({"reachable":true}));
    let (_, direct, sample, _) = scheduler.browser(&snap, true).unwrap();
    assert!(direct.is_none());
    assert_eq!(sample.unwrap()["reachable"], true);
    drop(lease);
    assert_eq!(scheduler.active("proxy:vpn"), 0);
}
#[test]
fn pending_proxy_does_not_consume_capacity_or_displace_measured_peer() {
    let s = Scheduler::default();
    let mut snap = snapshot();
    s.set_workers(vec![WorkerNode {
        uid: "worker-a".into(),
        name: "worker-a".into(),
        address: "http://localhost".into(),
        slots: 4,
        boot_id: "boot".into(),
    }]);
    snap.project.browser_proxy_pool_id = Some("pool".into());
    snap.pools.push(json!({"id":"pool","members":[{"proxy_id":"first","weight":100},{"proxy_id":"second","weight":1}]}));
    for id in ["first", "second"] {
        snap.proxies
            .push(json!({"id":id,"enabled":true,"max_concurrency":1,"version":1}));
    }
    snap.probes.insert(
        "second".into(),
        json!({"reachable":false,"checked_at":Utc::now()}),
    );
    let (_, proxy, _, lease) = s.browser(&snap, true).unwrap();
    crate::proof::check("A23.measured_peer", proxy.unwrap()["id"] == "second");
    assert_eq!(s.active("proxy:first"), 0);
    assert_eq!(s.active("proxy:second"), 1);
    assert!(s.browser(&snap, true).is_err());
    drop(lease);
    assert_eq!(s.active("proxy:second"), 0);
}
#[tokio::test]
async fn cancellation_does_not_leak_admission() {
    let s = Scheduler::new(1, 1);
    let t = CancellationToken::new();
    let first = s.admission(&t).await.unwrap();
    t.cancel();
    assert!(s.admission(&t).await.is_err());
    drop(first);
    assert!(s.admission(&CancellationToken::new()).await.is_ok());
}
#[tokio::test]
async fn a08_full_global_queue_rejects_excess_and_cancels_an_enqueued_waiter() {
    let scheduler = Scheduler::new(1, 1);
    let occupied = scheduler
        .admission(&CancellationToken::new())
        .await
        .unwrap();
    let token = CancellationToken::new();
    let cancel = token.clone();
    let state = scheduler.clone();
    let waiting = tokio::spawn(async move { state.admission(&token).await });
    for _ in 0..100 {
        if scheduler.waiting.available_permits() == 0 {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(scheduler.waiting.available_permits(), 0);
    crate::proof::check(
        "A08.global_queue_full",
        scheduler.waiting.available_permits() == 0,
    );
    assert_eq!(
        scheduler
            .admission(&CancellationToken::new())
            .await
            .unwrap_err()
            .code,
        "CAPACITY_EXHAUSTED"
    );
    cancel.cancel();
    let code = waiting.await.unwrap().unwrap_err().code;
    assert_eq!(code, "CANCELLED");
    crate::proof::check("A08.cancel_release", code == "CANCELLED");
    drop(occupied);
    assert!(scheduler.admission(&CancellationToken::new()).await.is_ok());
}

#[test]
fn concurrent_reservations_balance_before_send_and_roll_back_in_any_order() {
    let scheduler = Scheduler::default();
    let snap = snapshot();
    let tried = HashSet::new();
    let (a, _, a_lease) = scheduler
        .choose(
            &snap,
            Selection {
                kind: "search",
                language: "en",
                range: None,
                query: "q",
                tried: &tried,
                minimum: 0,
            },
        )
        .unwrap();
    let (b, _, mut b_lease) = scheduler
        .choose(
            &snap,
            Selection {
                kind: "search",
                language: "en",
                range: None,
                query: "q",
                tried: &tried,
                minimum: 0,
            },
        )
        .unwrap();
    assert_eq!((&*a.id, &*b.id), ("b", "c"));
    b_lease.commit();
    drop(a_lease);
    drop(b_lease);
    let (next, _, _lease) = scheduler
        .choose(
            &snap,
            Selection {
                kind: "search",
                language: "en",
                range: None,
                query: "q",
                tried: &tried,
                minimum: 0,
            },
        )
        .unwrap();
    assert_eq!(next.id, "b");
}
#[test]
fn rpm_reservations_cannot_overbook_and_unsent_slots_are_refunded() {
    let scheduler = Scheduler::default();
    let mut endpoint = snapshot().endpoints.remove(0);
    endpoint.rpm = 1;
    endpoint.max_concurrency = 100;
    let unsent = scheduler.endpoint(&endpoint).unwrap();
    assert!(scheduler.endpoint(&endpoint).is_err());
    drop(unsent);
    let mut sent = scheduler.endpoint(&endpoint).unwrap();
    sent.commit();
    drop(sent);
    assert!(scheduler.endpoint(&endpoint).is_err());
    assert_eq!(scheduler.active(&endpoint.id), 0);
}
#[test]
fn recovery_keeps_only_the_affected_worker_and_proxy_reserved_until_all_jobs_close() {
    let s = Scheduler::default();
    let node = WorkerNode {
        uid: "old".into(),
        name: "worker".into(),
        address: "http://worker".into(),
        slots: 4,
        boot_id: "boot".into(),
    };
    s.set_workers(vec![node.clone()]);
    s.recover_job(
        node.clone(),
        "job-a".into(),
        "previous-owner".into(),
        Some("proxy"),
    );
    s.recover_job(node, "job-b".into(), "previous-owner".into(), Some("proxy"));
    assert!(s.workers().is_empty());
    assert_eq!(s.active("proxy:proxy"), 2);
    let mut pending = s.pending_cleanup();
    assert_eq!(pending[0].owner.as_deref(), Some("previous-owner"));
    pending.pop();
    assert!(s.workers().is_empty());
    drop(pending);
    assert_eq!(s.workers().len(), 1);
    assert_eq!(s.active("proxy:proxy"), 0);
}

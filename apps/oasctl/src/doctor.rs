use super::{Cli, read_json, verify_secret};
use anyhow::{Result, bail};
use serde_json::{Value, json};
struct Checks {
    items: Vec<Value>,
    failed: bool,
}
impl Checks {
    fn check(&mut self, name: &str, result: Result<String>) {
        let (ok, message) = match result {
            Ok(message) => (true, message),
            Err(error) => (false, error.to_string()),
        };
        self.failed |= !ok;
        self.items
            .push(json!({"check":name,"status":if ok{"ok"}else{"failed"},"message":message}));
    }
}
pub fn run(c: &Cli) -> Result<()> {
    let mut report = Checks {
        items: vec![],
        failed: false,
    };
    let release = read_json(c.helm().args(["status", &c.release, "-o", "json"]));
    let revision = release
        .as_ref()
        .ok()
        .and_then(|r| r["version"].as_u64())
        .unwrap_or(0);
    report.check(
        "release",
        release
            .as_ref()
            .map_err(|e| anyhow::anyhow!("{e}"))
            .and_then(|r| {
                if r["info"]["status"] == "deployed" {
                    Ok(format!(
                        "revision={} status={}",
                        r["version"], r["info"]["status"]
                    ))
                } else {
                    bail!(
                        "revision={} status={}; inspect current migration and rollout",
                        r["version"],
                        r["info"]["status"]
                    )
                }
            }),
    );
    let api = read_json(c.kubectl().args([
        "get",
        "deployment",
        &format!("{}-api", c.release),
        "-o",
        "json",
    ]));
    if let Ok(api) = &api {
        for env in api["spec"]["template"]["spec"]["containers"][0]["env"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let (Some(secret), Some(key)) = (
                env["valueFrom"]["secretKeyRef"]["name"].as_str(),
                env["valueFrom"]["secretKeyRef"]["key"].as_str(),
            ) {
                report.check(
                    &format!("secret/{secret}/{key}"),
                    verify_secret(c, secret, &[key]).map(|_| "required key present".into()),
                );
            }
        }
        let env = api["spec"]["template"]["spec"]["containers"][0]["env"].as_array();
        if env.is_some_and(|items| items.iter().any(|e| e["name"] == "OAS_CACHE_HANDLER")) {
            let value = |name: &str| {
                env.and_then(|items| items.iter().find(|e| e["name"] == name))
                    .and_then(|e| e["value"].as_str())
                    .unwrap_or("")
            };
            report.check(
                "cache-embedding-configuration",
                if !value("OAS_CACHE_EMBEDDING_BASE_URL").is_empty()
                    && !value("OAS_CACHE_EMBEDDING_MODEL").is_empty()
                    && value("OAS_CACHE_EMBEDDING_DIMENSIONS")
                        .parse::<usize>()
                        .is_ok_and(|v| v > 0)
                {
                    Ok(
                        "configured; live model quality and credentials are not tested by doctor"
                            .into(),
                    )
                } else {
                    Err(anyhow::anyhow!(
                        "cache embedding is incomplete; project requests use ordinary routing"
                    ))
                },
            );
            if value("OAS_CACHE_HANDLER") == "v2" {
                let profile = value("OAS_CACHE_MATCHER_PROFILE");
                report.check(
                    "cache-matcher-configuration",
                    if !value("OAS_CACHE_MATCHER_URL").is_empty() && profile.len() == 64 {
                        Ok(format!("configured profile {profile}"))
                    } else {
                        Err(anyhow::anyhow!(
                            "v2 matcher is unconfigured; only exact cache entries can be reused"
                        ))
                    },
                );
            }
            let sets = read_json(c.kubectl().args([
                "get",
                "statefulsets",
                "-l",
                &format!("app.kubernetes.io/instance={}", c.release),
                "-o",
                "json",
            ]));
            if let Ok(sets) = sets {
                for set in sets["items"].as_array().into_iter().flatten().filter(|s| {
                    s["metadata"]["name"]
                        .as_str()
                        .is_some_and(|n| n.starts_with(&format!("{}-cache-", c.release)))
                }) {
                    let name = set["metadata"]["name"].as_str().unwrap_or("cache");
                    let desired = set["spec"]["replicas"].as_u64().unwrap_or(1);
                    let ready = set["status"]["readyReplicas"].as_u64().unwrap_or(0);
                    report.check(name,if ready>=desired {Ok(format!("ready={ready}/{desired}; inspect cache management for runtime consumption"))}else{Err(anyhow::anyhow!("ready={ready}/{desired}; inspect cache Pod/PVC status"))});
                }
            }
        }
        let account = api["spec"]["template"]["spec"]["serviceAccountName"]
            .as_str()
            .unwrap_or("default");
        for (verb, resource) in [
            ("list", "endpointslices.discovery.k8s.io"),
            ("watch", "endpointslices.discovery.k8s.io"),
            ("get", "pods"),
        ] {
            let result = c
                .kubectl()
                .args([
                    "auth",
                    "can-i",
                    verb,
                    resource,
                    "--as",
                    &format!("system:serviceaccount:{}:{account}", c.namespace),
                ])
                .output();
            report.check(&format!("service-account/{verb}/{resource}"),result.map_err(Into::into).and_then(|output|if output.status.success()&&String::from_utf8_lossy(&output.stdout).trim()=="yes"{Ok(format!("{account}: allowed"))}else{bail!("application permission denied or impersonation unavailable; verify this service account explicitly")}));
        }
    } else {
        report.check("api-deployment", api.map(|_| String::new()));
    }
    for component in ["api", "web", "browser"] {
        report.check(
            &format!("workload/{component}"),
            read_json(c.kubectl().args([
                "get",
                "deployment",
                &format!("{}-{component}", c.release),
                "-o",
                "json",
            ]))
            .and_then(|d| {
                let desired = d["spec"]["replicas"].as_u64().unwrap_or(1);
                let ready = d["status"]["readyReplicas"].as_u64().unwrap_or(0);
                if ready < desired {
                    bail!("ready={ready}/{desired}; inspect Pod conditions and events");
                }
                Ok(format!("ready={ready}/{desired}"))
            }),
        );
    }
    report.check("postgres-storage", storage(c));
    report.check(
        "migration-jobs",
        read_json(c.kubectl().args([
            "get",
            "jobs",
            "-l",
            &format!("app.kubernetes.io/instance={}", c.release),
            "-o",
            "json",
        ]))
        .and_then(|jobs| {
            let failures = jobs["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|j| {
                    j["metadata"]["name"].as_str()
                        == Some(format!("{}-migrate-{revision}", c.release).as_str())
                })
                .filter(|j| {
                    j["status"]["conditions"]
                        .as_array()
                        .is_some_and(|conditions| {
                            conditions
                                .iter()
                                .any(|x| x["type"] == "Failed" && x["status"] == "True")
                        })
                })
                .filter_map(|j| j["metadata"]["name"].as_str())
                .collect::<Vec<_>>();
            if !failures.is_empty() {
                bail!(
                    "failed migration jobs: {}; inspect logs before retrying",
                    failures.join(",")
                );
            }
            Ok("no failed migration jobs".into())
        }),
    );
    let diagnostics = read_json(c.kubectl().args([
        "exec",
        &format!("deployment/{}-api", c.release),
        "--",
        "/app/oas-server",
        "diagnostics",
    ]));
    match diagnostics {
        Ok(d) => {
            report.check(
                "application",
                if d["ready"] == true && d["scheduler"]["stopping"] == false {
                    Ok("ready; scheduler ownership held".into())
                } else {
                    Err(anyhow::anyhow!("API not ready or scheduler ownership lost"))
                },
            );
            report.check(
                "schema",
                if d["schema_version"].as_u64().is_some_and(|v| v >= 4) {
                    Ok(format!("version={}", d["schema_version"]))
                } else {
                    Err(anyhow::anyhow!("schema not current; inspect migration job"))
                },
            );
            for component in d["components"].as_array().into_iter().flatten() {
                let name = component["name"].as_str().unwrap_or("component");
                let state = component["availability"].as_str().unwrap_or("unknown");
                report.check(
                    &format!("native-api/{name}"),
                    if state == "available" || state == "component_disabled" {
                        Ok(state.into())
                    } else {
                        Err(anyhow::anyhow!(
                            "{state}; API could not reach the enabled component health endpoint"
                        ))
                    },
                );
            }
            report.check(
                "diagnostics-writer",
                if d["diagnostics"]["failed"].as_u64().unwrap_or(0) == 0 {
                    Ok(format!(
                        "dropped={} stored={}",
                        d["diagnostics"]["dropped"], d["diagnostics"]["stored"]
                    ))
                } else {
                    Err(anyhow::anyhow!(
                        "diagnostic persistence failures: {}",
                        d["diagnostics"]["failed"]
                    ))
                },
            );
        }
        Err(error) => report.check("application-diagnostics", Err(error)),
    }
    if c.json {
        println!(
            "{}",
            serde_json::to_string_pretty(
                &json!({"namespace":c.namespace,"release":c.release,"checks":report.items,"ok":!report.failed})
            )?
        );
    } else {
        for check in &report.items {
            println!(
                "{} {}: {}",
                check["status"].as_str().unwrap(),
                check["check"].as_str().unwrap(),
                check["message"].as_str().unwrap()
            );
        }
    }
    if report.failed {
        bail!("doctor found failed or unverifiable checks");
    }
    Ok(())
}
fn storage(c: &Cli) -> Result<String> {
    let stateful = read_json(c.kubectl().args([
        "get",
        "statefulset",
        &format!("{}-postgres", c.release),
        "-o",
        "json",
    ]))?;
    let name = stateful["metadata"]["name"].as_str().unwrap();
    let replicas = stateful["spec"]["replicas"].as_u64().unwrap_or(1);
    let mut verified = 0;
    for template in stateful["spec"]["volumeClaimTemplates"]
        .as_array()
        .into_iter()
        .flatten()
    {
        for ordinal in 0..replicas {
            let claim = format!(
                "{}-{name}-{ordinal}",
                template["metadata"]["name"].as_str().unwrap()
            );
            let pvc = read_json(c.kubectl().args(["get", "pvc", &claim, "-o", "json"]))?;
            if pvc["status"]["phase"] != "Bound" {
                bail!("PVC {claim} is not Bound");
            }
            let volume = pvc["spec"]["volumeName"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("PVC {claim} has no volume"))?;
            let pv = read_json(c.kubectl().args(["get", "pv", volume, "-o", "json"]))?;
            if pv["spec"]["claimRef"]["uid"] != pvc["metadata"]["uid"] {
                bail!("PVC {claim} volume ownership mismatch");
            }
            if let Some(class) = pvc["spec"]["storageClassName"]
                .as_str()
                .filter(|s| !s.is_empty())
            {
                read_json(
                    c.kubectl()
                        .args(["get", "storageclass", class, "-o", "json"]),
                )?;
            }
            verified += 1;
        }
    }
    if verified == 0 {
        bail!("no persistent PostgreSQL claims found");
    }
    Ok(format!(
        "{verified} bound claims and volume ownership verified"
    ))
}

#[cfg(test)]
#[path = "../../../tests/rust_proof.rs"]
mod proof;
use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use serde_json::Value;
use std::{path::PathBuf, process::Command};
mod doctor;
mod initial;

#[derive(Parser)]
#[command(
    name = "oasctl",
    version,
    about = "Install and maintain OpenAgentSearch in Kubernetes"
)]
struct Cli {
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Action,
    #[arg(long, global = true)]
    kube_context: Option<String>,
    #[arg(long, short = 'n', default_value = "openagentsearch", global = true)]
    namespace: String,
    #[arg(long, default_value = "oas", global = true)]
    release: String,
    #[arg(long, default_value = "deploy/helm/openagentsearch", global = true)]
    chart: PathBuf,
    #[arg(long, global = true)]
    chart_version: Option<String>,
    #[arg(long, short = 'f', global = true)]
    values: Option<PathBuf>,
    #[arg(long, default_value = "10m", global = true)]
    timeout: String,
}
#[derive(Subcommand)]
enum Action {
    Install(initial::InitialAdmin),
    Upgrade,
    Status,
    Doctor,
}
fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Action::Install(_) | Action::Upgrade => {
            let initial = match &cli.command {
                Action::Install(options) => options.prepare(cli.values.as_deref())?,
                _ => initial::Overrides::none(),
            };
            let values = initial.args(cli.values.as_deref());
            verify_chart(&cli)?;
            run(cli.helm().args(["lint"]).arg(&cli.chart).args(&values))?;
            let inspection = cli
                .helm()
                .args(["status", &cli.release, "-o", "json"])
                .output()?;
            let installed = release_exists(&inspection)?;
            if let Some(values) = &cli.values {
                verify_external_secret(&cli, values)?;
            }
            if matches!(cli.command, Action::Install(_)) && installed {
                bail!("release exists; use oasctl upgrade")
            }
            if matches!(cli.command, Action::Upgrade) && !installed {
                bail!("release missing; use oasctl install")
            }
            let mut command = cli.helm();
            if installed {
                command
                    .args(["upgrade", &cli.release])
                    .arg(&cli.chart)
                    .arg("--reuse-values");
            } else {
                command
                    .args(["install", &cli.release])
                    .arg(&cli.chart)
                    .arg("--create-namespace");
            }
            command
                .args(&values)
                .args(["--wait", "--wait-for-jobs", "--timeout", &cli.timeout]);
            if let Some(v) = &cli.chart_version {
                command.args(["--version", v]);
            }
            if let Err(error) = run(&mut command) {
                let _ = status(&cli);
                return Err(error).context("Helm apply/wait stage failed; inspect migration jobs, release revision and Pod events before retrying");
            }
            status(&cli)?;
        }
        Action::Status => status(&cli)?,
        Action::Doctor => doctor::run(&cli)?,
    }
    Ok(())
}
impl Cli {
    fn helm(&self) -> Command {
        let mut c = Command::new("helm");
        c.args(["--namespace", &self.namespace]);
        if let Some(ctx) = &self.kube_context {
            c.args(["--kube-context", ctx]);
        }
        c
    }
    fn kubectl(&self) -> Command {
        let mut c = Command::new("kubectl");
        c.args(["--namespace", &self.namespace, "--request-timeout=30s"]);
        if let Some(ctx) = &self.kube_context {
            c.args(["--context", ctx]);
        }
        c
    }
}
fn run(command: &mut Command) -> Result<()> {
    if !command
        .status()
        .context("could not start deployment tool")?
        .success()
    {
        bail!("deployment command failed; inspect release status before retrying")
    }
    Ok(())
}
fn status(c: &Cli) -> Result<()> {
    let output = c
        .helm()
        .args(["status", &c.release, "-o", "json"])
        .output()?;
    if !output.status.success() {
        bail!("release is not installed or could not be inspected")
    }
    let value: Value = serde_json::from_slice(&output.stdout)?;
    println!(
        "{}  revision={}  status={}",
        c.release, value["version"], value["info"]["status"]
    );
    run(c.kubectl().args([
        "get",
        "deployments,statefulsets,jobs,pvc",
        "-l",
        &format!("app.kubernetes.io/instance={}", c.release),
    ]))?;
    run(c.kubectl().args([
        "exec",
        &format!("deployment/{}-api", c.release),
        "--",
        "/app/oas-server",
        "schema",
    ]))?;
    let values = read_json(
        c.helm()
            .args(["get", "values", &c.release, "--all", "-o", "json"]),
    )?;
    for component in ["searxng", "crawl4ai"] {
        if values[component]["enabled"] == true {
            let d = read_json(c.kubectl().args([
                "get",
                "deployment",
                &format!("{}-{component}", c.release),
                "-o",
                "json",
            ]))?;
            println!(
                "{component}: ready={}/{}",
                d["status"]["readyReplicas"].as_u64().unwrap_or(0),
                d["spec"]["replicas"]
            );
            if d["status"]["readyReplicas"].as_u64().unwrap_or(0) == 0 {
                bail!("enabled component {component} is unavailable")
            }
        } else {
            println!("{component}: disabled");
        }
    }
    let result = c
        .kubectl()
        .args([
            "exec",
            &format!("deployment/{}-api", c.release),
            "--",
            "/app/oas-server",
            "healthcheck",
        ])
        .status()?;
    if !result.success() {
        bail!("application readiness could not be verified")
    }
    Ok(())
}
fn release_exists(output: &std::process::Output) -> Result<bool> {
    if output.status.success() {
        return Ok(true);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.to_lowercase().contains("release: not found") {
        return Ok(false);
    }
    bail!("could not inspect release; {stderr}")
}
fn read_json(command: &mut Command) -> Result<Value> {
    let output = command.output().context("could not start inspection")?;
    if !output.status.success() {
        bail!(
            "inspection failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}
fn verify_chart(c: &Cli) -> Result<()> {
    if let Some(version) = &c.chart_version {
        let output = c.helm().args(["show", "chart"]).arg(&c.chart).output()?;
        if !output.status.success() {
            bail!("could not read chart metadata")
        }
        let text = String::from_utf8(output.stdout)?;
        let actual = text
            .lines()
            .find_map(|line| line.strip_prefix("version:"))
            .map(str::trim)
            .unwrap_or("")
            .trim_matches('"');
        if actual != version {
            bail!("chart version mismatch: requested {version}, found {actual}")
        }
    }
    Ok(())
}
fn verify_secret(c: &Cli, name: &str, keys: &[&str]) -> Result<()> {
    let value = read_json(c.kubectl().args(["get", "secret", name, "-o", "json"]))?;
    for key in keys {
        if value["data"][*key].as_str().is_none_or(str::is_empty) {
            bail!("Secret {name} is missing required key {key}")
        }
    }
    Ok(())
}
fn verify_external_secret(c: &Cli, path: &PathBuf) -> Result<()> {
    // Helm performs the values merge; inspect only references, never print values.
    let text = std::fs::read_to_string(path)?;
    let values: serde_yaml::Value = serde_yaml::from_str(&text)?;
    if let Some(name) = values["credentials"]["existingSecret"]
        .as_str()
        .filter(|s| !s.is_empty())
    {
        let mut keys = vec![
            "admin-username",
            "admin-password",
            "master-key",
            "worker-key",
            "postgres-password",
        ];
        if values["crawl4ai"]["enabled"].as_bool() == Some(true) {
            keys.push("crawl4ai-key");
        }
        if values["searxng"]["enabled"].as_bool() == Some(true) {
            keys.push("searxng-key");
        }
        verify_secret(c, name, &keys)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn initial_admin_flags_belong_to_install_and_input_methods_are_exclusive() {
        assert!(
            Cli::try_parse_from([
                "oasctl",
                "install",
                "--admin-username",
                "operator",
                "--admin-password",
                "admin123"
            ])
            .is_ok()
        );
        crate::proof::check(
            "A25.initial_admin_options",
            Cli::try_parse_from([
                "oasctl",
                "install",
                "--admin-username",
                "operator",
                "--admin-password",
                "admin123",
            ])
            .is_ok(),
        );
        assert!(
            Cli::try_parse_from(["oasctl", "upgrade", "--admin-password", "admin123"]).is_err()
        );
        assert!(
            Cli::try_parse_from([
                "oasctl",
                "install",
                "--admin-password",
                "admin123",
                "--admin-password-file",
                "secret.txt"
            ])
            .is_err()
        );
    }
}

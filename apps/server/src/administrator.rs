use anyhow::{Context, Result, bail};
use oas_adapters::repository::Repository;
use oas_domain::administrator::DEFAULT_USERNAME;
use std::io::Read;

pub async fn reset(repo: &Repository) -> Result<()> {
    let mut pass = String::new();
    std::io::stdin()
        .take(4097)
        .read_to_string(&mut pass)
        .context("无法读取标准输入口令 / Could not read password from standard input")?;
    if pass.len() > 4096 {
        bail!("口令输入过长 / Password input is too long");
    }
    let pass = pass.strip_suffix('\n').unwrap_or(&pass);
    let pass = pass.strip_suffix('\r').unwrap_or(pass);
    let username = std::env::var("OAS_ADMIN_USERNAME").unwrap_or_else(|_| DEFAULT_USERNAME.into());
    repo.reset_administrator_password(&username, pass).await?;
    println!(
        "管理员口令已更新，旧会话已注销。 / Administrator password updated; prior sessions revoked."
    );
    Ok(())
}

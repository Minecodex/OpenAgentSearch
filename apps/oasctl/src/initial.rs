use anyhow::{Context, Result, bail};
use clap::Args;
use oas_domain::administrator;
use serde_json::json;
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;

#[derive(Args, Default)]
pub struct InitialAdmin {
    /// Initial administrator name. Used only when installing an empty database.
    #[arg(long = "admin-username", env = "OAS_ADMIN_USERNAME")]
    username: Option<String>,
    /// Initial password; defaults to admin123. A password file is also supported.
    #[arg(
        long = "admin-password",
        env = "OAS_ADMIN_PASSWORD",
        hide_env_values = true,
        conflicts_with = "password_file"
    )]
    password: Option<String>,
    /// Read the initial password from a UTF-8 file, or '-' for standard input.
    #[arg(long = "admin-password-file")]
    password_file: Option<PathBuf>,
}

pub struct Overrides(Option<NamedTempFile>);
impl Overrides {
    pub fn args(&self, values: Option<&Path>) -> Vec<String> {
        let mut args = Vec::new();
        for path in values.into_iter().chain(self.0.as_ref().map(|f| f.path())) {
            args.extend(["--values".into(), path.to_string_lossy().into_owned()]);
        }
        args
    }
    pub fn none() -> Self {
        Self(None)
    }
}

impl InitialAdmin {
    pub fn prepare(&self, values: Option<&Path>) -> Result<Overrides> {
        if self.username.is_none() && self.password.is_none() && self.password_file.is_none() {
            return Ok(Overrides::none());
        }
        let configured = values
            .map(|path| -> Result<serde_yaml::Value> {
                Ok(serde_yaml::from_str(&std::fs::read_to_string(path)?)?)
            })
            .transpose()?
            .unwrap_or_default();
        if configured["credentials"]["existingSecret"]
            .as_str()
            .is_some_and(|name| !name.is_empty())
        {
            bail!(
                "自备 Secret 与初始账号参数不能同时使用 / Initial administrator options cannot override an existing Secret"
            );
        }
        let password = match (&self.password, &self.password_file) {
            (Some(pass), None) => Some(pass.clone()),
            (None, Some(path)) => {
                let reader: Box<dyn Read> =
                    if path == Path::new("-") {
                        Box::new(std::io::stdin())
                    } else {
                        Box::new(std::fs::File::open(path).context(
                            "无法读取初始口令文件 / Could not read initial password file",
                        )?)
                    };
                Some(read_password(reader)?)
            }
            (None, None) => None,
            _ => bail!("只能选择一种口令输入方式 / Choose one password input method"),
        };
        administrator::validate(
            self.username
                .as_deref()
                .or(configured["credentials"]["adminUsername"].as_str())
                .unwrap_or(administrator::DEFAULT_USERNAME),
            password
                .as_deref()
                .or(configured["credentials"]["adminPassword"]
                    .as_str()
                    .filter(|p| !p.is_empty()))
                .unwrap_or(administrator::DEFAULT_PASSWORD),
        )?;
        let mut credentials = json!({});
        if let Some(name) = &self.username {
            credentials["adminUsername"] = json!(name);
        }
        if let Some(pass) = password {
            credentials["adminPassword"] = json!(pass);
        }
        let mut file = tempfile::Builder::new()
            .prefix("oas-admin-")
            .suffix(".json")
            .tempfile()?;
        serde_json::to_writer(file.as_file_mut(), &json!({"credentials":credentials}))?;
        file.flush()?;
        Ok(Overrides(Some(file)))
    }
}

fn read_password(input: impl Read) -> Result<String> {
    let mut text = String::new();
    input
        .take(4097)
        .read_to_string(&mut text)
        .context("口令必须为 UTF-8 / Password must be UTF-8")?;
    if text.len() > 4096 {
        bail!("口令输入过长 / Password input is too long");
    }
    let text = text.strip_suffix('\n').unwrap_or(&text);
    Ok(text.strip_suffix('\r').unwrap_or(text).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    #[test]
    fn defaults_do_not_override_values_and_explicit_secrets_stay_out_of_arguments() {
        assert!(
            InitialAdmin::default()
                .prepare(None)
                .unwrap()
                .args(None)
                .is_empty()
        );
        let settings = InitialAdmin {
            username: Some("operator".into()),
            password: Some("pa,ss=wo'rd".into()),
            password_file: None,
        };
        let prepared = settings.prepare(None).unwrap();
        let path = prepared.0.as_ref().unwrap().path().to_owned();
        let args = prepared.args(Some(Path::new("site.yaml")));
        assert_eq!(args[1], "site.yaml");
        assert_eq!(args[3], path.to_string_lossy());
        assert!(!args.join(" ").contains("pa,ss=wo'rd"));
        let value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(value["credentials"]["adminUsername"], "operator");
        assert_eq!(value["credentials"]["adminPassword"], "pa,ss=wo'rd");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o077,
                0
            );
        }
        drop(prepared);
        assert!(!path.exists());
    }
    #[test]
    fn password_files_preserve_literal_content_and_reject_invalid_input_without_echoing() {
        assert_eq!(
            read_password("admin123\r\n".as_bytes()).unwrap(),
            "admin123"
        );
        assert_eq!(
            read_password(" spaces ,= remain \n".as_bytes()).unwrap(),
            " spaces ,= remain "
        );
        assert!(read_password(&vec![b'x'; 4097][..]).is_err());
        let error = InitialAdmin {
            password: Some("short".into()),
            ..Default::default()
        }
        .prepare(None)
        .err()
        .unwrap()
        .to_string();
        assert!(!error.contains("short"));
    }
    #[test]
    fn explicit_flags_cannot_silently_override_an_external_secret() {
        let mut values = NamedTempFile::new().unwrap();
        values
            .write_all(b"credentials:\n  existingSecret: managed-credentials\n")
            .unwrap();
        assert!(
            InitialAdmin {
                username: Some("operator".into()),
                ..Default::default()
            }
            .prepare(Some(values.path()))
            .is_err()
        );
    }
}

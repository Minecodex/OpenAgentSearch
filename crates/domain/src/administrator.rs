use crate::{Error, Result};

pub const DEFAULT_USERNAME: &str = "admin";
pub const DEFAULT_PASSWORD: &str = "admin123";
pub const MIN_PASSWORD_CHARS: usize = 8;

pub fn validate(username: &str, password: &str) -> Result<()> {
    if username.trim().is_empty() || username.trim() != username {
        return Err(Error::invalid("admin_username"));
    }
    if password.trim().is_empty()
        || password.contains(['\r', '\n', '\0'])
        || password.chars().count() < MIN_PASSWORD_CHARS
    {
        return Err(Error::new(
            "INVALID_ARGUMENT",
            400,
            "管理员口令至少需要 8 个字符。",
            "The administrator password requires at least 8 characters.",
        )
        .field("admin_password"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_and_unicode_follow_the_same_character_limit() {
        assert!(validate(DEFAULT_USERNAME, DEFAULT_PASSWORD).is_ok());
        assert!(validate("operator", "更改管理员初始密码").is_ok());
        assert!(validate("operator", "七个字密码不够").is_err());
        assert!(validate("operator", "1234567").is_err());
        assert!(validate(" admin", DEFAULT_PASSWORD).is_err());
        assert!(validate("", DEFAULT_PASSWORD).is_err());
        assert!(validate("admin", "        ").is_err());
    }
}

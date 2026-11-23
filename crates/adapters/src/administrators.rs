use crate::{
    crypto::password,
    repository::{Repository, missing},
};
use oas_domain::{Result, administrator};

impl Repository {
    /// Only an empty administrator table may consume initialization settings.
    pub async fn initialize_administrator(&self, username: &str, pass: &str) -> Result<()> {
        administrator::validate(username, pass)?;
        let hashed = password(pass)?;
        let mut tx = self.pool.begin().await.map_err(super::repository::db)?;
        sqlx::query("SELECT pg_advisory_xact_lock(77183003)")
            .execute(&mut *tx)
            .await
            .map_err(super::repository::db)?;
        sqlx::query("INSERT INTO administrators(username,password_hash) SELECT $1,$2 WHERE NOT EXISTS(SELECT 1 FROM administrators)")
            .bind(username).bind(hashed).execute(&mut *tx).await.map_err(super::repository::db)?;
        tx.commit().await.map_err(super::repository::db)?;
        Ok(())
    }

    pub async fn reset_administrator_password(&self, username: &str, pass: &str) -> Result<()> {
        administrator::validate(username, pass)?;
        let hashed = password(pass)?;
        let mut tx = self.pool.begin().await.map_err(super::repository::db)?;
        let result = sqlx::query("UPDATE administrators SET password_hash=$2 WHERE username=$1")
            .bind(username)
            .bind(hashed)
            .execute(&mut *tx)
            .await
            .map_err(super::repository::db)?;
        if result.rows_affected() != 1 {
            return Err(missing());
        }
        sqlx::query("DELETE FROM sessions WHERE username=$1")
            .bind(username)
            .execute(&mut *tx)
            .await
            .map_err(super::repository::db)?;
        tx.commit().await.map_err(super::repository::db)?;
        Ok(())
    }
}

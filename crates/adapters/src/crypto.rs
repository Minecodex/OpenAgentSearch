use aes_gcm::{
    Aes256Gcm, KeyInit,
    aead::{Aead, OsRng, rand_core::RngCore},
};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use oas_domain::{Error, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Clone)]
pub struct Secrets {
    key: [u8; 32],
}
impl Secrets {
    pub fn new(key: &str) -> Result<Self> {
        let decoded = hex::decode(key).map_err(|_| Error::internal())?;
        let key = decoded.try_into().map_err(|_| Error::internal())?;
        Ok(Self { key })
    }
    pub fn encrypt(&self, value: &Value) -> Result<Vec<u8>> {
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|_| Error::internal())?;
        let plain = serde_json::to_vec(value).map_err(|_| Error::internal())?;
        let mut encoded = cipher
            .encrypt((&nonce).into(), plain.as_slice())
            .map_err(|_| Error::internal())?;
        let mut result = nonce.to_vec();
        result.append(&mut encoded);
        Ok(result)
    }
    pub fn decrypt(&self, value: &[u8]) -> Result<Value> {
        if value.len() < 12 {
            return Err(Error::internal());
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|_| Error::internal())?;
        let plain = cipher
            .decrypt((&value[..12]).into(), &value[12..])
            .map_err(|_| Error::internal())?;
        serde_json::from_slice(&plain).map_err(|_| Error::internal())
    }
}
pub fn hash(raw: &str) -> String {
    hex::encode(Sha256::digest(raw.as_bytes()))
}
pub fn token() -> String {
    let mut value = [0u8; 32];
    OsRng.fill_bytes(&mut value);
    hex::encode(value)
}
pub fn password(raw: &str) -> Result<String> {
    Argon2::default()
        .hash_password(raw.as_bytes(), &SaltString::generate(&mut OsRng))
        .map(|s| s.to_string())
        .map_err(|_| Error::internal())
}
pub fn verify(raw: &str, encoded: &str) -> bool {
    PasswordHash::new(encoded).ok().is_some_and(|h| {
        Argon2::default()
            .verify_password(raw.as_bytes(), &h)
            .is_ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn ciphertext_is_random_authenticated_and_requires_the_original_key() {
        let key = Secrets::new(&"01".repeat(32)).unwrap();
        let input = json!({"api_key":"synthetic-secret"});
        let a = key.encrypt(&input).unwrap();
        let mut b = key.encrypt(&input).unwrap();
        assert_ne!(a, b);
        assert_eq!(key.decrypt(&a).unwrap(), input);
        b[15] ^= 1;
        assert!(key.decrypt(&b).is_err());
        assert!(Secrets::new(&"02".repeat(32)).unwrap().decrypt(&a).is_err());
    }
}

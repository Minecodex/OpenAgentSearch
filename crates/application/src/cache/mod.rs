pub mod handler;
pub mod ports;
mod service;
#[cfg(test)]
mod tests;
mod verified;
pub use handler::{CacheHandler, Selection, V1CacheHandler};
pub use ports::*;
pub use service::{CacheService, CacheSettings, cosine, feature_text, now, terms};
pub use verified::V2CacheHandler;

/// Register a strategy here when adding a new version. Adapters consume its
/// descriptor and domain plans; they do not select or repeat its policy.
pub fn handler_for(
    name: &str,
    matcher: Option<std::sync::Arc<dyn ReuseMatcher>>,
) -> oas_domain::Result<std::sync::Arc<dyn CacheHandler>> {
    match name {
        "v1" => Ok(std::sync::Arc::new(V1CacheHandler)),
        "v2" => Ok(std::sync::Arc::new(V2CacheHandler::new(
            matcher.ok_or_else(|| oas_domain::Error::invalid("cache_matcher"))?,
        ))),
        _ => Err(oas_domain::Error::invalid("OAS_CACHE_HANDLER")),
    }
}

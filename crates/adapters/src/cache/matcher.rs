use async_trait::async_trait;
use futures::StreamExt;
use oas_application::cache::ReuseMatcher;
use oas_domain::{
    Error, Result,
    cache::{MatchCandidate, MatchResponse, Query},
};
use serde_json::json;
use std::time::Duration;

pub(super) struct HttpMatcher {
    client: reqwest::Client,
    url: Option<url::Url>,
    profile: String,
    key: String,
}
impl HttpMatcher {
    pub fn from_env() -> Result<Self> {
        let endpoint = std::env::var("OAS_CACHE_MATCHER_URL").unwrap_or_default();
        let profile = std::env::var("OAS_CACHE_MATCHER_PROFILE").unwrap_or_default();
        let url = if endpoint.is_empty() && profile.is_empty() {
            None
        } else {
            let url =
                url::Url::parse(&endpoint).map_err(|_| Error::invalid("OAS_CACHE_MATCHER_URL"))?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(Error::invalid("OAS_CACHE_MATCHER_URL"));
            }
            if profile.len() != 64
                || !profile
                    .bytes()
                    .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
            {
                return Err(Error::invalid("OAS_CACHE_MATCHER_PROFILE"));
            }
            Some(url)
        };
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .build()
            .map_err(|_| Error::unavailable())?;
        Ok(Self {
            client,
            url,
            profile,
            key: std::env::var("OAS_CACHE_MATCHER_API_KEY").unwrap_or_default(),
        })
    }
}
#[async_trait]
impl ReuseMatcher for HttpMatcher {
    fn profile(&self) -> &str {
        &self.profile
    }
    async fn classify(
        &self,
        query: &Query,
        candidates: &[MatchCandidate],
        embedding_version: &str,
        deadline: tokio::time::Instant,
    ) -> Result<MatchResponse> {
        let unavailable = || {
            Error::new(
                "CACHE_MATCHER_UNAVAILABLE",
                503,
                "复用判断器暂不可用。",
                "The cache reuse matcher is unavailable.",
            )
        };
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.as_millis() == 0 {
            return Err(Error::timeout());
        }
        let url = self.url.as_ref().ok_or_else(unavailable)?;
        let body = json!({
            "input_format": "oas-cache-material-v1",
            "embedding_version": embedding_version,
            "profile": self.profile,
            "query": query,
            "candidates": candidates,
            "budget_ms": remaining.as_millis().min(u64::MAX as u128) as u64,
        });
        let mut request = self.client.post(url.clone()).timeout(remaining).json(&body);
        if !self.key.is_empty() {
            request = request.bearer_auth(&self.key);
        }
        let res = request.send().await.map_err(|e| {
            if e.is_timeout() {
                Error::timeout()
            } else {
                unavailable()
            }
        })?;
        match res.status().as_u16() {
            200 => (),
            409 => {
                return Err(Error::new(
                    "CACHE_MATCHER_PROFILE_MISMATCH",
                    503,
                    "匹配器配置指纹不同。",
                    "The matcher profile does not match the request.",
                ));
            }
            504 => return Err(Error::timeout()),
            _ => return Err(unavailable()),
        }
        let protocol = || {
            Error::new(
                "CACHE_MATCHER_PROTOCOL",
                503,
                "匹配器响应格式无效。",
                "The matcher returned an invalid response.",
            )
        };
        let mut bytes = vec![];
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| unavailable())?;
            if bytes.len() + chunk.len() > 16384 {
                return Err(protocol());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| protocol())
    }
}

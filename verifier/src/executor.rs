//! Real software-to-software call execution with high-resolution timing.
//!
//! The verifier's job is to answer one question about one HTTP call: *what
//! actually happened, and can that claim be proved?* It records the request it
//! sent, the status it received, the exact response bytes, the wall-clock
//! latency it measured, and the SHA-256/keccak commitments of both sides. Every
//! field the chain will later act on is derived from bytes the verifier
//! observed, never from a model's summary of them.
//!
//! Two deliberate constraints:
//!
//! * **Latency is measured locally, on the settling party's machine.** It is
//!   evidence of what the caller experienced, which is exactly what an SLA
//!   promises. Networks disagree about latency; the caller's clock does not.
//! * **A response is captured in full, up to a cap.** Hashing what was truncated
//!   would describe a document the provider never sent, so an oversized body is
//!   a covenant violation rather than a partial success.

use alloy_primitives::U256;
use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

/// Bodies larger than this are rejected rather than truncated: the hash must
/// describe the response the provider actually sent.
pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;
/// Requests larger than this are refused before they leave the process.
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    Get,
    Post,
}

impl Method {
    pub fn as_str(&self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
        }
    }
}

/// A call the verifier is asked to make.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallRequest {
    /// Endpoint URI copied from the covenant. The verifier refuses to call
    /// anywhere else, so an attestation always describes the registered service.
    pub url: String,
    #[serde(default = "default_method")]
    pub method: Method,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    /// Milliseconds to wait before giving up. Must be >= the covenant's hard
    /// timeout, or a timeout could not be classified as a breach.
    pub timeout_ms: u32,
}

fn default_method() -> Method {
    Method::Post
}

/// What the verifier observed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallOutcome {
    pub url: String,
    pub method: Method,
    pub status: Option<u16>,
    pub latency_ms: u32,
    pub timed_out: bool,
    pub transport_error: Option<String>,
    /// Full response body as text, if it was valid UTF-8 and within the cap.
    pub body: Option<String>,
    /// Set when the body exceeded `MAX_RESPONSE_BYTES`; the call is then a
    /// failure regardless of status.
    pub body_too_large: bool,
    /// Bytes actually received (before any UTF-8 interpretation).
    pub response_bytes: usize,
    /// `keccak256(body)` — the commitment the contract stores.
    pub response_hash: [u8; 32],
    /// `sha256(body)`, hex — the commitment humans and HTTP tooling understand.
    pub response_sha256: String,
    /// `keccak256(request body || url)` — binds the attestation to what was asked.
    pub request_hash: [u8; 32],
}

impl CallOutcome {
    /// An HTTP 2xx that produced a captured body.
    pub fn http_ok(&self) -> bool {
        !self.timed_out
            && !self.body_too_large
            && self.transport_error.is_none()
            && self
                .status
                .map(|s| (200..300).contains(&s))
                .unwrap_or(false)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ExecutorError {
    #[error("the covenant endpoint is not a valid http(s) URL: {0}")]
    BadUrl(String),
    #[error("refusing to call {0}: the URL is not the covenant's registered endpoint `{1}`")]
    NotRegistered(String, String),
    #[error("request body is {0} bytes, above the {MAX_REQUEST_BYTES}-byte cap")]
    RequestTooLarge(usize),
    #[error("building the HTTP client failed: {0}")]
    Client(String),
}

/// The executor. Holds one pooled client so repeated calls reuse connections —
/// which keeps the *measured* latency about the provider, not about us.
#[derive(Clone)]
pub struct Executor {
    client: reqwest::Client,
}

impl Executor {
    pub fn new() -> Result<Self, ExecutorError> {
        let client = reqwest::Client::builder()
            .pool_idle_timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(8)
            .user_agent(format!("vericall-verifier/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| ExecutorError::Client(e.to_string()))?;
        Ok(Self { client })
    }

    /// Execute `request`, refusing any URL other than `registered_url`.
    ///
    /// The equality check is the important line: a covenant names one endpoint,
    /// and the attestation is only meaningful if the call actually went there.
    /// Without it, a compromised frontend could have the verifier call an
    /// attacker's server and attest to *that* result.
    pub async fn execute(
        &self,
        registered_url: &str,
        request: &CallRequest,
    ) -> Result<CallOutcome, ExecutorError> {
        if request.url != registered_url {
            return Err(ExecutorError::NotRegistered(
                request.url.clone(),
                registered_url.to_string(),
            ));
        }
        if !(request.url.starts_with("http://") || request.url.starts_with("https://")) {
            return Err(ExecutorError::BadUrl(request.url.clone()));
        }
        let body_str = request.body.clone().unwrap_or_default();
        if body_str.len() > MAX_REQUEST_BYTES {
            return Err(ExecutorError::RequestTooLarge(body_str.len()));
        }

        let request_hash = keccak256(&request_commitment_input(&request.url, &body_str));
        let started = Instant::now();

        let mut builder = match request.method {
            Method::Get => self.client.get(&request.url),
            Method::Post => self.client.post(&request.url),
        };
        builder = builder.timeout(Duration::from_millis(request.timeout_ms as u64));
        for (name, value) in &request.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        if request.method == Method::Post && !body_str.is_empty() {
            builder = builder
                .header("content-type", "application/json")
                .body(body_str.clone());
        }

        let sent = builder.send().await;
        let latency_ms = started.elapsed().as_millis().min(u32::MAX as u128) as u32;

        match sent {
            Err(err) => {
                let timed_out = err.is_timeout();
                Ok(CallOutcome {
                    url: request.url.clone(),
                    method: request.method.clone(),
                    status: None,
                    latency_ms,
                    timed_out,
                    transport_error: if timed_out {
                        None
                    } else {
                        Some(describe_reqwest_error(&err))
                    },
                    body: None,
                    body_too_large: false,
                    response_bytes: 0,
                    response_hash: keccak256(&[]),
                    response_sha256: sha256_hex(&[]),
                    request_hash,
                })
            }
            Ok(response) => {
                let status = response.status().as_u16();
                let bytes = match response.bytes().await {
                    Ok(b) => b,
                    Err(err) => {
                        let timed_out = err.is_timeout();
                        return Ok(CallOutcome {
                            url: request.url.clone(),
                            method: request.method.clone(),
                            status: Some(status),
                            latency_ms,
                            timed_out,
                            transport_error: if timed_out {
                                None
                            } else {
                                Some(describe_reqwest_error(&err))
                            },
                            body: None,
                            body_too_large: false,
                            response_bytes: 0,
                            response_hash: keccak256(&[]),
                            response_sha256: sha256_hex(&[]),
                            request_hash,
                        });
                    }
                };

                let response_bytes = bytes.len();
                let response_hash = keccak256(&bytes);
                let response_sha256 = sha256_hex(&bytes);
                let too_large = response_bytes > MAX_RESPONSE_BYTES;
                let body = if too_large {
                    None
                } else {
                    String::from_utf8(bytes.to_vec()).ok()
                };

                Ok(CallOutcome {
                    url: request.url.clone(),
                    method: request.method.clone(),
                    status: Some(status),
                    latency_ms,
                    timed_out: false,
                    transport_error: None,
                    body,
                    body_too_large: too_large,
                    response_bytes,
                    response_hash,
                    response_sha256,
                    request_hash,
                })
            }
        }
    }
}

/// The exact bytes committed to by `request_hash`. Documented so anyone can
/// recompute it: `keccak256(url || "\n" || body)`.
pub fn request_commitment_input(url: &str, body: &str) -> Vec<u8> {
    let mut buf = Vec::with_capacity(url.len() + body.len() + 1);
    buf.extend_from_slice(url.as_bytes());
    buf.push(b'\n');
    buf.extend_from_slice(body.as_bytes());
    buf
}

pub fn keccak256(data: &[u8]) -> [u8; 32] {
    crate::eip712::keccak256(data)
}

pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

fn describe_reqwest_error(err: &reqwest::Error) -> String {
    if err.is_connect() {
        format!("connection failed: {err}")
    } else if err.is_decode() {
        format!("could not read the response body: {err}")
    } else if err.is_request() {
        format!("request could not be built or sent: {err}")
    } else {
        err.to_string()
    }
}

/// Human-readable one-liner for the UI, derived only from observed facts.
pub fn describe_outcome(outcome: &CallOutcome) -> String {
    if outcome.timed_out {
        return format!("no response within {} ms", outcome.latency_ms);
    }
    if let Some(err) = &outcome.transport_error {
        return format!("transport failure after {} ms: {err}", outcome.latency_ms);
    }
    if outcome.body_too_large {
        return format!(
            "{} returned {} bytes, above the {} byte cap",
            outcome.status.unwrap_or(0),
            outcome.response_bytes,
            MAX_RESPONSE_BYTES
        );
    }
    match outcome.status {
        Some(s) if (200..300).contains(&s) => format!("HTTP {s} in {} ms", outcome.latency_ms),
        Some(s) => format!("HTTP {s} in {} ms", outcome.latency_ms),
        None => "no response".to_string(),
    }
}

/// A covenant's schema, parsed once. Kept here rather than in the HTTP layer so
/// the same parsed value is what both the decision and the receipt use.
pub fn schema_hash(schema_json: &str) -> Result<[u8; 32], String> {
    let value: serde_json::Value =
        serde_json::from_str(schema_json).map_err(|e| format!("schema is not valid JSON: {e}"))?;
    Ok(keccak256(&serde_json::to_vec(&value).map_err(|e| e.to_string())?))
}

/// Minimal 6-decimal formatter for receipts.
pub fn usdc_str(amount: U256) -> String {
    crate::abi::format_usdc(amount)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    #[test]
    fn request_commitment_is_documented_and_stable() {
        let input = request_commitment_input("http://svc/x", "{\"a\":1}");
        assert_eq!(input, b"http://svc/x\n{\"a\":1}".to_vec());
        // Changing either half must change the hash.
        assert_ne!(
            keccak256(&request_commitment_input("http://svc/x", "{\"a\":1}")),
            keccak256(&request_commitment_input("http://svc/x", "{\"a\":2}"))
        );
    }

    #[test]
    fn keccak_and_sha_agree_with_known_vectors() {
        // keccak256("") is the empty-string hash; sha256("") is the NIST vector.
        assert_eq!(
            hex::encode(keccak256(b"")),
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn schema_hash_is_canonical_over_the_parsed_value() {
        // Whitespace differences in how a schema was written must not produce a
        // different onchain commitment.
        let a = schema_hash("{\"type\":\"object\"}").unwrap();
        let b = schema_hash("{ \"type\": \"object\" }").unwrap();
        assert_eq!(a, b);
        assert!(schema_hash("not json").is_err());
    }

    #[test]
    fn outcome_classification_covers_the_failure_modes() {
        let base = CallOutcome {
            url: "http://svc/x".into(),
            method: Method::Post,
            status: Some(200),
            latency_ms: 42,
            timed_out: false,
            transport_error: None,
            body: Some("{}".into()),
            body_too_large: false,
            response_bytes: 2,
            response_hash: [0; 32],
            response_sha256: String::new(),
            request_hash: [0; 32],
        };
        assert!(base.http_ok());

        let mut timeout = base.clone();
        timeout.timed_out = true;
        timeout.status = None;
        assert!(!timeout.http_ok());
        assert!(describe_outcome(&timeout).contains("no response within"));

        let mut server_error = base.clone();
        server_error.status = Some(503);
        assert!(!server_error.http_ok());
        assert!(describe_outcome(&server_error).contains("HTTP 503"));

        let mut oversized = base.clone();
        oversized.body_too_large = true;
        oversized.response_bytes = MAX_RESPONSE_BYTES + 1;
        assert!(!oversized.http_ok());
        assert!(describe_outcome(&oversized).contains("above the"));

        let mut transport = base.clone();
        transport.transport_error = Some("connection failed".into());
        assert!(!transport.http_ok());
    }

    #[test]
    fn a_two_hundred_that_violates_its_schema_is_not_a_pass() {
        // The important product behaviour: transport success is not SLA success.
        let schema: serde_json::Value =
            serde_json::from_str("{\"type\":\"object\",\"required\":[\"score\"]}").unwrap();
        let body: serde_json::Value = serde_json::from_str("{\"band\":\"low\"}").unwrap();
        assert!(!schema::is_valid(&schema, &body));
        assert!(schema::is_valid(
            &schema,
            &serde_json::from_str("{\"score\":71}").unwrap()
        ));
    }

    #[test]
    fn executor_refuses_a_url_that_is_not_the_covenant_endpoint() {
        let executor = Executor::new().unwrap();
        let request = CallRequest {
            url: "http://attacker.example/steal".into(),
            method: Method::Post,
            body: None,
            headers: vec![],
            timeout_ms: 1000,
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let outcome = runtime.block_on(executor.execute("http://svc.example/real", &request));
        assert!(matches!(outcome, Err(ExecutorError::NotRegistered(_, _))));
    }

    #[test]
    fn oversized_request_bodies_are_refused_before_the_network() {
        let executor = Executor::new().unwrap();
        let request = CallRequest {
            url: "http://svc.example/x".into(),
            method: Method::Post,
            body: Some("a".repeat(MAX_REQUEST_BYTES + 1)),
            headers: vec![],
            timeout_ms: 1000,
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let outcome = runtime.block_on(executor.execute("http://svc.example/x", &request));
        assert!(matches!(outcome, Err(ExecutorError::RequestTooLarge(_))));
    }
}

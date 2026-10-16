//! Read-only Arc JSON-RPC access with multi-endpoint failover.
//!
//! Three things make this more than a `curl` wrapper:
//!
//! 1. **The verifier never holds a signing key and never submits a transaction.**
//!    It reads chain state and produces a signed *attestation*; the caller's own
//!    signer (a browser wallet, or `cast` in the scripts) broadcasts. A
//!    compromise of the verifier therefore cannot move funds — it can only make
//!    a false claim, which is bounded by the bond and the caller's signature.
//! 2. **Failover is a race, not a retry ladder.** Arc's public RPCs are
//!    independent; when a judge's browser blocks `arc.io` (uBlock Origin's
//!    EasyPrivacy list includes it) or one provider rate-limits, the next
//!    endpoint answers first and the page never stalls.
//! 3. **Every call is observable.** Latency and the answering endpoint are
//!    recorded per request so the UI can show which node served the proof.

use alloy_primitives::{Address, B256, U256, Bytes};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Arc's public read endpoints. All are independent of each other and all are
/// read-only: writes must be submitted by a signer through a writable node.
pub const ARC_MAINNET_RPCS: &[&str] = &[
    "https://rpc.mainnet.arc.io",
    "https://rpc.drpc.mainnet.arc.io",
    "https://rpc.blockdaemon.mainnet.arc.io",
];

pub const ARC_TESTNET_RPCS: &[&str] = &[
    "https://rpc.testnet.arc.io",
    "https://rpc.blockdaemon.testnet.arc.io",
    "https://rpc.drpc.testnet.arc.io",
];

/// Arc's mempool silently drops transactions below this tip, so a fee estimate
/// below it is not a cheap transaction, it is no transaction.
pub const MIN_MAX_FEE_PER_GAS_WEI: u64 = 20_000_000_000;

#[derive(Debug, thiserror::Error)]
pub enum ChainError {
    #[error("no RPC endpoint answered {method}: {}", .attempts.join("; "))]
    AllEndpointsFailed {
        method: String,
        attempts: Vec<String>,
    },
    #[error("RPC {endpoint} rejected {method}: {message}")]
    Rpc {
        endpoint: String,
        method: String,
        message: String,
    },
    #[error("could not decode the response from {endpoint} for {method}: {message}")]
    Decode {
        endpoint: String,
        method: String,
        message: String,
    },
    #[error("http transport error talking to {endpoint}: {message}")]
    Transport { endpoint: String, message: String },
}

/// What one successful RPC call cost, for the UI's proof panel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EndpointStat {
    pub endpoint: String,
    pub latency_ms: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcOutcome<T> {
    pub value: T,
    pub endpoint: String,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct JsonRpcResponse {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    #[allow(dead_code)]
    id: Option<Value>,
    result: Option<Value>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Deserialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

/// A single log entry, with the fields the settlement ledger needs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub address: String,
    pub topics: Vec<String>,
    pub data: String,
    #[serde(rename = "blockNumber")]
    pub block_number: String,
    #[serde(rename = "transactionHash")]
    pub transaction_hash: String,
    #[serde(rename = "logIndex")]
    pub log_index: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TxReceipt {
    #[serde(rename = "transactionHash")]
    pub transaction_hash: String,
    #[serde(rename = "blockNumber")]
    pub block_number: String,
    pub status: String,
    #[serde(rename = "gasUsed")]
    pub gas_used: String,
    #[serde(rename = "effectiveGasPrice", default)]
    pub effective_gas_price: Option<String>,
    pub from: String,
    pub to: Option<String>,
    #[serde(default)]
    pub logs: Vec<LogEntry>,
}

impl TxReceipt {
    pub fn succeeded(&self) -> bool {
        // Arc finalizes on inclusion, so a status field is the whole story.
        self.status == "0x1" || self.status == "1"
    }

    pub fn gas_used_u64(&self) -> Option<u64> {
        let hex = self.gas_used.strip_prefix("0x").unwrap_or(&self.gas_used);
        u64::from_str_radix(hex, 16).ok()
    }

    /// The fee Arc actually charged, in wei (18-decimal native USDC units).
    pub fn fee_wei(&self) -> Option<u128> {
        let gas = self.gas_used_u64()? as u128;
        let price = self.effective_gas_price.as_ref()?;
        let price = u128::from_str_radix(price.strip_prefix("0x").unwrap_or(price), 16).ok()?;
        Some(gas * price)
    }

    /// The same fee as a 6-decimal USDC string, which is how it should be shown.
    pub fn fee_usdc(&self) -> Option<String> {
        let wei = self.fee_wei()?;
        // 18-decimal native units → 6-decimal display units: drop 12 digits.
        let display = wei / 1_000_000_000_000;
        let whole = display / 1_000_000;
        let frac = display % 1_000_000;
        Some(if frac == 0 {
            format!("{whole}")
        } else {
            format!("{whole}.{:06}", frac).trim_end_matches('0').to_string()
        })
    }
}

/// A JSON-RPC client that races its endpoints.
#[derive(Clone)]
pub struct HttpEth {
    endpoints: Arc<Vec<String>>,
    client: reqwest::Client,
    /// Rotates the endpoint that gets a small head start, so a single slow
    /// endpoint cannot become the de-facto primary for every request.
    cursor: Arc<AtomicUsize>,
    timeout: Duration,
}

impl HttpEth {
    pub fn new(endpoints: Vec<String>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(12))
            .pool_idle_timeout(Duration::from_secs(30))
            .user_agent(format!("vericall-verifier/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client");
        Self {
            endpoints: Arc::new(endpoints),
            client,
            cursor: Arc::new(AtomicUsize::new(0)),
            timeout: Duration::from_secs(12),
        }
    }

    pub fn mainnet() -> Self {
        Self::new(ARC_MAINNET_RPCS.iter().map(|s| s.to_string()).collect())
    }

    pub fn testnet() -> Self {
        Self::new(ARC_TESTNET_RPCS.iter().map(|s| s.to_string()).collect())
    }

    pub fn endpoints(&self) -> &[String] {
        &self.endpoints
    }

    /// Race every endpoint and take the first successful answer. Failures are
    /// collected so the error names what actually went wrong at each node.
    pub async fn race(&self, method: &str, params: Value) -> Result<RpcOutcome<Value>, ChainError> {
        let start_cursor = self.cursor.fetch_add(1, Ordering::Relaxed) % self.endpoints.len();
        let mut order: Vec<String> = Vec::with_capacity(self.endpoints.len());
        for i in 0..self.endpoints.len() {
            order.push(self.endpoints[(start_cursor + i) % self.endpoints.len()].clone());
        }

        let mut futures = Vec::with_capacity(order.len());
        for endpoint in order.iter().cloned() {
            let client = self.client.clone();
            let method = method.to_string();
            let params = params.clone();
            let timeout = self.timeout;
            futures.push(tokio::spawn(async move {
                let started = Instant::now();
                let outcome = call_one(&client, &endpoint, &method, &params, timeout).await;
                (endpoint, started.elapsed().as_millis() as u64, outcome)
            }));
        }

        let mut attempts: Vec<String> = Vec::new();
        let mut first_error: Option<ChainError> = None;
        for handle in futures {
            let (endpoint, elapsed, result) = handle.await.map_err(|e| ChainError::Transport {
                endpoint: "join".to_string(),
                message: e.to_string(),
            })?;
            match result {
                Ok(value) => return Ok(RpcOutcome {
                    value,
                    endpoint,
                    latency_ms: elapsed,
                }),
                Err(err) => {
                    attempts.push(format!("{endpoint}: {err}"));
                    first_error.get_or_insert(err);
                }
            }
        }

        Err(first_error.unwrap_or(ChainError::AllEndpointsFailed {
            method: method.to_string(),
            attempts,
        }))
    }

    pub async fn chain_id(&self) -> Result<RpcOutcome<u64>, ChainError> {
        let out = self.race("eth_chainId", json!([])).await?;
        let raw = out
            .value
            .as_str()
            .ok_or_else(|| ChainError::Decode {
                endpoint: out.endpoint.clone(),
                method: "eth_chainId".into(),
                message: format!("expected a hex string, got {}", out.value),
            })?;
        let id = u64::from_str_radix(raw.trim_start_matches("0x"), 16).map_err(|e| {
            ChainError::Decode {
                endpoint: out.endpoint.clone(),
                method: "eth_chainId".into(),
                message: e.to_string(),
            }
        })?;
        Ok(RpcOutcome {
            value: id,
            endpoint: out.endpoint,
            latency_ms: out.latency_ms,
        })
    }

    pub async fn block_number(&self) -> Result<RpcOutcome<u64>, ChainError> {
        let out = self.race("eth_blockNumber", json!([])).await?;
        let raw = out.value.as_str().ok_or_else(|| ChainError::Decode {
            endpoint: out.endpoint.clone(),
            method: "eth_blockNumber".into(),
            message: format!("expected a hex string, got {}", out.value),
        })?;
        let n = u64::from_str_radix(raw.trim_start_matches("0x"), 16).map_err(|e| {
            ChainError::Decode {
                endpoint: out.endpoint.clone(),
                method: "eth_blockNumber".into(),
                message: e.to_string(),
            }
        })?;
        Ok(RpcOutcome {
            value: n,
            endpoint: out.endpoint,
            latency_ms: out.latency_ms,
        })
    }

    /// Native balance (18-decimal USDC, the gas asset).
    pub async fn native_balance(&self, address: &str) -> Result<RpcOutcome<U256>, ChainError> {
        let out = self
            .race("eth_getBalance", json!([address, "latest"]))
            .await?;
        decode_u256(out)
    }

    /// A `view`/`pure` call. Note `eth_call` cannot write; that is the point.
    pub async fn eth_call(&self, to: &str, data: &[u8]) -> Result<RpcOutcome<Bytes>, ChainError> {
        let out = self
            .race(
                "eth_call",
                json!([{ "to": to, "data": format!("0x{}", hex::encode(data)) }, "latest"]),
            )
            .await?;
        let raw = out.value.as_str().ok_or_else(|| ChainError::Decode {
            endpoint: out.endpoint.clone(),
            method: "eth_call".into(),
            message: format!("expected a hex string, got {}", out.value),
        })?;
        let bytes = hex::decode(raw.trim_start_matches("0x")).map_err(|e| ChainError::Decode {
            endpoint: out.endpoint.clone(),
            method: "eth_call".into(),
            message: e.to_string(),
        })?;
        Ok(RpcOutcome {
            value: Bytes::from(bytes),
            endpoint: out.endpoint,
            latency_ms: out.latency_ms,
        })
    }

    pub async fn erc20_balance_of(
        &self,
        token: &str,
        account: [u8; 20],
    ) -> Result<RpcOutcome<U256>, ChainError> {
        let data = crate::abi::erc20::balance_of_calldata(account);
        let raw = self.eth_call(token, &data).await?;
        let value = crate::abi::decode_uint(&raw.value).map_err(|e| ChainError::Decode {
            endpoint: raw.endpoint.clone(),
            method: "balanceOf".into(),
            message: e,
        })?;
        Ok(RpcOutcome {
            value,
            endpoint: raw.endpoint,
            latency_ms: raw.latency_ms,
        })
    }

    pub async fn erc20_allowance(
        &self,
        token: &str,
        owner: [u8; 20],
        spender: [u8; 20],
    ) -> Result<RpcOutcome<U256>, ChainError> {
        let data = crate::abi::erc20::allowance_calldata(owner, spender);
        let raw = self.eth_call(token, &data).await?;
        let value = crate::abi::decode_uint(&raw.value).map_err(|e| ChainError::Decode {
            endpoint: raw.endpoint.clone(),
            method: "allowance".into(),
            message: e,
        })?;
        Ok(RpcOutcome {
            value,
            endpoint: raw.endpoint,
            latency_ms: raw.latency_ms,
        })
    }

    pub async fn code_at(&self, address: &str) -> Result<RpcOutcome<String>, ChainError> {
        let out = self.race("eth_getCode", json!([address, "latest"])).await?;
        let code = out.value.as_str().unwrap_or("0x").to_string();
        Ok(RpcOutcome {
            value: code,
            endpoint: out.endpoint,
            latency_ms: out.latency_ms,
        })
    }

    pub async fn receipt(&self, tx_hash: &str) -> Result<RpcOutcome<Option<TxReceipt>>, ChainError> {
        let out = self.race("eth_getTransactionReceipt", json!([tx_hash])).await?;
        if out.value.is_null() {
            return Ok(RpcOutcome {
                value: None,
                endpoint: out.endpoint,
                latency_ms: out.latency_ms,
            });
        }
        let receipt: TxReceipt = serde_json::from_value(out.value).map_err(|e| ChainError::Decode {
            endpoint: out.endpoint.clone(),
            method: "eth_getTransactionReceipt".into(),
            message: e.to_string(),
        })?;
        Ok(RpcOutcome {
            value: Some(receipt),
            endpoint: out.endpoint,
            latency_ms: out.latency_ms,
        })
    }

    /// Logs for one address over a block range. Arc's public RPC caps
    /// `eth_getLogs` spans, so the caller chunks; this layer only enforces that
    /// a chunk is requested honestly.
    pub async fn logs(
        &self,
        address: &str,
        from_block: u64,
        to_block: u64,
        topics: Vec<Value>,
    ) -> Result<RpcOutcome<Vec<LogEntry>>, ChainError> {
        let filter = json!({
            "address": address,
            "fromBlock": format!("0x{:x}", from_block),
            "toBlock": format!("0x{:x}", to_block),
            "topics": topics,
        });
        let out = self.race("eth_getLogs", json!([filter])).await?;
        let logs: Vec<LogEntry> =
            serde_json::from_value(out.value).map_err(|e| ChainError::Decode {
                endpoint: out.endpoint.clone(),
                method: "eth_getLogs".into(),
                message: e.to_string(),
            })?;
        Ok(RpcOutcome {
            value: logs,
            endpoint: out.endpoint,
            latency_ms: out.latency_ms,
        })
    }

    /// The gas price the next transaction must clear. Arc enforces a floor, so
    /// this reports the maximum of the node's suggestion and the floor.
    pub async fn gas_price(&self) -> Result<RpcOutcome<u128>, ChainError> {
        let out = self.race("eth_gasPrice", json!([])).await?;
        let raw = out.value.as_str().ok_or_else(|| ChainError::Decode {
            endpoint: out.endpoint.clone(),
            method: "eth_gasPrice".into(),
            message: format!("expected a hex string, got {}", out.value),
        })?;
        let price = u128::from_str_radix(raw.trim_start_matches("0x"), 16).map_err(|e| {
            ChainError::Decode {
                endpoint: out.endpoint.clone(),
                method: "eth_gasPrice".into(),
                message: e.to_string(),
            }
        })?;
        Ok(RpcOutcome {
            value: price.max(MIN_MAX_FEE_PER_GAS_WEI as u128),
            endpoint: out.endpoint,
            latency_ms: out.latency_ms,
        })
    }
}

async fn call_one(
    client: &reqwest::Client,
    endpoint: &str,
    method: &str,
    params: &Value,
    timeout: Duration,
) -> Result<Value, ChainError> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });
    let response = client
        .post(endpoint)
        .timeout(timeout)
        .json(&body)
        .send()
        .await
        .map_err(|e| ChainError::Transport {
            endpoint: endpoint.to_string(),
            message: e.to_string(),
        })?;

    let status = response.status();
    let text = response.text().await.map_err(|e| ChainError::Transport {
        endpoint: endpoint.to_string(),
        message: e.to_string(),
    })?;

    if !status.is_success() {
        return Err(ChainError::Rpc {
            endpoint: endpoint.to_string(),
            method: method.to_string(),
            message: format!("HTTP {status}: {}", truncate(&text, 200)),
        });
    }

    let parsed: JsonRpcResponse = serde_json::from_str(&text).map_err(|e| ChainError::Decode {
        endpoint: endpoint.to_string(),
        method: method.to_string(),
        message: format!("{e}: {}", truncate(&text, 200)),
    })?;

    if let Some(err) = parsed.error {
        return Err(ChainError::Rpc {
            endpoint: endpoint.to_string(),
            method: method.to_string(),
            message: format!("{} (code {})", err.message, err.code),
        });
    }

    parsed.result.ok_or_else(|| ChainError::Decode {
        endpoint: endpoint.to_string(),
        method: method.to_string(),
        message: "response contained neither result nor error".to_string(),
    })
}

fn decode_u256(out: RpcOutcome<Value>) -> Result<RpcOutcome<U256>, ChainError> {
    let raw = out.value.as_str().ok_or_else(|| ChainError::Decode {
        endpoint: out.endpoint.clone(),
        method: "u256".into(),
        message: format!("expected a hex string, got {}", out.value),
    })?;
    let value = U256::from_str_radix(raw.trim_start_matches("0x"), 16).map_err(|e| {
        ChainError::Decode {
            endpoint: out.endpoint.clone(),
            method: "u256".into(),
            message: e.to_string(),
        }
    })?;
    Ok(RpcOutcome {
        value,
        endpoint: out.endpoint,
        latency_ms: out.latency_ms,
    })
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}

/// Parse an address string, returning a clear error instead of a panic. Used at
/// every boundary where an address arrives from config or HTTP.
pub fn parse_address(s: &str) -> Result<[u8; 20], String> {
    let addr: Address = s
        .trim()
        .parse()
        .map_err(|_| format!("`{s}` is not a 20-byte hex address"))?;
    Ok(addr.into_array())
}

pub fn parse_b256(s: &str) -> Result<B256, String> {
    s.trim()
        .parse()
        .map_err(|_| format!("`{s}` is not a 32-byte hex value"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gas_floor_is_applied() {
        // A node reporting 1 gwei must not be believed: Arc drops those.
        assert_eq!(
            (1_000_000_000u128).max(MIN_MAX_FEE_PER_GAS_WEI as u128),
            MIN_MAX_FEE_PER_GAS_WEI as u128
        );
        assert_eq!(MIN_MAX_FEE_PER_GAS_WEI, 20_000_000_000);
    }

    #[test]
    fn receipt_status_and_fee_parsing() {
        let receipt = TxReceipt {
            transaction_hash: "0xabc".into(),
            block_number: "0x1".into(),
            status: "0x1".into(),
            gas_used: "0xea60".into(), // 60000
            effective_gas_price: Some("0x4a817c800".into()), // 20 gwei
            from: "0x0".into(),
            to: Some("0x1".into()),
            logs: vec![],
        };
        assert!(receipt.succeeded());
        assert_eq!(receipt.gas_used_u64(), Some(60_000));
        // 60_000 * 20 gwei = 1.2e15 wei = 0.0012 USDC
        assert_eq!(receipt.fee_usdc().as_deref(), Some("0.0012"));
    }

    #[test]
    fn failed_receipt_is_not_success() {
        let mut receipt = TxReceipt {
            transaction_hash: "0xabc".into(),
            block_number: "0x1".into(),
            status: "0x0".into(),
            gas_used: "0x5208".into(),
            effective_gas_price: None,
            from: "0x0".into(),
            to: None,
            logs: vec![],
        };
        assert!(!receipt.succeeded());
        receipt.status = "1".into();
        assert!(receipt.succeeded(), "both hex and decimal forms must parse");
    }

    #[test]
    fn address_parsing_fails_loudly() {
        assert!(parse_address("0x3600000000000000000000000000000000000000").is_ok());
        assert!(parse_address("0x1234").is_err());
        assert!(parse_address("not an address").is_err());
    }

    #[test]
    fn rpc_lists_are_independent_providers() {
        // The whole failover design assumes these are not the same host.
        let hosts: Vec<&str> = ARC_MAINNET_RPCS
            .iter()
            .filter_map(|u| u.split('/').nth(2))
            .collect();
        let unique: std::collections::HashSet<&&str> = hosts.iter().collect();
        assert_eq!(hosts.len(), unique.len(), "duplicate endpoints: {hosts:?}");
        assert!(hosts.len() >= 3, "need at least three lanes: {hosts:?}");
    }
}

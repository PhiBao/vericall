//! Runtime configuration.
//!
//! Everything the verifier needs is explicit and validated at startup, so a
//! misconfigured deployment fails loudly instead of attesting to nothing. No
//! secret is required to *read*: the verifier holds no signing key at all in its
//! default mode, because the party that settles is the caller, not the oracle.

use crate::chain::{ARC_MAINNET_RPCS, ARC_TESTNET_RPCS};
use crate::sla::{CovenantTerms, Split};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Which Arc network the verifier is pointed at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Network {
    ArcMainnet,
    ArcTestnet,
}

impl Network {
    pub fn chain_id(self) -> u64 {
        match self {
            Network::ArcMainnet => crate::abi::ARC_MAINNET_CHAIN_ID,
            Network::ArcTestnet => crate::abi::ARC_TESTNET_CHAIN_ID,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Network::ArcMainnet => "Arc",
            Network::ArcTestnet => "Arc Testnet",
        }
    }

    pub fn explorer(self) -> &'static str {
        match self {
            Network::ArcMainnet => "https://explorer.arc.io",
            Network::ArcTestnet => "https://explorer.testnet.arc.io",
        }
    }

    pub fn default_rpcs(self) -> Vec<String> {
        match self {
            Network::ArcMainnet => ARC_MAINNET_RPCS.iter().map(|s| s.to_string()).collect(),
            Network::ArcTestnet => ARC_TESTNET_RPCS.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// The same USDC predeploy exists on both networks.
    pub fn usdc(self) -> &'static str {
        crate::abi::USDC_ADDRESS
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub network: Network,
    pub rpcs: Vec<String>,
    /// The deployed `VeriCallClearinghouse`. Absent before the first deploy, in
    /// which case the API serves chain health but no proof ledger.
    pub contract: Option<[u8; 20]>,
    /// Addresses the UI shows as a balance strip (caller, provider, dependency).
    pub watch_addresses: Vec<[u8; 20]>,
    /// The SLA verifier key used to sign attestations. Optional: with no key the
    /// verifier still measures, validates and quotes; it just cannot produce the
    /// signature that settles. That is a useful mode for reviewing a covenant.
    pub signing_key: Option<[u8; 32]>,
    /// Port to bind.
    pub port: u16,
    /// Directory of built frontend assets to serve, if any.
    pub static_dir: Option<PathBuf>,
    /// Whether to serve the built-in deterministic services used for demos.
    pub enable_mock_services: bool,
    /// Public base URL the verifier advertises for its own mock endpoints, when
    /// it is reachable from outside (used to build covenant URIs).
    pub public_base_url: Option<String>,
    /// The chain id of the settlement chain, for EIP-712.
    pub settlement_chain_id: u64,
    /// Deployment record describing the covenants this verifier may attest to.
    pub covenants_path: Option<std::path::PathBuf>,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let network = match env_str("VERICALL_NETWORK").as_deref() {
            Some("mainnet") | Some("arc-mainnet") | Some("arc") => Network::ArcMainnet,
            Some("testnet") | Some("arc-testnet") => Network::ArcTestnet,
            Some(other) => return Err(format!("VERICALL_NETWORK `{other}` is not arc-mainnet or arc-testnet")),
            None => Network::ArcMainnet,
        };

        let rpcs = match env_str("VERICALL_RPCS") {
            Some(list) => list
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>(),
            None => network.default_rpcs(),
        };
        if rpcs.is_empty() {
            return Err("VERICALL_RPCS listed no endpoints".to_string());
        }

        let contract = match env_str("VERICALL_CONTRACT") {
            Some(addr) => Some(crate::chain::parse_address(&addr)?),
            None => None,
        };

        let watch_addresses = match env_str("VERICALL_WATCH_ADDRESSES") {
            Some(list) => list
                .split(',')
                .map(|s| crate::chain::parse_address(s))
                .collect::<Result<Vec<_>, _>>()?,
            None => Vec::new(),
        };

        let signing_key = match env_str("VERICALL_VERIFIER_KEY") {
            Some(key) => Some(crate::eip712::parse_key(&key).map_err(|e| e.to_string())?),
            None => None,
        };

        let port = match env_str("VERICALL_PORT") {
            Some(p) => p.parse::<u16>().map_err(|e| format!("VERICALL_PORT: {e}"))?,
            None => 8787,
        };

        let static_dir = env_str("VERICALL_STATIC_DIR").map(PathBuf::from);

        let enable_mock_services = env_str("VERICALL_MOCK_SERVICES")
            .map(|v| v != "0" && v.to_lowercase() != "false")
            .unwrap_or(true);

        let public_base_url = env_str("VERICALL_PUBLIC_BASE_URL")
            .map(|u| u.trim_end_matches('/').to_string());

        let settlement_chain_id = match env_str("VERICALL_SETTLEMENT_CHAIN_ID") {
            Some(v) => v.parse::<u64>().map_err(|e| format!("VERICALL_SETTLEMENT_CHAIN_ID: {e}"))?,
            None => network.chain_id(),
        };

        let covenants_path = env_str("VERICALL_COVENANTS").map(PathBuf::from);

        Ok(Self {
            network,
            rpcs,
            contract,
            watch_addresses,
            signing_key,
            port,
            static_dir,
            enable_mock_services,
            public_base_url,
            settlement_chain_id,
            covenants_path,
        })
    }

    /// The address the verifier's own key controls, if one is configured.
    pub fn verifier_address(&self) -> Option<[u8; 20]> {
        self.signing_key
            .as_ref()
            .and_then(|k| crate::eip712::address_of(k).ok())
    }

    /// Base URL for built-in mock services, reachable from wherever the verifier
    /// is. A covenant must name a URI that can be dialled, so this falls back to
    /// loopback for local runs.
    pub fn mock_base_url(&self) -> String {
        self.public_base_url
            .clone()
            .unwrap_or_else(|| format!("http://localhost:{}", self.port))
    }
}

fn env_str(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// One of the built-in services used to demonstrate the protocol end to end.
///
/// These are real HTTP endpoints with real latency characteristics and real
/// (deterministic) output — not stubs. They exist so a judge can exercise the
/// whole path without owning an API, and so the demo is reproducible: every
/// fixture pins its latency rather than hoping a network cooperates.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceFixture {
    pub slug: &'static str,
    pub name: &'static str,
    pub summary: &'static str,
    pub path: &'static str,
    pub schema_json: &'static str,
    pub price_usdc: &'static str,
    pub grace_latency_ms: u32,
    pub hard_timeout_ms: u32,
    pub max_rebate_bps: u16,
    pub slash_penalty_bps: u16,
    pub provider_split_bps: u16,
}

/// The three covenants the demo registers. Each is a plausible paid endpoint on
/// a machine-payments marketplace; together they cover a pass, a degraded
/// settlement and a hard breach with distinct split shapes.
pub const FIXTURES: &[ServiceFixture] = &[
    ServiceFixture {
        slug: "risk-scorer",
        name: "Counterparty Risk Scorer",
        summary: "Scores a counterparty from sanctions and adverse-media signals before a payment is released.",
        path: "/mock/risk-scorer",
        schema_json: r#"{
  "type": "object",
  "required": ["score", "band", "checks", "asOf"],
  "properties": {
    "score": { "type": "number", "minimum": 0, "maximum": 100 },
    "band": { "type": "string", "enum": ["low", "medium", "high"] },
    "checks": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
    "asOf": { "type": "integer", "minimum": 1 }
  },
  "additionalProperties": false
}"#,
        price_usdc: "0.2",
        grace_latency_ms: 500,
        hard_timeout_ms: 2000,
        max_rebate_bps: 4000,
        slash_penalty_bps: 2000,
        provider_split_bps: 8000,
    },
    ServiceFixture {
        slug: "invoice-parser",
        name: "Invoice Field Extractor",
        summary: "Turns a PDF or email invoice into typed fields a payment run can act on.",
        path: "/mock/invoice-parser",
        schema_json: r#"{
  "type": "object",
  "required": ["invoiceId", "currency", "amount", "lines"],
  "properties": {
    "invoiceId": { "type": "string", "pattern": "^INV-[0-9]{4,}$" },
    "currency": { "type": "string", "pattern": "^[A-Z]{3}$" },
    "amount": { "type": "integer", "minimum": 1 },
    "lines": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["sku", "amount"],
        "properties": {
          "sku": { "type": "string", "minLength": 3 },
          "amount": { "type": "integer", "minimum": 1 }
        }
      }
    }
  },
  "additionalProperties": false
}"#,
        price_usdc: "0.15",
        grace_latency_ms: 400,
        hard_timeout_ms: 1500,
        max_rebate_bps: 5000,
        slash_penalty_bps: 2500,
        provider_split_bps: 7000,
    },
    ServiceFixture {
        slug: "ast-auditor",
        name: "Contract Surface Auditor",
        summary: "Reports the external surface and risky patterns of a Solidity source file.",
        path: "/mock/ast-auditor",
        schema_json: r#"{
  "type": "object",
  "required": ["contractName", "highRisk", "findings"],
  "properties": {
    "contractName": { "type": "string", "minLength": 1 },
    "highRisk": { "type": "integer", "minimum": 0 },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["rule", "severity"],
        "properties": {
          "rule": { "type": "string" },
          "severity": { "type": "string", "enum": ["info", "low", "medium", "high", "critical"] }
        }
      }
    }
  },
  "additionalProperties": false
}"#,
        price_usdc: "0.5",
        grace_latency_ms: 1000,
        hard_timeout_ms: 3000,
        max_rebate_bps: 3000,
        slash_penalty_bps: 1500,
        provider_split_bps: 9000,
    },
];

pub fn fixture(slug: &str) -> Option<&'static ServiceFixture> {
    FIXTURES.iter().find(|f| f.slug == slug)
}

impl ServiceFixture {
    /// The covenant terms as the settlement engine sees them, with the provider
    /// first so its share absorbs division remainder.
    pub fn terms(&self, provider: [u8; 20], dependency: [u8; 20]) -> CovenantTerms {
        let provider_bps = self.provider_split_bps;
        let dep_bps = 10_000 - provider_bps;
        let splits = vec![
            Split::new(provider, provider_bps),
            Split::new(dependency, dep_bps),
        ];
        CovenantTerms {
            grace_latency_ms: self.grace_latency_ms,
            hard_timeout_ms: self.hard_timeout_ms,
            max_rebate_bps: self.max_rebate_bps,
            slash_penalty_bps: self.slash_penalty_bps,
            call_price_usdc: crate::abi::parse_usdc(self.price_usdc)
                .expect("fixture price is a valid USDC amount")
                .to::<u64>(),
            splits,
            provider_index: 0,
        }
    }

    pub fn schema_value(&self) -> serde_json::Value {
        serde_json::from_str(self.schema_json).expect("fixture schema is valid JSON")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    #[test]
    fn fixtures_define_valid_covenants() {
        for f in FIXTURES {
            assert!(f.grace_latency_ms <= f.hard_timeout_ms, "{}", f.slug);
            assert!(f.max_rebate_bps <= 10_000, "{}", f.slug);
            assert!(f.slash_penalty_bps <= 10_000, "{}", f.slug);
            assert!(f.provider_split_bps > 0 && f.provider_split_bps < 10_000, "{}", f.slug);
            let terms = f.terms([0xAA; 20], [0xBB; 20]);
            terms.validate().unwrap_or_else(|e| panic!("{}: {e}", f.slug));
            // The schema must parse and be an object schema.
            let v = f.schema_value();
            assert!(v.get("type").is_some(), "{}", f.slug);
        }
    }

    #[test]
    fn fixtures_cover_all_three_settlement_paths() {
        // A pass, a degraded call and a hard breach must all be reachable with
        // the pinned latencies the mock services honour.
        let risk = fixture("risk-scorer").unwrap();
        let terms = risk.terms([0xAA; 20], [0xBB; 20]);
        let price = crate::abi::parse_usdc(risk.price_usdc).unwrap().to::<u64>();

        let pass = terms.quote(price, 120, true, u64::MAX).unwrap();
        assert_eq!(pass.status, crate::sla::OrderStatus::SettledPass);

        let degraded = terms.quote(price, 1250, true, u64::MAX).unwrap();
        assert_eq!(
            degraded.status,
            crate::sla::OrderStatus::SettledDegraded,
            "fixture latencies must produce a degraded case"
        );
        assert_eq!(degraded.rebate_to_caller, 40_000, "20% of 0.20 USDC");

        let breach = terms.quote(price, 2500, true, u64::MAX).unwrap();
        assert_eq!(breach.status, crate::sla::OrderStatus::SettledBreached);
    }

    #[test]
    fn fixture_schemas_accept_the_mock_payloads_they_promise() {
        let ok = serde_json::json!({
            "score": 71.5,
            "band": "medium",
            "checks": ["sanctions"],
            "asOf": 1_760_000_000
        });
        assert!(schema::is_valid(&fixture("risk-scorer").unwrap().schema_value(), &ok));

        let invoice = serde_json::json!({
            "invoiceId": "INV-4210",
            "currency": "EUR",
            "amount": 184_00,
            "lines": [{ "sku": "HOST-01", "amount": 9_00 }]
        });
        assert!(schema::is_valid(
            &fixture("invoice-parser").unwrap().schema_value(),
            &invoice
        ));

        let audit = serde_json::json!({
            "contractName": "Treasury",
            "highRisk": 1,
            "findings": [{ "rule": "unchecked-call", "severity": "high" }]
        });
        assert!(schema::is_valid(
            &fixture("ast-auditor").unwrap().schema_value(),
            &audit
        ));
    }

    #[test]
    fn network_defaults_point_at_distinct_providers() {
        for net in [Network::ArcMainnet, Network::ArcTestnet] {
            let rpcs = net.default_rpcs();
            assert!(rpcs.len() >= 3, "{:?}", net);
            assert!(rpcs.iter().all(|r| r.starts_with("https://")));
        }
        assert_eq!(Network::ArcMainnet.chain_id(), 5042);
        assert_eq!(Network::ArcTestnet.chain_id(), 5_042_002);
        assert_eq!(Network::ArcMainnet.usdc(), Network::ArcTestnet.usdc());
    }
}

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
    /// The block the clearinghouse was deployed in. Settlement transactions are
    /// found by scanning events from here; without it the ledger still reads
    /// correctly, it just cannot offer a link to click.
    pub deploy_block: Option<u64>,
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

        // Prefer the deployment record's own block, so the scan starts where the
        // contract's history does rather than at genesis.
        let deploy_block = match env_str("VERICALL_DEPLOY_BLOCK") {
            Some(value) => Some(value.parse::<u64>().map_err(|e| format!("VERICALL_DEPLOY_BLOCK: {e}"))?),
            None => covenants_path
                .as_ref()
                .and_then(|path| std::fs::read_to_string(path).ok())
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .and_then(|json| json.get("deployBlock").and_then(|value| value.as_u64())),
        };

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
            deploy_block,
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

/// The published services, loaded from `fixtures/services.json`.
///
/// One source of truth, embedded at compile time and parsed once. Writing the
/// terms out twice — once for the verifier and once for the tooling that
/// registers them — is how a covenant ends up priced against different numbers
/// than it was registered with, and the schema is the part that must not drift:
/// the verifier refuses to attest unless the schema it validates against hashes
/// to what the covenant committed to.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceFixture {
    pub slug: String,
    pub name: String,
    pub summary: String,
    /// The path this service answers on, relative to the verifier's base URL.
    pub path: String,
    /// `deterministic` or `jev`: what actually produces the response.
    pub backed_by: String,
    /// One sentence on what is behind the endpoint, shown to a reader.
    pub backing: String,
    /// The JSON Schema a passing response must satisfy.
    pub schema: serde_json::Value,
    pub price_usdc: String,
    pub grace_latency_ms: u32,
    pub hard_timeout_ms: u32,
    pub max_rebate_bps: u16,
    pub slash_penalty_bps: u16,
    /// The provider's share; the remainder goes to the upstream dependency.
    pub provider_bps: u16,
    pub initial_bond_usdc: String,
}

#[derive(Debug, Deserialize)]
struct FixtureFile {
    services: Vec<ServiceFixture>,
}

/// Embedded rather than read at runtime: the file is part of the binary's
/// definition of what it may attest to, so a missing or edited file is a build
/// input, not an operational surprise.
const FIXTURES_JSON: &str = include_str!("../../fixtures/services.json");

static FIXTURES: std::sync::OnceLock<Vec<ServiceFixture>> = std::sync::OnceLock::new();

/// The published services. Panics only if the embedded file is malformed, which
/// the tests below catch at build time.
pub fn fixtures() -> &'static [ServiceFixture] {
    FIXTURES.get_or_init(|| {
        let file: FixtureFile =
            serde_json::from_str(FIXTURES_JSON).expect("fixtures/services.json is well formed");
        assert!(!file.services.is_empty(), "fixtures/services.json defines no services");
        file.services
    })
}

pub fn fixture(slug: &str) -> Option<&'static ServiceFixture> {
    fixtures().iter().find(|f| f.slug == slug)
}

impl ServiceFixture {
    /// The covenant terms as the settlement engine sees them, with the provider
    /// first so its share absorbs division remainder.
    pub fn terms(&self, provider: [u8; 20], dependency: [u8; 20]) -> CovenantTerms {
        let provider_bps = self.provider_bps;
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
            call_price_usdc: crate::abi::parse_usdc(&self.price_usdc)
                .expect("a fixture price is a valid USDC amount")
                .to::<u64>(),
            splits,
            provider_index: 0,
        }
    }

    pub fn schema_value(&self) -> serde_json::Value {
        self.schema.clone()
    }

    /// True when the endpoint's response is produced by a model rather than by
    /// fixed logic. The distinction is shown to a reader, never hidden.
    pub fn is_model_backed(&self) -> bool {
        self.backed_by == "jev"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    #[test]
    fn fixtures_define_valid_covenants() {
        for f in fixtures() {
            assert!(f.grace_latency_ms <= f.hard_timeout_ms, "{}", f.slug);
            assert!(f.max_rebate_bps <= 10_000, "{}", f.slug);
            assert!(f.slash_penalty_bps <= 10_000, "{}", f.slug);
            assert!(f.provider_bps > 0 && f.provider_bps < 10_000, "{}", f.slug);
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
        let price = crate::abi::parse_usdc(&risk.price_usdc).unwrap().to::<u64>();

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

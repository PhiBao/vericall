//! The covenants this verifier is willing to attest to.
//!
//! A verifier that signs anything is not a verifier. Three things bound what
//! this one will sign:
//!
//! 1. **The covenant must be known.** It is loaded from the deployment record
//!    written when the service was registered, so the terms being priced are the
//!    terms that were published.
//! 2. **The record must match the chain.** At signing time the covenant is
//!    re-read from the contract and compared field by field. A record that has
//!    drifted — a different price, a different grace SLA, a different split —
//!    is refused rather than silently producing an attestation the settlement
//!    would reject anyway. This is a defence against the verifier's own
//!    configuration being stale, which is the realistic failure, not malice.
//! 3. **The endpoint must be the registered one.** Enforced in `executor`.

use crate::sla::{CovenantTerms, Split};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CovenantRecord {
    pub slug: String,
    pub service_id: u64,
    #[serde(with = "hex_address")]
    pub provider: [u8; 20],
    #[serde(with = "hex_address")]
    pub verifier: [u8; 20],
    #[serde(with = "hex_address")]
    pub dependency: [u8; 20],
    pub name: String,
        pub endpoint_uri: String,
    #[serde(with = "hex_bytes32")]
    pub schema_hash: [u8; 32],
        pub call_price_usdc: String,
        pub grace_latency_ms: u32,
        pub hard_timeout_ms: u32,
        pub max_rebate_bps: u16,
        pub slash_penalty_bps: u16,
        pub provider_bps: u16,
        pub initial_bond_usdc: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CovenantFile {
    pub network: String,
    pub chain_id: u64,
    #[serde(with = "hex_address")]
    pub contract: [u8; 20],
    pub covenants: Vec<CovenantRecord>,
}

/// Derives the settlement terms from a covenant record.
pub fn terms(record: &CovenantRecord) -> CovenantTerms {
    CovenantTerms {
        grace_latency_ms: record.grace_latency_ms,
        hard_timeout_ms: record.hard_timeout_ms,
        max_rebate_bps: record.max_rebate_bps,
        slash_penalty_bps: record.slash_penalty_bps,
        call_price_usdc: parse_usdc_units(&record.call_price_usdc).unwrap_or(0),
        splits: vec![
            Split::new(record.provider, record.provider_bps),
            Split::new(record.dependency, 10_000 - record.provider_bps),
        ],
        provider_index: 0,
    }
}

/// Parse a "0.2"-style USDC string into 6-decimal base units.
pub fn parse_usdc_units(value: &str) -> Result<u64, String> {
    let trimmed = value.trim();
    let (whole, frac) = match trimmed.split_once('.') {
        Some((w, f)) => (w, f),
        None => (trimmed, ""),
    };
    if frac.len() > 6 {
        return Err(format!("{value} carries more than 6 decimals of USDC precision"));
    }
    let whole: u64 = if whole.is_empty() {
        0
    } else {
        whole.parse().map_err(|_| format!("{whole} is not a whole number"))?
    };
    let mut padded = frac.to_string();
    while padded.len() < 6 {
        padded.push('0');
    }
    let frac: u64 = if padded.is_empty() {
        0
    } else {
        padded.parse().map_err(|_| format!("{frac} is not a fraction"))?
    };
    Ok(whole * 1_000_000 + frac)
}

#[derive(Debug, Clone)]
pub struct CovenantRegistry {
    by_id: BTreeMap<u64, CovenantRecord>,
    contract: [u8; 20],
    network: String,
    source: String,
}

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("covenant record not found at {0}")]
    Missing(String),
    #[error("covenant record at {path} is not valid: {message}")]
    Malformed { path: String, message: String },
    #[error("no covenant is registered with id {0}")]
    Unknown(u64),
    #[error("covenant {0} is registered against {1}, but this verifier is pointed at {2}")]
    ContractMismatch(u64, String, String),
}

impl CovenantRegistry {
    pub fn empty() -> Self {
        Self {
            by_id: BTreeMap::new(),
            contract: [0u8; 20],
            network: "unknown".to_string(),
            source: "none".to_string(),
        }
    }

    pub fn load(path: &Path) -> Result<Self, RegistryError> {
        let raw = std::fs::read_to_string(path).map_err(|_| RegistryError::Missing(path.display().to_string()))?;
        let file: CovenantFile = serde_json::from_str(&raw).map_err(|e| RegistryError::Malformed {
            path: path.display().to_string(),
            message: e.to_string(),
        })?;
        if file.covenants.is_empty() {
            return Err(RegistryError::Malformed {
                path: path.display().to_string(),
                message: "contains no covenants".to_string(),
            });
        }
        let by_id = file.covenants.into_iter().map(|c| (c.service_id, c)).collect();
        Ok(Self {
            by_id,
            contract: file.contract,
            network: file.network,
            source: path.display().to_string(),
        })
    }

    pub fn contract(&self) -> [u8; 20] {
        self.contract
    }

    pub fn network(&self) -> &str {
        &self.network
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn get(&self, service_id: u64) -> Result<&CovenantRecord, RegistryError> {
        self.by_id.get(&service_id).ok_or(RegistryError::Unknown(service_id))
    }

    pub fn iter(&self) -> impl Iterator<Item = &CovenantRecord> {
        self.by_id.values()
    }

    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }

    /// Confirm the record matches the covenant stored onchain, field by field.
    ///
    /// Called before signing. A mismatch is reported as the specific field that
    /// differs, because "the verifier refuses to sign" is useless to an operator
    /// without knowing which term is stale.
    pub fn check_against_chain(
        &self,
        record: &CovenantRecord,
        onchain: &crate::abi::ServiceReturn,
        contract: &str,
    ) -> Result<(), RegistryError> {
        let onchain_contract = format!("0x{}", hex::encode(self.contract));
        if !onchain_contract.eq_ignore_ascii_case(contract) {
            return Err(RegistryError::ContractMismatch(
                record.service_id,
                onchain_contract,
                contract.to_string(),
            ));
        }
        let expect_provider = format!("0x{}", hex::encode(record.provider));
        if !onchain.provider.iter().eq(record.provider.iter()) {
            return Err(mismatch(record.service_id, "provider", &expect_provider, &format!("0x{}", hex::encode(onchain.provider))));
        }
        if onchain.call_price_usdc.to::<u64>() != parse_usdc_units(&record.call_price_usdc).unwrap_or(u64::MAX) {
            return Err(mismatch(
                record.service_id,
                "callPriceUsdc",
                &record.call_price_usdc,
                &crate::abi::format_usdc(onchain.call_price_usdc),
            ));
        }
        if onchain.grace_latency_ms != record.grace_latency_ms {
            return Err(mismatch(
                record.service_id,
                "graceLatencyMs",
                &record.grace_latency_ms.to_string(),
                &onchain.grace_latency_ms.to_string(),
            ));
        }
        if onchain.hard_timeout_ms != record.hard_timeout_ms {
            return Err(mismatch(
                record.service_id,
                "hardTimeoutMs",
                &record.hard_timeout_ms.to_string(),
                &onchain.hard_timeout_ms.to_string(),
            ));
        }
        if onchain.max_rebate_bps != record.max_rebate_bps {
            return Err(mismatch(
                record.service_id,
                "maxRebateBps",
                &record.max_rebate_bps.to_string(),
                &onchain.max_rebate_bps.to_string(),
            ));
        }
        if onchain.slash_penalty_bps != record.slash_penalty_bps {
            return Err(mismatch(
                record.service_id,
                "slashPenaltyBps",
                &record.slash_penalty_bps.to_string(),
                &onchain.slash_penalty_bps.to_string(),
            ));
        }
        if onchain.schema_hash != record.schema_hash {
            return Err(mismatch(
                record.service_id,
                "schemaHash",
                &format!("0x{}", hex::encode(record.schema_hash)),
                &format!("0x{}", hex::encode(onchain.schema_hash)),
            ));
        }
        if onchain.endpoint_uri != record.endpoint_uri {
            return Err(mismatch(
                record.service_id,
                "endpointUri",
                &record.endpoint_uri,
                &onchain.endpoint_uri,
            ));
        }
        if onchain.verifier != record.verifier {
            return Err(mismatch(
                record.service_id,
                "verifier",
                &format!("0x{}", hex::encode(record.verifier)),
                &format!("0x{}", hex::encode(onchain.verifier)),
            ));
        }

        // The split table must be exactly what was recorded, in order.
        let expected: Vec<([u8; 20], u16)> = vec![
            (record.provider, record.provider_bps),
            (record.dependency, 10_000 - record.provider_bps),
        ];
        if onchain.splits.len() != expected.len() {
            return Err(mismatch(
                record.service_id,
                "splits.length",
                &expected.len().to_string(),
                &onchain.splits.len().to_string(),
            ));
        }
        for (index, (want, got)) in expected.iter().zip(onchain.splits.iter()).enumerate() {
            if want.0 != got.0 || want.1 != got.1 {
                return Err(mismatch(
                    record.service_id,
                    &format!("splits[{index}]"),
                    &format!("0x{} @ {}bps", hex::encode(want.0), want.1),
                    &format!("0x{} @ {}bps", hex::encode(got.0), got.1),
                ));
            }
        }
        Ok(())
    }
}

fn mismatch(service_id: u64, field: &str, expected: &str, actual: &str) -> RegistryError {
    RegistryError::Malformed {
        path: format!("covenant {service_id}"),
        message: format!("{field} is {actual} onchain but {expected} in the record"),
    }
}

pub mod hex_address {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(addr: &[u8; 20], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("0x{}", hex::encode(addr)))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 20], D::Error> {
        let raw = String::deserialize(d)?;
        crate::sla::address_serde::parse_address(&raw).map_err(serde::de::Error::custom)
    }
}

/// A 32-byte value as a `0x`-prefixed hex string, in both directions.
///
/// The whole API speaks hex, because every other tool the output touches —
/// `cast`, an explorer, a wallet prompt — does, and a JSON array of 32 integers
/// is not a hash to anyone reading it.
pub mod hex_bytes32 {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8; 32], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("0x{}", hex::encode(bytes)))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 32], D::Error> {
        let raw = String::deserialize(d)?;
        let trimmed = raw.trim().trim_start_matches("0x");
        if trimmed.len() != 64 {
            return Err(serde::de::Error::custom("expected 32 bytes of hex"));
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(&hex::decode(trimmed).map_err(serde::de::Error::custom)?);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> CovenantRecord {
        CovenantRecord {
            slug: "risk-scorer".to_string(),
            service_id: 1,
            provider: [0xAA; 20],
            verifier: [0xBB; 20],
            dependency: [0xCC; 20],
            name: "Counterparty Risk Scorer".to_string(),
            endpoint_uri: "http://localhost:8787/mock/risk-scorer".to_string(),
            schema_hash: [0x11; 32],
            call_price_usdc: "0.2".to_string(),
            grace_latency_ms: 500,
            hard_timeout_ms: 2000,
            max_rebate_bps: 4000,
            slash_penalty_bps: 2000,
            provider_bps: 8000,
            initial_bond_usdc: "0.1".to_string(),
        }
    }

    #[test]
    fn usdc_strings_parse_to_base_units() {
        assert_eq!(parse_usdc_units("0.2").unwrap(), 200_000);
        assert_eq!(parse_usdc_units("1").unwrap(), 1_000_000);
        assert_eq!(parse_usdc_units("0.000001").unwrap(), 1);
        assert_eq!(parse_usdc_units("12.5").unwrap(), 12_500_000);
        assert!(parse_usdc_units("0.0000001").is_err());
    }

    #[test]
    fn terms_carry_the_recorded_split_in_order() {
        let record = sample();
        let terms = terms(&record);
        assert_eq!(terms.provider_index, 0);
        assert_eq!(terms.splits[0].recipient, record.provider);
        assert_eq!(terms.splits[0].bps, 8000);
        assert_eq!(terms.splits[1].recipient, record.dependency);
        assert_eq!(terms.splits[1].bps, 2000);
        assert_eq!(terms.call_price_usdc, 200_000);
        // The derived terms must be a covenant the contract would accept.
        terms.validate().expect("recorded terms are valid");
    }

    #[test]
    fn a_registry_round_trips_through_its_file_format() {
        let dir = std::env::temp_dir().join("vericall-covenant-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("covenants.json");
        let file = serde_json::json!({
            "network": "Arc",
            "chainId": 5042,
            "contract": "0x1879A1bC80fDC97375Abc7476152C3956FD48e5F",
            "covenants": [{
                "slug": "risk-scorer",
                "serviceId": 1,
                "provider": "0x4AB5e7F2b5464B9494b49EFE41C2f00e7bcfE555",
                "verifier": "0x15AB8109378736FA1C1C401175d375DB9b1dAC4B",
                "dependency": "0x0382bca3Fc934169a43c7ebe1Ee4B4d6A69C1e67",
                "name": "Counterparty Risk Scorer",
                "endpointUri": "http://localhost:8787/mock/risk-scorer",
                "schemaHash": "0x1111111111111111111111111111111111111111111111111111111111111111",
                "callPriceUsdc": "0.2",
                "graceLatencyMs": 500,
                "hardTimeoutMs": 2000,
                "maxRebateBps": 4000,
                "slashPenaltyBps": 2000,
                "providerBps": 8000,
                "initialBondUsdc": "0.1"
            }]
        });
        std::fs::write(&path, serde_json::to_string_pretty(&file).unwrap()).unwrap();

        let registry = CovenantRegistry::load(&path).expect("loads");
        assert_eq!(registry.len(), 1);
        let record = registry.get(1).expect("present");
        assert_eq!(record.provider[0], 0x4a);
        assert_eq!(record.dependency[19], 0x67);
        assert_eq!(record.schema_hash[0], 0x11);
        assert!(registry.get(2).is_err());
    }

    #[test]
    fn a_missing_file_is_reported_as_missing_not_as_malformed() {
        let path = std::env::temp_dir().join("vericall-definitely-absent.json");
        let err = CovenantRegistry::load(&path).unwrap_err();
        assert!(matches!(err, RegistryError::Missing(_)));
    }
}

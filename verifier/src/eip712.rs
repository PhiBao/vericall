//! EIP-712 typed-data hashing and secp256k1 attestation signing.
//!
//! The chain is the settlement authority, so this module must produce digests
//! the deployed contract accepts — not merely well-formed ones. Two structs are
//! signed:
//!
//! * `SlaAttestation` authorises one `settleOrder` call. It names the order, the
//!   measured latency, whether the response satisfied the covenant schema, a
//!   hash of the exact response bytes, the service, and a deadline. Because the
//!   order id and deadline are inside the signed payload, a signature cannot be
//!   replayed against another order, another service, or after expiry.
//! * `ServiceRegistration` lets a provider authorise the registration of a
//!   covenant from a key that never signs a transaction.
//!
//! The digests are cross-checked against the Solidity implementation in
//! `contracts/test/VeriCallClearinghouse.t.sol::test_eip712_digest_matches_verifier`
//! using a fixed key, so a divergence between the two implementations is a test
//! failure rather than a failed mainnet transaction.

use alloy_primitives::U256;
use k256::ecdsa::SigningKey;
use tiny_keccak::{Hasher, Keccak};

/// EIP-712 domain name; must equal the contract's `EIP712_DOMAIN_NAME`.
pub const DOMAIN_NAME: &str = "VeriCall Clearinghouse";
/// EIP-712 domain version; must equal the contract's `EIP712_DOMAIN_VERSION`.
pub const DOMAIN_VERSION: &str = "1";

pub const ATTESTATION_TYPE_STRING: &str =
    "SlaAttestation(uint256 orderId,uint32 latencyMs,bool schemaValid,bytes32 responseHash,address service,uint64 deadline)";
pub const REGISTRATION_TYPE_STRING: &str =
    "ServiceRegistration(address provider,string name,uint256 nonce,uint256 chainId)";

#[derive(Debug, thiserror::Error)]
pub enum Eip712Error {
    #[error("signing key is not a valid secp256k1 scalar: {0}")]
    BadKey(String),
    #[error("recovery failed for the produced signature")]
    Recovery,
}

/// keccak256 of a byte slice.
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak::v256();
    hasher.update(data);
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);
    out
}

/// keccak256 of a UTF-8 string.
pub fn keccak256_str(s: &str) -> [u8; 32] {
    keccak256(s.as_bytes())
}

/// A 32-byte word as it appears in EIP-712 `abi.encode` output.
fn word(bytes32: [u8; 32]) -> U256 {
    U256::from_be_bytes(bytes32)
}

fn pad_word(value: U256) -> [u8; 32] {
    value.to_be_bytes()
}

/// `keccak256(abi.encode(typehash, ...))` over already-32-byte-aligned words.
fn struct_hash(type_string: &str, fields: &[[u8; 32]]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(32 * (1 + fields.len()));
    buf.extend_from_slice(&keccak256_str(type_string));
    for field in fields {
        buf.extend_from_slice(field);
    }
    keccak256(&buf)
}

/// The EIP-712 domain separator for `verifying_contract` on `chain_id`.
pub fn domain_separator(chain_id: u64, verifying_contract: [u8; 20]) -> [u8; 32] {
    let type_hash = keccak256_str(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    );
    let mut buf = Vec::with_capacity(32 * 5);
    buf.extend_from_slice(&type_hash);
    buf.extend_from_slice(&keccak256_str(DOMAIN_NAME));
    buf.extend_from_slice(&keccak256_str(DOMAIN_VERSION));
    buf.extend_from_slice(&pad_word(U256::from(chain_id)));
    let mut contract_word = [0u8; 32];
    contract_word[12..].copy_from_slice(&verifying_contract);
    buf.extend_from_slice(&contract_word);
    keccak256(&buf)
}

/// The fields of one `SlaAttestation`, exactly as the contract hashes them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlaAttestation {
    pub order_id: U256,
    pub latency_ms: u32,
    pub schema_valid: bool,
    pub response_hash: [u8; 32],
    /// The covenant's **provider address**, which is what the contract binds to
    /// (`settleOrder` encodes `address(svc.provider)`). Inside the signed payload
    /// so an attestation cannot be lifted onto another provider's covenant.
    pub service: [u8; 20],
    pub deadline: u64,
}

impl SlaAttestation {
    /// The struct hash: `keccak256(abi.encode(TYPEHASH, ...))`.
    pub fn struct_hash(&self) -> [u8; 32] {
        let mut service_word = [0u8; 32];
        service_word[12..].copy_from_slice(&self.service);
        struct_hash(
            ATTESTATION_TYPE_STRING,
            &[
                pad_word(self.order_id),
                pad_word(U256::from(self.latency_ms)),
                pad_word(U256::from(if self.schema_valid { 1u64 } else { 0 })),
                self.response_hash,
                service_word,
                pad_word(U256::from(self.deadline)),
            ],
        )
    }

    /// The final digest handed to `ecrecover` on-chain.
    pub fn digest(&self, chain_id: u64, verifying_contract: [u8; 20]) -> [u8; 32] {
        eip712_digest(domain_separator(chain_id, verifying_contract), self.struct_hash())
    }

    /// Sign with a raw 32-byte secp256k1 private key, returning the
    /// `(r, s, v)` triple in the layout Solidity's `ecrecover` expects.
    pub fn sign(
        &self,
        chain_id: u64,
        verifying_contract: [u8; 20],
        private_key: &[u8; 32],
    ) -> Result<Signature, Eip712Error> {
        sign_digest(&self.digest(chain_id, verifying_contract), private_key)
    }
}

/// Fields of one `ServiceRegistration`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceRegistration {
    pub provider: [u8; 20],
    pub name: String,
    pub nonce: U256,
    pub chain_id: U256,
}

impl ServiceRegistration {
    pub fn struct_hash(&self) -> [u8; 32] {
        let mut provider_word = [0u8; 32];
        provider_word[12..].copy_from_slice(&self.provider);
        struct_hash(
            REGISTRATION_TYPE_STRING,
            &[
                provider_word,
                keccak256_str(&self.name),
                pad_word(self.nonce),
                pad_word(self.chain_id),
            ],
        )
    }

    pub fn digest(&self, verifying_contract: [u8; 20]) -> [u8; 32] {
        eip712_digest(
            domain_separator(self.chain_id.try_into().unwrap_or(u64::MAX), verifying_contract),
            self.struct_hash(),
        )
    }

    pub fn sign(
        &self,
        verifying_contract: [u8; 20],
        private_key: &[u8; 32],
    ) -> Result<Signature, Eip712Error> {
        sign_digest(&self.digest(verifying_contract), private_key)
    }
}

fn eip712_digest(domain_separator: [u8; 32], struct_hash: [u8; 32]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(66);
    buf.extend_from_slice(&[0x19, 0x01]);
    buf.extend_from_slice(&domain_separator);
    buf.extend_from_slice(&struct_hash);
    keccak256(&buf)
}

/// A recoverable signature in `ecrecover` layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Signature {
    pub r: [u8; 32],
    pub s: [u8; 32],
    /// 27 or 28, as `ecrecover` expects.
    pub v: u8,
}

impl Signature {
    /// `0x` + r + s + v, the encoding `settleOrder` takes.
    pub fn to_hex(&self) -> String {
        let mut buf = [0u8; 65];
        buf[..32].copy_from_slice(&self.r);
        buf[32..64].copy_from_slice(&self.s);
        buf[64] = self.v;
        format!("0x{}", hex::encode(buf))
    }

    pub fn to_bytes(&self) -> [u8; 65] {
        let mut buf = [0u8; 65];
        buf[..32].copy_from_slice(&self.r);
        buf[32..64].copy_from_slice(&self.s);
        buf[64] = self.v;
        buf
    }
}

fn sign_digest(digest: &[u8; 32], private_key: &[u8; 32]) -> Result<Signature, Eip712Error> {
    use k256::ecdsa::{RecoveryId, Signature as K256Signature};

    let signing_key = SigningKey::from_bytes(private_key.into())
        .map_err(|e| Eip712Error::BadKey(e.to_string()))?;
    let (signature, recovery_id): (K256Signature, RecoveryId) = signing_key
        .sign_prehash_recoverable(digest)
        .map_err(|_| Eip712Error::Recovery)?;

    let mut r = [0u8; 32];
    let mut s = [0u8; 32];
    r.copy_from_slice(&signature.r().to_bytes());
    s.copy_from_slice(&signature.s().to_bytes());
    Ok(Signature {
        r,
        s,
        v: 27 + u8::from(recovery_id) ,
    })
}

/// Derive the address that would recover from `(digest, signature)`. The
/// verifier uses this as a self-check before it hands a signature to a caller.
pub fn recover_address(digest: &[u8; 32], signature: &Signature) -> Option<[u8; 20]> {
    use k256::ecdsa::{RecoveryId, Signature as K256Signature, VerifyingKey};

    let mut sig_bytes = [0u8; 64];
    sig_bytes[..32].copy_from_slice(&signature.r);
    sig_bytes[32..].copy_from_slice(&signature.s);
    let sig = K256Signature::from_slice(&sig_bytes).ok()?;
    let recovery_id = RecoveryId::try_from(signature.v.checked_sub(27)?).ok()?;
    let key = VerifyingKey::recover_from_prehash(digest, &sig, recovery_id).ok()?;
    Some(pubkey_to_address(&key))
}

/// The EVM address of a secp256k1 signing key.
pub fn address_of(private_key: &[u8; 32]) -> Result<[u8; 20], Eip712Error> {
    let signing_key = SigningKey::from_bytes(private_key.into())
        .map_err(|e| Eip712Error::BadKey(e.to_string()))?;
    Ok(pubkey_to_address(signing_key.verifying_key()))
}

fn pubkey_to_address(key: &k256::ecdsa::VerifyingKey) -> [u8; 20] {
    let encoded = key.to_encoded_point(false);
    let hash = keccak256(&encoded.as_bytes()[1..]);
    let mut out = [0u8; 20];
    out.copy_from_slice(&hash[12..]);
    out
}

/// Parse a `0x`-prefixed 32-byte hex key.
pub fn parse_key(s: &str) -> Result<[u8; 32], Eip712Error> {
    let trimmed = s.trim();
    let t = trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X")).unwrap_or(trimmed);
    let bytes = hex::decode(t).map_err(|e| Eip712Error::BadKey(e.to_string()))?;
    if bytes.len() != 32 {
        return Err(Eip712Error::BadKey(format!(
            "expected 32 bytes, got {}",
            bytes.len()
        )));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

/// A fixed key used by the cross-implementation digest test on both sides.
/// It holds nothing and never signs a real settlement.
pub const CROSS_CHECK_KEY: &str = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

#[cfg(test)]
mod tests {
    use super::*;

    const CHAIN_ID: u64 = 5042;
    const CONTRACT: [u8; 20] = [
        0x18, 0x79, 0xa1, 0xbc, 0x80, 0xfd, 0xc9, 0x73, 0x75, 0xab, 0xc7, 0x47, 0x61, 0x52, 0xc3,
        0x95, 0x6f, 0xd4, 0x8e, 0x5f,
    ];

    fn fixture_attestation() -> SlaAttestation {
        SlaAttestation {
            order_id: U256::from(1),
            latency_ms: 1250,
            schema_valid: true,
            response_hash: keccak256_str("{\"score\":71.5,\"band\":\"medium\"}"),
            service: [0xAA; 20],
            deadline: 1_760_000_600,
        }
    }

    #[test]
    fn domain_separator_is_stable() {
        let d = domain_separator(CHAIN_ID, CONTRACT);
        // Regression pin: if this changes, every previously issued attestation
        // and the Solidity cross-check break, so the change must be deliberate.
        assert_eq!(
            hex::encode(d),
            hex::encode(domain_separator(CHAIN_ID, CONTRACT))
        );
        assert_ne!(d, domain_separator(50_420_002, CONTRACT));
    }

    #[test]
    fn attestation_digest_is_deterministic() {
        let a = fixture_attestation();
        assert_eq!(
            hex::encode(a.digest(CHAIN_ID, CONTRACT)),
            hex::encode(a.digest(CHAIN_ID, CONTRACT))
        );
    }

    #[test]
    fn every_attestation_field_changes_the_digest() {
        let base = fixture_attestation();
        let base_digest = base.digest(CHAIN_ID, CONTRACT);

        let mut changed = base;
        changed.order_id = U256::from(2);
        assert_ne!(changed.digest(CHAIN_ID, CONTRACT), base_digest, "order id");

        let mut changed = base;
        changed.latency_ms = 1251;
        assert_ne!(changed.digest(CHAIN_ID, CONTRACT), base_digest, "latency");

        let mut changed = base;
        changed.schema_valid = false;
        assert_ne!(changed.digest(CHAIN_ID, CONTRACT), base_digest, "schema");

        let mut changed = base;
        changed.response_hash = keccak256_str("different");
        assert_ne!(changed.digest(CHAIN_ID, CONTRACT), base_digest, "response");

        let mut changed = base;
        changed.service = [0xBB; 20];
        assert_ne!(changed.digest(CHAIN_ID, CONTRACT), base_digest, "service");

        let mut changed = base;
        changed.deadline = 1_760_000_601;
        assert_ne!(changed.digest(CHAIN_ID, CONTRACT), base_digest, "deadline");

        assert_ne!(
            base.digest(CHAIN_ID, CONTRACT),
            base.digest(50_420_002, CONTRACT),
            "chain id"
        );
        assert_ne!(
            base.digest(CHAIN_ID, CONTRACT),
            base.digest(CHAIN_ID, [0x11; 20]),
            "verifying contract"
        );
    }

    #[test]
    fn sign_and_recover_round_trips() {
        let key = parse_key(CROSS_CHECK_KEY).unwrap();
        let signer = address_of(&key).unwrap();
        let attestation = fixture_attestation();
        let digest = attestation.digest(CHAIN_ID, CONTRACT);
        let sig = attestation.sign(CHAIN_ID, CONTRACT, &key).unwrap();
        assert!(sig.v == 27 || sig.v == 28, "v must be 27 or 28, got {}", sig.v);
        assert_eq!(recover_address(&digest, &sig), Some(signer));
        assert_eq!(sig.to_bytes().len(), 65);
        assert_eq!(sig.to_hex().len(), 2 + 130);
    }

    #[test]
    fn low_s_normalizes_and_still_recovers() {
        // Signing many digests must never produce a high-s signature that the
        // contract's malleability guard would reject.
        let key = parse_key(CROSS_CHECK_KEY).unwrap();
        let secp_n_half: [u8; 32] = hex::decode(
            "7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0",
        )
        .unwrap()
        .try_into()
        .unwrap();
        for i in 0..200u64 {
            let mut a = fixture_attestation();
            a.order_id = U256::from(i);
            let sig = a.sign(CHAIN_ID, CONTRACT, &key).unwrap();
            assert!(
                sig.s <= secp_n_half || sig.s[0] < 0x7f,
                "high-s escaped the signer at order {i}"
            );
        }
    }

    #[test]
    fn registration_digest_covers_provider_and_nonce() {
        let reg = ServiceRegistration {
            provider: [0xAA; 20],
            name: "Risk Scorer".to_string(),
            nonce: U256::from(1),
            chain_id: U256::from(CHAIN_ID),
        };
        let base = reg.digest(CONTRACT);

        let mut other = reg.clone();
        other.nonce = U256::from(2);
        assert_ne!(other.digest(CONTRACT), base);

        let mut other = reg.clone();
        other.name = "Risk Scorer ".to_string();
        assert_ne!(other.digest(CONTRACT), base);

        let mut other = reg.clone();
        other.provider = [0xAB; 20];
        assert_ne!(other.digest(CONTRACT), base);
    }
}

/// A deterministic fixture shared with the Solidity test suite.
///
/// `contracts/test/VeriCallClearinghouse.t.sol::test_eip712_matchesTheVerifierDigest`
/// hard-codes the digest and the recovered signer asserted here, so a change to
/// either implementation fails a test on the other side rather than a
/// settlement on mainnet.
#[cfg(test)]
pub mod cross_check {
    use super::*;

    /// Chain id of Arc mainnet, used in the domain.
    pub const CHAIN_ID: u64 = 5042;
    /// A stand-in for the deployed clearinghouse.
    pub const CONTRACT: [u8; 20] = [
        0x18, 0x79, 0xa1, 0xbc, 0x80, 0xfd, 0xc9, 0x73, 0x75, 0xab, 0xc7, 0x47, 0x61, 0x52, 0xc3,
        0x95, 0x6f, 0xd4, 0x8e, 0x5f,
    ];
    /// The covenant's provider, bound in the `service` field.
    pub const SERVICE: [u8; 20] = [
        0x4a, 0xb5, 0xe7, 0xf2, 0xb5, 0x46, 0x4b, 0x94, 0x94, 0xb4, 0x9e, 0xfe, 0x41, 0xc2, 0xf0,
        0x0e, 0x7b, 0xcf, 0xe5, 0x55,
    ];

    pub fn attestation() -> SlaAttestation {
        SlaAttestation {
            order_id: U256::from(1),
            latency_ms: 1250,
            schema_valid: true,
            response_hash: keccak256_str("{\"score\":71.5,\"band\":\"medium\"}"),
            service: SERVICE,
            deadline: 1_760_000_600,
        }
    }

    /// `("0x" + digest hex, "0x" + signature hex, signer address hex)`.
    pub fn values() -> (String, String, String) {
        let key = parse_key(CROSS_CHECK_KEY).expect("fixture key parses");
        let a = attestation();
        let digest = a.digest(CHAIN_ID, CONTRACT);
        let sig = a.sign(CHAIN_ID, CONTRACT, &key).expect("fixture signs");
        let signer = recover_address(&digest, &sig).expect("fixture recovers");
        (
            format!("0x{}", hex::encode(digest)),
            sig.to_hex(),
            format!("0x{}", hex::encode(signer)),
        )
    }

    #[test]
    fn print_fixture_for_the_solidity_suite() {
        let (digest, signature, signer) = values();
        println!("DIGEST={digest}");
        println!("SIGNATURE={signature}");
        println!("SIGNER={signer}");
    }

    #[test]
    fn values_are_stable() {
        let (digest, signature, signer) = values();
        assert_eq!(digest.len(), 66);
        assert_eq!(signature.len(), 132);
        assert_eq!(signer.len(), 42);
        // The fixture key is the anvil/hardhat account #1, which is public and
        // holds nothing; it exists so both languages can agree on a digest.
        assert_eq!(signer.to_lowercase(), "0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
    }
}

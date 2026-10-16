//! Typed bindings for `VeriCallClearinghouse` plus calldata builders.
//!
//! Everything the verifier sends onchain is built here, so there is exactly one
//! place where the Rust view of the contract lives. The `sol!` macro generates
//! the selectors and the ABI codecs from the same signatures the Solidity
//! compiler sees, which is what makes it safe to hand-roll JSON-RPC instead of
//! depending on a full node client.
//!
//! `ENCODING_CROSS_CHECK` documents the one thing the macro cannot check at
//! compile time: that this file and the deployed bytecode agree. `scripts/verify-abi.mjs`
//! diffs the selectors here against `forge inspect VeriCallClearinghouse abi`
//! and fails the build if a signature drifts.

use alloy_primitives::{Address, Bytes, B256, U256};
use alloy_sol_types::{sol, SolCall, SolValue};

/// Re-exported so sibling modules can name amounts without importing alloy.
pub use alloy_primitives::U256 as Uint256;
/// Re-exported so sibling modules can build calldata without importing alloy.
pub use alloy_primitives::Bytes as CalldataBytes;

sol! {
    /// Minimal ERC-20 surface used for USDC balances and approvals.
    #[derive(Debug)]
    interface IERC20 {
        function balanceOf(address account) external view returns (uint256);
        function allowance(address owner, address spender) external view returns (uint256);
        function approve(address spender, uint256 amount) external returns (bool);
        function transfer(address to, uint256 amount) external returns (bool);
    }

    /// The SLA clearinghouse. Signatures must match
    /// `contracts/src/VeriCallClearinghouse.sol` exactly; `verify-abi.mjs`
    /// enforces it.
    #[derive(Debug)]
    interface VeriCallClearinghouse {
        struct Split {
            address recipient;
            uint16 bps;
        }

        struct ServiceCovenant {
            uint256 id;
            address provider;
            address verifier;
            string name;
            string endpointUri;
            bytes32 schemaHash;
            uint256 callPriceUsdc;
            uint32 graceLatencyMs;
            uint32 hardTimeoutMs;
            uint16 maxRebateBps;
            uint16 slashPenaltyBps;
            uint256 providerBondUsdc;
            bool active;
            Split[] splits;
        }

        struct CallOrder {
            uint256 id;
            uint256 serviceId;
            address caller;
            uint256 escrowedUsdc;
            bytes32 requestHash;
            uint64 createdAt;
            uint64 expiryAt;
            uint8 status;
            uint32 measuredLatencyMs;
            bytes32 responseHash;
            bool schemaValid;
            uint256 paidToProvider;
            uint256 paidToDependencies;
            uint256 refundedToCaller;
            uint256 bondSlashed;
        }

        function registerService(
            address provider,
            address verifier,
            string name,
            string endpointUri,
            bytes32 schemaHash,
            uint256 callPriceUsdc,
            uint32 graceLatencyMs,
            uint32 hardTimeoutMs,
            uint16 maxRebateBps,
            uint16 slashPenaltyBps,
            uint256 initialBond,
            address[] recipients,
            uint16[] bps,
            uint256 providerNonce,
            bytes providerSig
        ) external returns (uint256 serviceId);

        function registerServiceAuthorized(
            address provider,
            address verifier,
            string name,
            string endpointUri,
            bytes32 schemaHash,
            uint256 callPriceUsdc,
            uint32 graceLatencyMs,
            uint32 hardTimeoutMs,
            uint16 maxRebateBps,
            uint16 slashPenaltyBps,
            uint256 initialBond,
            address[] recipients,
            uint16[] bps
        ) external returns (uint256 serviceId);

        function setVerifier(uint256 serviceId, address newVerifier) external;
        function setActive(uint256 serviceId, bool active) external;
        function depositBond(uint256 serviceId, uint256 amount) external;
        function withdrawBond(uint256 serviceId, uint256 amount, address to) external;

        function createOrder(
            uint256 serviceId,
            bytes32 requestHash,
            uint64 ttlSeconds
        ) external returns (uint256 orderId);

        function settleOrder(
            uint256 orderId,
            uint32 latencyMs,
            bool schemaValid,
            bytes32 responseHash,
            uint64 deadline,
            bytes verifierSig
        ) external;

        function reclaimExpiredOrder(uint256 orderId) external;
        function claimFallback() external;

        function quoteSettlement(
            uint256 serviceId,
            uint256 escrowedUsdc,
            uint32 latencyMs,
            bool schemaValid
        ) external view returns (
            uint8 status,
            uint256 rebate,
            uint256 bondSlash,
            uint256 net,
            uint256[] splitAmounts
        );

        function getService(uint256 serviceId) external view returns (ServiceCovenant covenant);
        function getSplits(uint256 serviceId) external view returns (Split[] splits);
        function getServiceCount() external view returns (uint256);
        function getOrder(uint256 orderId) external view returns (CallOrder order);
        function getOrderCount() external view returns (uint256);
        function claimable(address account) external view returns (uint256);
        function providerNonce(address provider) external view returns (uint256);
        function totalEscrowed() external view returns (uint256);
        function totalBond() external view returns (uint256);
        function owner() external view returns (address);
        function usdc() external view returns (address);
        function VERSION() external view returns (string);
        function version() external pure returns (string);
    }
}

/// Order status values, matching `enum OrderStatus` in Solidity.
pub const STATUS_NONE: u8 = 0;
pub const STATUS_FUNDED: u8 = 1;
pub const STATUS_SETTLED_PASS: u8 = 2;
pub const STATUS_SETTLED_DEGRADED: u8 = 3;
pub const STATUS_SETTLED_BREACHED: u8 = 4;
pub const STATUS_RECLAIMED_EXPIRED: u8 = 5;

pub fn status_name(status: u8) -> &'static str {
    match status {
        STATUS_FUNDED => "funded",
        STATUS_SETTLED_PASS => "settled_pass",
        STATUS_SETTLED_DEGRADED => "settled_degraded",
        STATUS_SETTLED_BREACHED => "settled_breached",
        STATUS_RECLAIMED_EXPIRED => "reclaimed_expired",
        _ => "none",
    }
}

/// USDC on Arc: same address on mainnet (5042) and testnet (5042002).
pub const USDC_ADDRESS: &str = "0x3600000000000000000000000000000000000000";

/// The USDC ERC-20 interface uses 6 decimals on both Arc networks.
pub const USDC_DECIMALS: u32 = 6;

/// Arc's mainnet chain id.
pub const ARC_MAINNET_CHAIN_ID: u64 = 5042;
/// Arc's testnet chain id.
pub const ARC_TESTNET_CHAIN_ID: u64 = 5_042_002;

/// Format a 6-decimal USDC amount for humans without floating point.
pub fn format_usdc(amount: U256) -> String {
    let scale = U256::from(10u64).pow(U256::from(USDC_DECIMALS));
    let whole = amount / scale;
    let frac = amount % scale;
    if frac.is_zero() {
        return whole.to_string();
    }
    let frac_str = format!("{frac:0>width$}", width = USDC_DECIMALS as usize);
    let trimmed = frac_str.trim_end_matches('0');
    format!("{whole}.{trimmed}")
}

/// Parse "0.2" into 6-decimal base units. Rejects more precision than the token
/// can represent instead of silently rounding money.
pub fn parse_usdc(s: &str) -> Result<U256, String> {
    let t = s.trim();
    if t.is_empty() {
        return Err("empty amount".to_string());
    }
    let (whole, frac) = match t.split_once('.') {
        Some((w, f)) => (w, f),
        None => (t, ""),
    };
    if whole.is_empty() && frac.is_empty() {
        return Err(format!("`{s}` is not an amount"));
    }
    if frac.len() > USDC_DECIMALS as usize {
        return Err(format!(
            "`{s}` has {} decimal places; USDC on Arc carries {USDC_DECIMALS}",
            frac.len()
        ));
    }
    let whole: u128 = if whole.is_empty() {
        0
    } else {
        whole
            .parse()
            .map_err(|_| format!("`{whole}` is not a whole number"))?
    };
    let mut frac_padded = frac.to_string();
    while frac_padded.len() < USDC_DECIMALS as usize {
        frac_padded.push('0');
    }
    let frac: u128 = if frac_padded.is_empty() {
        0
    } else {
        frac_padded
            .parse()
            .map_err(|_| format!("`{frac}` is not a fractional part"))?
    };
    Ok(U256::from(whole) * U256::from(1_000_000u64) + U256::from(frac))
}

fn address(s: &str) -> Address {
    s.parse().expect("checked above")
}

/// Build calldata for `settleOrder`.
pub fn settle_order_calldata(
    order_id: U256,
    latency_ms: u32,
    schema_valid: bool,
    response_hash: B256,
    deadline: u64,
    signature: &[u8],
) -> Bytes {
    let call = VeriCallClearinghouse::settleOrderCall {
        orderId: order_id,
        latencyMs: latency_ms,
        schemaValid: schema_valid,
        responseHash: response_hash,
        deadline,
        verifierSig: Bytes::copy_from_slice(signature),
    };
    Bytes::from(call.abi_encode())
}

/// Build calldata for `createOrder`.
pub fn create_order_calldata(service_id: U256, request_hash: B256, ttl_seconds: u64) -> Bytes {
    let call = VeriCallClearinghouse::createOrderCall {
        serviceId: service_id,
        requestHash: request_hash,
        ttlSeconds: ttl_seconds,
    };
    Bytes::from(call.abi_encode())
}

/// Build calldata for `reclaimExpiredOrder`.
pub fn reclaim_expired_order_calldata(order_id: U256) -> Bytes {
    Bytes::from(VeriCallClearinghouse::reclaimExpiredOrderCall { orderId: order_id }.abi_encode())
}

/// Build calldata for `registerServiceAuthorized` from parallel arrays.
pub fn register_service_authorized_calldata(
    params: &RegisterServiceParams,
    callers: &[[u8; 20]],
    bps: &[u16],
) -> Bytes {
    let recipients: Vec<Address> = callers
        .iter()
        .map(|a| Address::from_slice(a))
        .collect();
    let call = VeriCallClearinghouse::registerServiceAuthorizedCall {
        provider: Address::from_slice(&params.provider),
        verifier: Address::from_slice(&params.verifier),
        name: params.name.clone(),
        endpointUri: params.endpoint_uri.clone(),
        schemaHash: B256::from(params.schema_hash),
        callPriceUsdc: params.call_price_usdc,
        graceLatencyMs: params.grace_latency_ms,
        hardTimeoutMs: params.hard_timeout_ms,
        maxRebateBps: params.max_rebate_bps,
        slashPenaltyBps: params.slash_penalty_bps,
        initialBond: params.initial_bond,
        recipients,
        bps: bps.to_vec(),
    };
    Bytes::from(call.abi_encode())
}

/// Build calldata for `depositBond`.
pub fn deposit_bond_calldata(service_id: U256, amount: U256) -> Bytes {
    Bytes::from(
        VeriCallClearinghouse::depositBondCall {
            serviceId: service_id,
            amount,
        }
        .abi_encode(),
    )
}

/// Build calldata for `setActive`.
pub fn set_active_calldata(service_id: U256, active: bool) -> Bytes {
    Bytes::from(
        VeriCallClearinghouse::setActiveCall {
            serviceId: service_id,
            active,
        }
        .abi_encode(),
    )
}

/// Build calldata for `withdrawBond`.
pub fn withdraw_bond_calldata(service_id: U256, amount: U256, to: [u8; 20]) -> Bytes {
    Bytes::from(
        VeriCallClearinghouse::withdrawBondCall {
            serviceId: service_id,
            amount,
            to: Address::from_slice(&to),
        }
        .abi_encode(),
    )
}

/// Build calldata for `claimFallback`.
pub fn claim_fallback_calldata() -> Bytes {
    Bytes::from(VeriCallClearinghouse::claimFallbackCall {}.abi_encode())
}

/// Build calldata for `quoteSettlement`.
pub fn quote_settlement_calldata(
    service_id: U256,
    escrowed: U256,
    latency_ms: u32,
    schema_valid: bool,
) -> Bytes {
    Bytes::from(
        VeriCallClearinghouse::quoteSettlementCall {
            serviceId: service_id,
            escrowedUsdc: escrowed,
            latencyMs: latency_ms,
            schemaValid: schema_valid,
        }
        .abi_encode(),
    )
}

/// Parameters for registering a covenant through the owner-authorized path.
#[derive(Debug, Clone)]
pub struct RegisterServiceParams {
    pub provider: [u8; 20],
    pub verifier: [u8; 20],
    pub name: String,
    pub endpoint_uri: String,
    pub schema_hash: [u8; 32],
    pub call_price_usdc: U256,
    pub grace_latency_ms: u32,
    pub hard_timeout_ms: u32,
    pub max_rebate_bps: u16,
    pub slash_penalty_bps: u16,
    pub initial_bond: U256,
}

/// ERC-20 helpers.
pub mod erc20 {
    use super::*;

    pub fn balance_of_calldata(account: [u8; 20]) -> Bytes {
        Bytes::from(
            IERC20::balanceOfCall {
                account: Address::from_slice(&account),
            }
            .abi_encode(),
        )
    }

    pub fn approve_calldata(spender: [u8; 20], amount: U256) -> Bytes {
        Bytes::from(
            IERC20::approveCall {
                spender: Address::from_slice(&spender),
                amount,
            }
            .abi_encode(),
        )
    }

    pub fn transfer_calldata(to: [u8; 20], amount: U256) -> Bytes {
        Bytes::from(
            IERC20::transferCall {
                to: Address::from_slice(&to),
                amount,
            }
            .abi_encode(),
        )
    }

    pub fn allowance_calldata(owner: [u8; 20], spender: [u8; 20]) -> Bytes {
        Bytes::from(
            IERC20::allowanceCall {
                owner: Address::from_slice(&owner),
                spender: Address::from_slice(&spender),
            }
            .abi_encode(),
        )
    }
}

/// Decode the `quoteSettlement` return tuple.
pub fn decode_quote_settlement(data: &[u8]) -> Result<QuoteReturn, String> {
    let decoded = VeriCallClearinghouse::quoteSettlementCall::abi_decode_returns(data)
        .map_err(|e| format!("could not decode quoteSettlement return: {e}"))?;
    Ok(QuoteReturn {
        status: decoded.status,
        rebate: decoded.rebate,
        bond_slash: decoded.bondSlash,
        net: decoded.net,
        split_amounts: decoded.splitAmounts,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuoteReturn {
    pub status: u8,
    pub rebate: U256,
    pub bond_slash: U256,
    pub net: U256,
    pub split_amounts: Vec<U256>,
}

/// Decode `getService`.
pub fn decode_service(data: &[u8]) -> Result<ServiceReturn, String> {
    let c = VeriCallClearinghouse::getServiceCall::abi_decode_returns(data)
        .map_err(|e| format!("could not decode getService return: {e}"))?;
    Ok(ServiceReturn {
        id: c.id,
        provider: c.provider.into_array(),
        verifier: c.verifier.into_array(),
        name: c.name,
        endpoint_uri: c.endpointUri,
        schema_hash: c.schemaHash.0,
        splits: c
            .splits
            .iter()
            .map(|s| (s.recipient.into_array(), s.bps))
            .collect(),
        call_price_usdc: c.callPriceUsdc,
        grace_latency_ms: c.graceLatencyMs,
        hard_timeout_ms: c.hardTimeoutMs,
        max_rebate_bps: c.maxRebateBps,
        slash_penalty_bps: c.slashPenaltyBps,
        provider_bond_usdc: c.providerBondUsdc,
        active: c.active,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceReturn {
    pub id: U256,
    pub provider: [u8; 20],
    pub verifier: [u8; 20],
    pub name: String,
    pub endpoint_uri: String,
    pub schema_hash: [u8; 32],
    /// Recipients and their basis points, in registration order.
    pub splits: Vec<([u8; 20], u16)>,
    pub call_price_usdc: U256,
    pub grace_latency_ms: u32,
    pub hard_timeout_ms: u32,
    pub max_rebate_bps: u16,
    pub slash_penalty_bps: u16,
    pub provider_bond_usdc: U256,
    pub active: bool,
}

/// Decode `getOrder`.
pub fn decode_order(data: &[u8]) -> Result<OrderReturn, String> {
    let o = VeriCallClearinghouse::getOrderCall::abi_decode_returns(data)
        .map_err(|e| format!("could not decode getOrder return: {e}"))?;
    Ok(OrderReturn {
        id: o.id,
        service_id: o.serviceId,
        caller: o.caller.into_array(),
        escrowed_usdc: o.escrowedUsdc,
        request_hash: o.requestHash.0,
        created_at: o.createdAt,
        expiry_at: o.expiryAt,
        status: o.status,
        measured_latency_ms: o.measuredLatencyMs,
        response_hash: o.responseHash.0,
        schema_valid: o.schemaValid,
        paid_to_provider: o.paidToProvider,
        paid_to_dependencies: o.paidToDependencies,
        refunded_to_caller: o.refundedToCaller,
        bond_slashed: o.bondSlashed,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderReturn {
    pub id: U256,
    pub service_id: U256,
    pub caller: [u8; 20],
    pub escrowed_usdc: U256,
    pub request_hash: [u8; 32],
    pub created_at: u64,
    pub expiry_at: u64,
    pub status: u8,
    pub measured_latency_ms: u32,
    pub response_hash: [u8; 32],
    pub schema_valid: bool,
    pub paid_to_provider: U256,
    pub paid_to_dependencies: U256,
    pub refunded_to_caller: U256,
    pub bond_slashed: U256,
}

/// Decode `getSplits`.
pub fn decode_splits(data: &[u8]) -> Result<Vec<( [u8; 20], u16 )>, String> {
    let splits = VeriCallClearinghouse::getSplitsCall::abi_decode_returns(data)
        .map_err(|e| format!("could not decode getSplits return: {e}"))?;
    Ok(splits
        .into_iter()
        .map(|s| (s.recipient.into_array(), s.bps))
        .collect())
}

/// Decode a `uint256` view return.
pub fn decode_uint(data: &[u8]) -> Result<U256, String> {
    U256::abi_decode(data).map_err(|e| format!("could not decode uint256: {e}"))
}

/// Decode an `address` view return.
pub fn decode_address(data: &[u8]) -> Result<[u8; 20], String> {
    Address::abi_decode(data)
        .map(|a| a.into_array())
        .map_err(|e| format!("could not decode address: {e}"))
}

/// Decode a `string` view return.
pub fn decode_string(data: &[u8]) -> Result<String, String> {
    String::abi_decode(data).map_err(|e| format!("could not decode string: {e}"))
}

/// A helper the ABI cross-check script reads: every signature this file builds
/// calldata for, in canonical form.
pub const ENCODING_CROSS_CHECK: &[&str] = &[
    "registerService(address,address,string,string,bytes32,uint256,uint32,uint32,uint16,uint16,uint256,address[],uint16[],uint256,bytes)",
    "registerServiceAuthorized(address,address,string,string,bytes32,uint256,uint32,uint32,uint16,uint16,uint256,address[],uint16[])",
    "setVerifier(uint256,address)",
    "setActive(uint256,bool)",
    "depositBond(uint256,uint256)",
    "withdrawBond(uint256,uint256,address)",
    "createOrder(uint256,bytes32,uint64)",
    "settleOrder(uint256,uint32,bool,bytes32,uint64,bytes)",
    "reclaimExpiredOrder(uint256)",
    "claimFallback()",
    "quoteSettlement(uint256,uint256,uint32,bool)",
    "getService(uint256)",
    "getSplits(uint256)",
    "getServiceCount()",
    "getOrder(uint256)",
    "getOrderCount()",
    "claimable(address)",
    "totalEscrowed()",
    "totalBond()",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usdc_formatting_is_exact() {
        assert_eq!(format_usdc(U256::from(0)), "0");
        assert_eq!(format_usdc(U256::from(1)), "0.000001");
        assert_eq!(format_usdc(U256::from(200_000)), "0.2");
        assert_eq!(format_usdc(U256::from(1_500_000)), "1.5");
        assert_eq!(format_usdc(U256::from(1_000_000)), "1");
        assert_eq!(format_usdc(U256::from(123_456_789)), "123.456789");
    }

    #[test]
    fn usdc_parsing_is_exact_and_strict() {
        assert_eq!(parse_usdc("0.2").unwrap(), U256::from(200_000));
        assert_eq!(parse_usdc("1").unwrap(), U256::from(1_000_000));
        assert_eq!(parse_usdc("0.000001").unwrap(), U256::from(1));
        assert_eq!(parse_usdc("123.456789").unwrap(), U256::from(123_456_789));
        assert_eq!(parse_usdc(".5").unwrap(), U256::from(500_000));
        assert!(parse_usdc("0.0000001").is_err(), "more precision than USDC has");
        assert!(parse_usdc("abc").is_err());
        assert!(parse_usdc("").is_err());
    }

    #[test]
    fn settle_calldata_has_the_right_selector_and_length() {
        let cd = settle_order_calldata(
            U256::from(1),
            1250,
            true,
            B256::repeat_byte(0x11),
            1_760_000_600,
            &[0u8; 65],
        );
        // selector(4) + 6 head words(192) + bytes length word(32) + 96 bytes of
        // signature (65 bytes padded to three words)
        assert_eq!(cd.len(), 4 + 192 + 32 + 96);
        let expected_selector =
            &<VeriCallClearinghouse::settleOrderCall as alloy_sol_types::SolCall>::SELECTOR;
        assert_eq!(&cd[..4], expected_selector);
        // The signature rides along verbatim, so the contract can ecrecover it.
        let sig_start = 4 + 192 + 32;
        assert_eq!(&cd[sig_start..sig_start + 64], &[0u8; 64]);
    }

    #[test]
    fn create_order_calldata_is_four_head_words() {
        let cd = create_order_calldata(U256::from(7), B256::repeat_byte(0x22), 3600);
        assert_eq!(cd.len(), 4 + 96);
    }

    #[test]
    fn status_names_are_stable_strings() {
        // The API and the UI both key on these, so they are frozen strings.
        assert_eq!(status_name(1), "funded");
        assert_eq!(status_name(2), "settled_pass");
        assert_eq!(status_name(3), "settled_degraded");
        assert_eq!(status_name(4), "settled_breached");
        assert_eq!(status_name(5), "reclaimed_expired");
        assert_eq!(status_name(255), "none");
    }

    #[test]
    fn usdc_address_is_the_arc_predeploy() {
        let parsed = address(USDC_ADDRESS);
        assert_eq!(parsed.as_slice()[0], 0x36);
        assert!(parsed.as_slice()[1..].iter().all(|b| *b == 0));
        // The same ERC-20 interface is predeployed on mainnet and testnet.
        assert_ne!(ARC_MAINNET_CHAIN_ID, ARC_TESTNET_CHAIN_ID);
    }

    #[test]
    fn register_service_encoding_round_trips_through_the_macro() {
        let params = RegisterServiceParams {
            provider: [0xAA; 20],
            verifier: [0xBB; 20],
            name: "Risk Scorer".into(),
            endpoint_uri: "http://localhost:8080/mock-services/risk-scorer".into(),
            schema_hash: [0x11; 32],
            call_price_usdc: U256::from(200_000),
            grace_latency_ms: 500,
            hard_timeout_ms: 2000,
            max_rebate_bps: 4000,
            slash_penalty_bps: 2000,
            initial_bond: U256::from(100_000),
        };
        let cd = register_service_authorized_calldata(&params, &[[0xAA; 20], [0xCC; 20]], &[8000, 2000]);
        assert!(cd.len() > 4 + 12 * 32);
        let (selector, args) = cd.split_at(4);
        assert_eq!(
            selector,
            &<VeriCallClearinghouse::registerServiceAuthorizedCall as SolCall>::SELECTOR
        );
        let decoded =
            VeriCallClearinghouse::registerServiceAuthorizedCall::abi_decode_raw(args).unwrap();
        assert_eq!(decoded.provider, Address::from_slice(&[0xAA; 20]));
        assert_eq!(decoded.recipients.len(), 2);
        assert_eq!(decoded.bps, vec![8000, 2000]);
        assert_eq!(decoded.callPriceUsdc, U256::from(200_000));
    }
}

#[cfg(test)]
mod selector_lock {
    use super::*;
    use std::collections::BTreeMap;

    /// The deployed contract's real selectors, produced by
    /// `forge inspect VeriCallClearinghouse methodIdentifiers --json` and checked
    /// into `contracts/abi-lock.json`.
    ///
    /// The `sol!` macro derives selectors from the signatures written here. That
    /// guarantees this file is internally consistent, but not that it matches the
    /// compiled contract — a parameter reordering compiles happily on both sides
    /// and then reverts on mainnet. This test closes that gap: every function
    /// this module builds calldata for must appear below with the same selector.
    fn locked() -> BTreeMap<&'static str, &'static str> {
        BTreeMap::from([
            ("VERSION()", "ffa1ad74"),
            ("claimFallback()", "a3e0acca"),
            ("claimable(address)", "402914f5"),
            ("createOrder(uint256,bytes32,uint64)", "514a6096"),
            ("depositBond(uint256,uint256)", "c253c295"),
            ("getOrder(uint256)", "d09ef241"),
            ("getOrderCount()", "8d0a5fbb"),
            ("getService(uint256)", "ef0e239b"),
            ("getServiceCount()", "3672404e"),
            ("getSplits(uint256)", "2a5768b7"),
            ("owner()", "8da5cb5b"),
            ("providerNonce(address)", "d2112d3e"),
            ("quoteSettlement(uint256,uint256,uint32,bool)", "17f16afb"),
            ("reclaimExpiredOrder(uint256)", "896491d7"),
            (
                "registerService(address,address,string,string,bytes32,uint256,uint32,uint32,uint16,uint16,uint256,address[],uint16[],uint256,bytes)",
                "b2eac201",
            ),
            (
                "registerServiceAuthorized(address,address,string,string,bytes32,uint256,uint32,uint32,uint16,uint16,uint256,address[],uint16[])",
                "09f8f75a",
            ),
            ("setActive(uint256,bool)", "e60a955d"),
            ("setVerifier(uint256,address)", "1957ba4e"),
            ("settleOrder(uint256,uint32,bool,bytes32,uint64,bytes)", "1369f674"),
            ("totalBond()", "9b09723e"),
            ("totalEscrowed()", "f9168231"),
            ("usdc()", "3e413bee"),
            ("version()", "54fd4d50"),
            ("withdrawBond(uint256,uint256,address)", "b3a03708"),
        ])
    }

    fn hex4<C: alloy_sol_types::SolCall>() -> String {
        hex::encode(C::SELECTOR)
    }

    #[test]
    fn every_binding_matches_the_compiled_contract() {
        let locked = locked();
        let bindings: Vec<(&str, String)> = vec![
            ("settleOrder(uint256,uint32,bool,bytes32,uint64,bytes)", hex4::<VeriCallClearinghouse::settleOrderCall>()),
            ("createOrder(uint256,bytes32,uint64)", hex4::<VeriCallClearinghouse::createOrderCall>()),
            ("reclaimExpiredOrder(uint256)", hex4::<VeriCallClearinghouse::reclaimExpiredOrderCall>()),
            ("claimFallback()", hex4::<VeriCallClearinghouse::claimFallbackCall>()),
            ("depositBond(uint256,uint256)", hex4::<VeriCallClearinghouse::depositBondCall>()),
            ("withdrawBond(uint256,uint256,address)", hex4::<VeriCallClearinghouse::withdrawBondCall>()),
            ("setActive(uint256,bool)", hex4::<VeriCallClearinghouse::setActiveCall>()),
            ("quoteSettlement(uint256,uint256,uint32,bool)", hex4::<VeriCallClearinghouse::quoteSettlementCall>()),
            ("getService(uint256)", hex4::<VeriCallClearinghouse::getServiceCall>()),
            ("getSplits(uint256)", hex4::<VeriCallClearinghouse::getSplitsCall>()),
            ("getServiceCount()", hex4::<VeriCallClearinghouse::getServiceCountCall>()),
            ("getOrder(uint256)", hex4::<VeriCallClearinghouse::getOrderCall>()),
            ("getOrderCount()", hex4::<VeriCallClearinghouse::getOrderCountCall>()),
            ("claimable(address)", hex4::<VeriCallClearinghouse::claimableCall>()),
            ("totalEscrowed()", hex4::<VeriCallClearinghouse::totalEscrowedCall>()),
            ("totalBond()", hex4::<VeriCallClearinghouse::totalBondCall>()),
            ("owner()", hex4::<VeriCallClearinghouse::ownerCall>()),
            ("usdc()", hex4::<VeriCallClearinghouse::usdcCall>()),
            ("version()", hex4::<VeriCallClearinghouse::versionCall>()),
            ("VERSION()", hex4::<VeriCallClearinghouse::VERSIONCall>()),
            ("providerNonce(address)", hex4::<VeriCallClearinghouse::providerNonceCall>()),
            (
                "registerServiceAuthorized(address,address,string,string,bytes32,uint256,uint32,uint32,uint16,uint16,uint256,address[],uint16[])",
                hex4::<VeriCallClearinghouse::registerServiceAuthorizedCall>(),
            ),
            (
                "registerService(address,address,string,string,bytes32,uint256,uint32,uint32,uint16,uint16,uint256,address[],uint16[],uint256,bytes)",
                hex4::<VeriCallClearinghouse::registerServiceCall>(),
            ),
        ];

        for (signature, selector) in bindings {
            let expected = locked.get(signature).unwrap_or_else(|| {
                panic!("{signature} is built by the verifier but is not in the lock file")
            });
            assert_eq!(
                &selector, expected,
                "{signature} selector drifted: the Rust bindings no longer match the contract"
            );
        }
        // ERC-20 helpers used for balances and approvals.
        assert_eq!(hex4::<IERC20::balanceOfCall>(), "70a08231");
        assert_eq!(hex4::<IERC20::allowanceCall>(), "dd62ed3e");
        assert_eq!(hex4::<IERC20::approveCall>(), "095ea7b3");
        assert_eq!(hex4::<IERC20::transferCall>(), "a9059cbb");
    }
}

//! Piecewise-linear SLA settlement math.
//!
//! This module is the single source of truth for "what does this latency cost?".
//! It is written to be bit-for-bit identical to the arithmetic in
//! `contracts/src/VeriCallClearinghouse.sol` (`quoteSettlement` and
//! `settleOrder`). If the two ever disagree, the chain is right and this file is
//! a bug: the contract is the settlement authority, the verifier is only allowed
//! to produce a *quote* that a human or agent reviews before signing.
//!
//! Rules, in the order the contract applies them:
//!
//! 1. A hard breach is `!schema_valid || latency_ms > hard_timeout_ms`. The
//!    caller is refunded the full escrow, plus a bond penalty
//!    `min(escrow * slash_penalty_bps / 10_000, provider_bond)` taken from the
//!    provider's staked bond.
//! 2. Otherwise a rebate accrues linearly with the overrun past the grace SLA:
//!
//!    ```text
//!    rebate = escrow * max_rebate_bps * (latency_ms - grace_ms)
//!             / (10_000 * (hard_timeout_ms - grace_ms))
//!    ```
//!
//!    capped at the escrow. Rebate 0 is a pass; rebate > 0 is degraded.
//! 3. Pass/degraded: `net = escrow - rebate` is split across the covenant's
//!    recipients by basis points. Integer division is floored, and every unit of
//!    the remainder is assigned to the provider's share, so the parts always sum
//!    to `net` exactly. No dust is stranded.
//!
//! All amounts are 6-decimal USDC base units, matching the ERC-20 interface at
//! `0x3600000000000000000000000000000000000000` on Arc. Never mix these with the
//! 18-decimal native balance.

use serde::{Deserialize, Serialize};

/// total basis points
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Order lifecycle, identical to `enum OrderStatus` in the contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderStatus {
    None,
    Funded,
    SettledPass,
    SettledDegraded,
    SettledBreached,
    ReclaimedExpired,
}

impl OrderStatus {
    pub fn as_u8(self) -> u8 {
        match self {
            OrderStatus::None => 0,
            OrderStatus::Funded => 1,
            OrderStatus::SettledPass => 2,
            OrderStatus::SettledDegraded => 3,
            OrderStatus::SettledBreached => 4,
            OrderStatus::ReclaimedExpired => 5,
        }
    }

    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => OrderStatus::Funded,
            2 => OrderStatus::SettledPass,
            3 => OrderStatus::SettledDegraded,
            4 => OrderStatus::SettledBreached,
            5 => OrderStatus::ReclaimedExpired,
            _ => OrderStatus::None,
        }
    }

    /// True for the three terminal states that consume an escrow.
    pub fn is_settled(self) -> bool {
        matches!(
            self,
            OrderStatus::SettledPass
                | OrderStatus::SettledDegraded
                | OrderStatus::SettledBreached
                | OrderStatus::ReclaimedExpired
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Split {
    #[serde(with = "address_serde")]
    pub recipient: [u8; 20],
    pub bps: u16,
}

impl Split {
    pub fn new(recipient: [u8; 20], bps: u16) -> Self {
        Self { recipient, bps }
    }
}

/// The immutable pricing terms of a covenant, as the verifier needs them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CovenantTerms {
    pub grace_latency_ms: u32,
    pub hard_timeout_ms: u32,
    pub max_rebate_bps: u16,
    pub slash_penalty_bps: u16,
    pub call_price_usdc: u64,
    pub splits: Vec<Split>,
    /// index of the provider within `splits`; the provider absorbs division
    /// remainder so that the shares sum to the net amount exactly.
    pub provider_index: usize,
}

/// A computed settlement. Field-for-field the return of `quoteSettlement`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quote {
    pub status: OrderStatus,
    pub latency_ms: u32,
    pub schema_valid: bool,
    pub escrow: u64,
    /// USDC returned to the caller (pass: 0; degraded: partial; breach: full escrow).
    pub rebate_to_caller: u64,
    /// Bond penalty paid to the caller from the provider's stake (breach only).
    pub bond_slash: u64,
    /// Amount available for the provider + dependency splits after the rebate.
    pub net: u64,
    /// Per-recipient payout, same order as `CovenantTerms::splits`.
    pub split_amounts: Vec<u64>,
    /// Sum of the non-provider shares (the upstream dependencies).
    pub paid_to_dependencies: u64,
    /// The provider's share, including any division remainder.
    pub paid_to_provider: u64,
}

impl Quote {
    /// Total USDC that leaves the contract for this settlement.
    pub fn total_out(&self) -> u64 {
        self.rebate_to_caller + self.bond_slash + self.net
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum QuoteError {
    #[error("grace_latency_ms ({grace}) must be <= hard_timeout_ms ({hard})")]
    GraceExceedsHard { grace: u32, hard: u32 },
    #[error("hard_timeout_ms must be greater than 0")]
    ZeroHardTimeout,
    #[error("max_rebate_bps ({0}) exceeds 10000")]
    MaxRebateTooLarge(u16),
    #[error("slash_penalty_bps ({0}) exceeds 10000")]
    SlashPenaltyTooLarge(u16),
    #[error("splits must not be empty")]
    NoSplits,
    #[error("splits sum to {sum} bps, must equal exactly 10000")]
    SplitsNot10000 { sum: u32 },
    #[error("provider_index {0} is out of range for {1} splits")]
    ProviderIndexOutOfRange(usize, usize),
}

impl CovenantTerms {
    /// Reject terms the contract would reject, so the verifier never signs a
    /// settlement the chain will revert.
    pub fn validate(&self) -> Result<(), QuoteError> {
        if self.hard_timeout_ms == 0 {
            return Err(QuoteError::ZeroHardTimeout);
        }
        if self.grace_latency_ms > self.hard_timeout_ms {
            return Err(QuoteError::GraceExceedsHard {
                grace: self.grace_latency_ms,
                hard: self.hard_timeout_ms,
            });
        }
        if self.max_rebate_bps > BPS_DENOMINATOR as u16 {
            return Err(QuoteError::MaxRebateTooLarge(self.max_rebate_bps));
        }
        if self.slash_penalty_bps > BPS_DENOMINATOR as u16 {
            return Err(QuoteError::SlashPenaltyTooLarge(self.slash_penalty_bps));
        }
        if self.splits.is_empty() {
            return Err(QuoteError::NoSplits);
        }
        let sum: u32 = self.splits.iter().map(|s| s.bps as u32).sum();
        if sum != BPS_DENOMINATOR as u32 {
            return Err(QuoteError::SplitsNot10000 { sum });
        }
        if self.provider_index >= self.splits.len() {
            return Err(QuoteError::ProviderIndexOutOfRange(
                self.provider_index,
                self.splits.len(),
            ));
        }
        Ok(())
    }

    /// The bond a provider must have staked for one open order at `price`.
    /// Mirrors the contract's `createOrder` requirement, computed with ceiling
    /// division so the on-chain check `bond >= penalty` is never off by one.
    pub fn required_bond(&self, price: u64) -> u64 {
        div_ceil(
            (price as u128) * (self.slash_penalty_bps as u128),
            BPS_DENOMINATOR as u128,
        ) as u64
    }

    /// Rebate in USDC base units for a measured latency, before the breach test.
    pub fn raw_rebate(&self, escrow: u64, latency_ms: u32) -> u64 {
        if latency_ms <= self.grace_latency_ms {
            return 0;
        }
        // Callers are expected to have classified a breach first; the cap below
        // also makes the overrun path safe on its own.
        let overrun = (latency_ms - self.grace_latency_ms) as u128;
        let span = (self.hard_timeout_ms - self.grace_latency_ms) as u128;
        if span == 0 {
            // grace == hard: any overrun sits at the hard edge, so the rebate is
            // the full maximum backed out by the cap below.
            return cap_to((escrow as u128) * (self.max_rebate_bps as u128) / BPS_DENOMINATOR as u128, escrow);
        }
        let numerator = (escrow as u128) * (self.max_rebate_bps as u128) * overrun;
        let denominator = (BPS_DENOMINATOR as u128) * span;
        cap_to(numerator / denominator, escrow)
    }

    /// Quote a settlement. Identical in result to `quoteSettlement` on-chain.
    pub fn quote(
        &self,
        escrow: u64,
        latency_ms: u32,
        schema_valid: bool,
        bond_available: u64,
    ) -> Result<Quote, QuoteError> {
        self.validate()?;

        let breach = !schema_valid || latency_ms > self.hard_timeout_ms;
        if breach {
            let bond_slash = cap_to(
                (escrow as u128) * (self.slash_penalty_bps as u128) / BPS_DENOMINATOR as u128,
                bond_available,
            );
            return Ok(Quote {
                status: OrderStatus::SettledBreached,
                latency_ms,
                schema_valid,
                escrow,
                rebate_to_caller: escrow,
                bond_slash,
                net: 0,
                split_amounts: vec![0; self.splits.len()],
                paid_to_dependencies: 0,
                paid_to_provider: 0,
            });
        }

        let rebate = self.raw_rebate(escrow, latency_ms);
        let status = if rebate == 0 {
            OrderStatus::SettledPass
        } else {
            OrderStatus::SettledDegraded
        };
        let net = escrow - rebate;
        let (split_amounts, paid_to_provider, paid_to_dependencies) = self.split_net(net);

        Ok(Quote {
            status,
            latency_ms,
            schema_valid,
            escrow,
            rebate_to_caller: rebate,
            bond_slash: 0,
            net,
            split_amounts,
            paid_to_dependencies,
            paid_to_provider,
        })
    }

    /// Distribute `net` across the recipients. Floored per share; the provider
    /// keeps the remainder so the parts sum to `net` exactly.
    pub fn split_net(&self, net: u64) -> (Vec<u64>, u64, u64) {
        let mut amounts = vec![0u64; self.splits.len()];
        let mut assigned: u64 = 0;
        for (i, s) in self.splits.iter().enumerate() {
            if i == self.provider_index {
                continue;
            }
            let share = ((net as u128) * (s.bps as u128) / BPS_DENOMINATOR as u128) as u64;
            amounts[i] = share;
            assigned += share;
        }
        let provider_share = net - assigned;
        amounts[self.provider_index] = provider_share;
        let deps: u64 = amounts
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != self.provider_index)
            .map(|(_, v)| *v)
            .sum();
        (amounts, provider_share, deps)
    }
}

fn cap_to(value: u128, cap: u64) -> u64 {
    if value > cap as u128 {
        cap
    } else {
        value as u64
    }
}

fn div_ceil(numerator: u128, denominator: u128) -> u128 {
    if numerator == 0 {
        0
    } else {
        (numerator - 1) / denominator + 1
    }
}

// ---------------------------------------------------------------------------
// serde helper: addresses as 0x-prefixed lowercase hex
// ---------------------------------------------------------------------------

pub mod address_serde {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(addr: &[u8; 20], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("0x{}", hex::encode(addr)))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 20], D::Error> {
        let s = String::deserialize(d)?;
        parse_address(&s).map_err(serde::de::Error::custom)
    }

    pub fn parse_address(s: &str) -> Result<[u8; 20], String> {
        let t = s.trim().trim_start_matches("0x").trim_start_matches("0X");
        if t.len() != 40 {
            return Err(format!("address must be 20 bytes of hex, got {s:?}"));
        }
        let bytes = hex::decode(t).map_err(|e| format!("invalid hex address {s:?}: {e}"))?;
        let mut out = [0u8; 20];
        out.copy_from_slice(&bytes);
        Ok(out)
    }

    pub fn format_address(addr: &[u8; 20]) -> String {
        format!("0x{}", hex::encode(addr))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(n: u8) -> [u8; 20] {
        [n; 20]
    }

    /// The scenario from the contract test suite and the demo: grace 500ms,
    /// hard 2000ms, max rebate 4000 bps (40%), price 0.20 USDC, latency 1250ms.
    /// Overrun is 750 of 1500 = half the span, so the rebate is half of the
    /// 40% maximum: 20% of 0.20 USDC = 0.04 USDC = 40_000 base units.
    fn demo_terms() -> CovenantTerms {
        CovenantTerms {
            grace_latency_ms: 500,
            hard_timeout_ms: 2000,
            max_rebate_bps: 4000,
            slash_penalty_bps: 2000,
            call_price_usdc: 200_000, // 0.20 USDC
            splits: vec![Split::new(addr(0xAA), 8000), Split::new(addr(0xBB), 2000)],
            provider_index: 0,
        }
    }

    #[test]
    fn pass_at_and_below_grace() {
        let t = demo_terms();
        for latency in [0, 1, 250, 500] {
            let q = t.quote(t.call_price_usdc, latency, true, 1_000_000).unwrap();
            assert_eq!(q.status, OrderStatus::SettledPass, "latency {latency}");
            assert_eq!(q.rebate_to_caller, 0);
            assert_eq!(q.net, t.call_price_usdc);
            assert_eq!(q.split_amounts, vec![160_000, 40_000]);
            assert_eq!(q.paid_to_provider, 160_000);
            assert_eq!(q.paid_to_dependencies, 40_000);
        }
    }

    #[test]
    fn demo_degraded_case_is_exactly_twenty_percent() {
        let t = demo_terms();
        let q = t.quote(t.call_price_usdc, 1250, true, 1_000_000).unwrap();
        assert_eq!(q.status, OrderStatus::SettledDegraded);
        assert_eq!(q.rebate_to_caller, 40_000, "20% of 0.20 USDC");
        assert_eq!(q.net, 160_000);
        assert_eq!(q.split_amounts, vec![128_000, 32_000]);
        assert_eq!(q.paid_to_provider, 128_000);
        assert_eq!(q.paid_to_dependencies, 32_000);
        assert_eq!(q.total_out(), t.call_price_usdc);
    }

    #[test]
    fn rebate_hits_maximum_at_the_hard_edge() {
        let t = demo_terms();
        let q = t.quote(t.call_price_usdc, 2000, true, 1_000_000).unwrap();
        assert_eq!(q.status, OrderStatus::SettledDegraded);
        // 40% of 0.20 USDC
        assert_eq!(q.rebate_to_caller, 80_000);
        assert_eq!(q.net, 120_000);
    }

    #[test]
    fn hard_breach_refunds_everything_and_slashes_the_bond() {
        let t = demo_terms();
        for latency in [2001, 5000, 60_000] {
            let q = t.quote(t.call_price_usdc, latency, true, 1_000_000).unwrap();
            assert_eq!(q.status, OrderStatus::SettledBreached, "latency {latency}");
            assert_eq!(q.rebate_to_caller, t.call_price_usdc);
            assert_eq!(q.bond_slash, 40_000, "20% of 0.20 USDC");
            assert_eq!(q.net, 0);
            assert_eq!(q.paid_to_provider, 0);
            assert_eq!(q.paid_to_dependencies, 0);
            assert_eq!(q.total_out(), t.call_price_usdc + 40_000);
        }
    }

    #[test]
    fn invalid_schema_is_a_breach_at_any_latency() {
        let t = demo_terms();
        let q = t.quote(t.call_price_usdc, 10, false, 1_000_000).unwrap();
        assert_eq!(q.status, OrderStatus::SettledBreached);
        assert_eq!(q.rebate_to_caller, t.call_price_usdc);
    }

    #[test]
    fn bond_slash_is_capped_by_the_stake() {
        let t = demo_terms();
        let q = t.quote(t.call_price_usdc, 9_999, true, 7).unwrap();
        assert_eq!(q.bond_slash, 7);
    }

    #[test]
    fn rebate_is_monotonic_and_bounded() {
        let t = demo_terms();
        let mut previous = 0u64;
        for latency in (0..=2000).step_by(25) {
            let rebate = t.raw_rebate(200_000, latency);
            assert!(
                rebate >= previous,
                "rebate decreased at {latency}: {rebate} < {previous}"
            );
            assert!(rebate <= 80_000, "rebate exceeded the 40% cap at {latency}");
            previous = rebate;
        }
        assert_eq!(t.raw_rebate(200_000, 500), 0);
        assert_eq!(t.raw_rebate(200_000, 2000), 80_000);
    }

    #[test]
    fn splits_always_sum_to_net_even_when_dusty() {
        // 3 ways where floored shares would otherwise strand units.
        let t = CovenantTerms {
            grace_latency_ms: 0,
            hard_timeout_ms: 1000,
            max_rebate_bps: 0,
            slash_penalty_bps: 0,
            call_price_usdc: 7,
            splits: vec![
                Split::new(addr(1), 3333),
                Split::new(addr(2), 3333),
                Split::new(addr(3), 3334),
            ],
            provider_index: 0,
        };
        let q = t.quote(7, 0, true, 0).unwrap();
        let sum: u64 = q.split_amounts.iter().sum();
        assert_eq!(sum, 7, "no dust may be stranded: {:?}", q.split_amounts);
        assert_eq!(q.split_amounts[0], 7 - q.split_amounts[1] - q.split_amounts[2]);
    }

    #[test]
    fn required_bond_rounds_up() {
        let t = demo_terms();
        // 200_000 * 2000 / 10_000 = 40_000 exactly
        assert_eq!(t.required_bond(200_000), 40_000);
        // 20_001 * 2000 / 10_000 = 4000.2 → 4001 with ceiling division
        assert_eq!(t.required_bond(20_001), 4001);
    }

    #[test]
    fn rejects_terms_the_chain_would_reject() {
        let mut t = demo_terms();
        t.splits[1].bps = 1999;
        assert!(matches!(t.quote(1, 0, true, 0), Err(QuoteError::SplitsNot10000 { .. })));

        let mut t = demo_terms();
        t.grace_latency_ms = 3000;
        assert!(matches!(
            t.quote(1, 0, true, 0),
            Err(QuoteError::GraceExceedsHard { .. })
        ));

        let mut t = demo_terms();
        t.max_rebate_bps = 10_001;
        assert!(matches!(
            t.quote(1, 0, true, 0),
            Err(QuoteError::MaxRebateTooLarge(_))
        ));

        let mut t = demo_terms();
        t.provider_index = 9;
        assert!(matches!(
            t.quote(1, 0, true, 0),
            Err(QuoteError::ProviderIndexOutOfRange(_, _))
        ));
    }

    #[test]
    fn address_roundtrip() {
        let s = "0x4AB5e7F2b5464B9494b49EFE41C2f00e7bcfE555";
        let a = address_serde::parse_address(s).unwrap();
        assert_eq!(
            address_serde::format_address(&a),
            "0x4ab5e7f2b5464b9494b49efe41c2f00e7bcfe555"
        );
        assert!(address_serde::parse_address("0x1234").is_err());
    }
}

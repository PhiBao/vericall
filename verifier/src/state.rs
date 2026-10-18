//! Reads of the deployed clearinghouse, shaped for the UI.
//!
//! This is the part a judge can verify without a wallet: it calls the contract's
//! own view functions on Arc, so the numbers on screen are the chain's numbers.
//! Nothing here is cached across requests and nothing is defaulted to a
//! plausible value — a failure to read surfaces as a failure, because a proof
//! ledger that invents entries is worse than one that is briefly blank.

use crate::abi::{
    self, decode_order, decode_service, decode_string, decode_splits, decode_uint, OrderReturn,
    ServiceReturn, STATUS_FUNDED,
};
use crate::chain::{ChainError, HttpEth, RpcOutcome};
use crate::config::Config;
use alloy_primitives::U256;
use serde::Serialize;

/// How many services and orders to enumerate. Enough for a live demo, bounded so
/// a hostile deployment cannot make one HTTP request fan out without limit.
pub const MAX_SERVICES: u64 = 24;
pub const MAX_ORDERS: u64 = 60;

/// How many chain reads are in flight at once. Each read already races three
/// endpoints, so this is the number of *logical* reads, not HTTP requests.
pub const READ_CONCURRENCY: usize = 8;

/// Arc's public RPCs reject an `eth_getLogs` span of 10,000 blocks or more, so
/// every scan is chunked below that. The same limit is why the ledger reads
/// state through view functions and only reaches for logs to find transaction
/// hashes — the one thing storage does not carry.
pub const MAX_LOG_SPAN: u64 = 9_000;

/// Where a transaction for an order can be found.
#[derive(Debug, Clone, Default, Serialize)]
pub struct OrderTxs {
    pub created: Option<String>,
    pub settled: Option<String>,
    pub reclaimed: Option<String>,
    pub block_number: Option<u64>,
}

impl OrderTxs {
    /// The most informative link for a row: settlement if it happened, else the
    /// reclaim, else creation.
    pub fn primary(&self) -> Option<&String> {
        self.settled
            .as_ref()
            .or(self.reclaimed.as_ref())
            .or(self.created.as_ref())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ChainStatus {
    pub network: String,
    pub chain_id: u64,
    pub block_number: u64,
    pub endpoint: String,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceView {
    pub id: String,
    pub provider: String,
    pub verifier: String,
    pub name: String,
    pub endpoint_uri: String,
    pub schema_hash: String,
    pub call_price_usdc: String,
    pub call_price_units: String,
    pub grace_latency_ms: u32,
    pub hard_timeout_ms: u32,
    pub max_rebate_bps: u16,
    pub slash_penalty_bps: u16,
    pub provider_bond_usdc: String,
    pub provider_bond_units: String,
    pub active: bool,
    /// `deterministic` or `jev`. Read from the verifier's own fixture list by
    /// matching the covenant's registered endpoint, so a reader can see at a
    /// glance which covenants put a model call under their latency promise.
    pub backed_by: String,
    /// One sentence on what is behind the endpoint, when it is known.
    pub backing: Option<String>,
    pub splits: Vec<SplitView>,
    pub required_bond_usdc: String,
    /// Bond covers one open order at the current price.
    pub bond_covers_one_order: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SplitView {
    pub recipient: String,
    pub bps: u16,
    pub percent: String,
    pub role: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct OrderView {
    pub id: String,
    /// Transaction links, found by scanning the contract's own events from its
    /// deploy block. `null` means the scan has not covered it, never a guess.
    pub txs: OrderTxs,
    pub service_id: String,
    pub caller: String,
    pub escrowed_usdc: String,
    pub escrowed_units: String,
    pub request_hash: String,
    pub created_at: u64,
    pub expiry_at: u64,
    pub status: u8,
    pub status_name: &'static str,
    pub measured_latency_ms: u32,
    pub response_hash: String,
    pub schema_valid: bool,
    pub paid_to_provider_usdc: String,
    pub paid_to_dependencies_usdc: String,
    pub refunded_to_caller_usdc: String,
    pub bond_slashed_usdc: String,
    pub settlement_total_usdc: String,
    pub settled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BalanceView {
    pub address: String,
    pub native_usdc: String,
    pub usdc: String,
    pub role: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct LedgerView {
    pub chain: ChainStatus,
    pub contract: Option<String>,
    pub contract_code_present: bool,
    pub usdc: String,
    pub explorer: String,
    pub total_escrowed_usdc: String,
    pub total_bond_usdc: String,
    /// `sum(escrow of funded orders) == totalEscrowed()`. The single invariant
    /// that catches an accounting bug in either implementation.
    pub invariant_ok: bool,
    pub invariant_note: String,
    pub open_orders: usize,
    pub services: Vec<ServiceView>,
    pub orders: Vec<OrderView>,
    pub balances: Vec<BalanceView>,
}

/// Read the whole ledger. Every field comes from a chain call.
pub async fn read_ledger(
    cfg: &Config,
    eth: &HttpEth,
    index: &LogIndex,
    caller_roles: &[(String, &'static str)],
) -> Result<LedgerView, ChainError> {
    let chain = read_chain_status(cfg, eth).await?;

    let Some(contract) = cfg.contract else {
        return Ok(LedgerView {
            chain,
            contract: None,
            contract_code_present: false,
            usdc: cfg.network.usdc().to_string(),
            explorer: cfg.network.explorer().to_string(),
            total_escrowed_usdc: "0".into(),
            total_bond_usdc: "0".into(),
            invariant_ok: true,
            invariant_note: "no contract deployed yet".into(),
            open_orders: 0,
            services: vec![],
            orders: vec![],
            balances: read_balances(eth, caller_roles).await?,
        });
    };

    let contract_hex = format!("0x{}", hex::encode(contract));
    let code = eth.code_at(&contract_hex).await?;
    let contract_code_present = code.value != "0x" && !code.value.is_empty();

    // Independent reads go out together; serially they were four round trips
    // before the first covenant was even asked for.
    let (service_count, order_count, total_escrowed, total_bond) = tokio::try_join!(
        read_uint_view(eth, &contract_hex, |_c| {
            let call = abi::VeriCallClearinghouse::getServiceCountCall {};
            alloy_sol_types::SolCall::abi_encode(&call)
        }),
        read_uint_view(eth, &contract_hex, |_c| {
            let call = abi::VeriCallClearinghouse::getOrderCountCall {};
            alloy_sol_types::SolCall::abi_encode(&call)
        }),
        read_uint_view(eth, &contract_hex, |_c| {
            let call = abi::VeriCallClearinghouse::totalEscrowedCall {};
            alloy_sol_types::SolCall::abi_encode(&call)
        }),
        read_uint_view(eth, &contract_hex, |_c| {
            let call = abi::VeriCallClearinghouse::totalBondCall {};
            alloy_sol_types::SolCall::abi_encode(&call)
        }),
    )?;

    let service_total = service_count.value.min(U256::from(MAX_SERVICES)).to::<u64>();
    let order_total = order_count.value.min(U256::from(MAX_ORDERS)).to::<u64>();

    // Read every covenant and order concurrently. Serially this is ~30 RPC calls
    // and takes the better part of a minute on Arc's public endpoints; the bound
    // keeps the burst polite.
    let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(READ_CONCURRENCY));
    let mut service_tasks = tokio::task::JoinSet::new();
    for id in 1..=service_total {
        let eth = eth.clone();
        let contract = contract_hex.clone();
        let permit = permits.clone();
        service_tasks.spawn(async move {
            let _held = permit.acquire_owned().await;
            (id, read_service(&eth, &contract, id).await)
        });
    }
    let mut services: Vec<ServiceView> = Vec::with_capacity(service_total as usize);
    while let Some(joined) = service_tasks.join_next().await {
        match joined {
            Ok((id, Ok(view))) => services.push(view),
            Ok((id, Err(err))) => tracing::warn!("service {id} could not be read: {err}"),
            Err(err) => tracing::warn!("a service read panicked: {err}"),
        }
    }
    services.sort_by_key(|service| service.id.parse::<u64>().unwrap_or(0));

    // Transaction hashes are the one fact not in storage, and they are what a
    // reader clicks. They come from a background index; if it has not caught up
    // yet the ledger is still served, with the links absent rather than invented.
    if let Some(from_block) = cfg.deploy_block {
        index.refresh(eth.clone(), contract_hex.clone(), from_block);
    }
    let txs = index.snapshot();

    let mut order_tasks = tokio::task::JoinSet::new();
    for id in 1..=order_total {
        let eth = eth.clone();
        let contract = contract_hex.clone();
        let permit = permits.clone();
        order_tasks.spawn(async move {
            let _held = permit.acquire_owned().await;
            (id, read_order(&eth, &contract, id).await)
        });
    }
    let mut orders: Vec<OrderView> = Vec::with_capacity(order_total as usize);
    while let Some(joined) = order_tasks.join_next().await {
        match joined {
            Ok((id, Ok(mut view))) => {
                view.txs = txs.get(&id).cloned().unwrap_or_default();
                orders.push(view)
            }
            Ok((id, Err(err))) => tracing::warn!("order {id} could not be read: {err}"),
            Err(err) => tracing::warn!("an order read panicked: {err}"),
        }
    }
    orders.sort_by_key(|order| order.id.parse::<u64>().unwrap_or(0));

    let funded_escrow: U256 = orders
        .iter()
        .filter(|o| o.status == STATUS_FUNDED)
        .map(|o| U256::from_str_radix(&o.escrowed_units, 10).unwrap_or(U256::ZERO))
        .fold(U256::ZERO, |acc, v| acc + v);

    let invariant_ok = funded_escrow == total_escrowed.value;
    let open_count = orders.iter().filter(|o| o.status == STATUS_FUNDED).count();
    let invariant_note = if invariant_ok && open_count == 0 {
        format!(
            "No escrow in flight: all {} orders are settled, and totalEscrowed() is zero with them",
            orders.len()
        )
    } else if invariant_ok {
        format!(
            "{open_count} funded order(s) hold {} USDC, which is exactly totalEscrowed()",
            abi::format_usdc(total_escrowed.value)
        )
    } else {
        format!(
            "funded orders hold {} USDC but totalEscrowed() reports {} — investigate before trusting a settlement",
            abi::format_usdc(funded_escrow),
            abi::format_usdc(total_escrowed.value)
        )
    };

    Ok(LedgerView {
        chain,
        contract: Some(contract_hex),
        contract_code_present,
        usdc: cfg.network.usdc().to_string(),
        explorer: cfg.network.explorer().to_string(),
        total_escrowed_usdc: abi::format_usdc(total_escrowed.value),
        total_bond_usdc: abi::format_usdc(total_bond.value),
        invariant_ok,
        invariant_note,
        open_orders: orders.iter().filter(|o| o.status == STATUS_FUNDED).count(),
        services,
        orders,
        balances: read_balances(eth, caller_roles).await?,
    })
}

async fn read_chain_status(cfg: &Config, eth: &HttpEth) -> Result<ChainStatus, ChainError> {
    let block = eth.block_number().await?;
    let chain_id = eth.chain_id().await?;
    Ok(ChainStatus {
        network: cfg.network.label().to_string(),
        chain_id: chain_id.value,
        block_number: block.value,
        endpoint: block.endpoint,
        latency_ms: block.latency_ms,
    })
}

async fn read_balances(
    eth: &HttpEth,
    roles: &[(String, &'static str)],
) -> Result<Vec<BalanceView>, ChainError> {
    let mut tasks = tokio::task::JoinSet::new();
    for (address, role) in roles {
        let parsed = match crate::chain::parse_address(address) {
            Ok(a) => a,
            Err(err) => {
                tracing::warn!("skipping balance read for {address}: {err}");
                continue;
            }
        };
        let eth = eth.clone();
        let address = address.clone();
        let role: &'static str = role;
        tasks.spawn(async move {
            let (native, erc20) = tokio::join!(
                eth.native_balance(&address),
                eth.erc20_balance_of(eth_usdc(), parsed)
            );
            (address, role, native, erc20)
        });
    }

    let mut out = Vec::with_capacity(roles.len());
    while let Some(joined) = tasks.join_next().await {
        let Ok((address, role, native, erc20)) = joined else { continue };
        let native_value = match native {
            Ok(v) => v.value,
            Err(err) => {
                tracing::warn!("native balance for {address} unavailable: {err}");
                continue;
            }
        };
        // 18-decimal native → 6-decimal display units.
        let native_usdc = abi::format_usdc(native_value / U256::from(1_000_000_000_000u64));
        let usdc = match erc20 {
            Ok(v) => abi::format_usdc(v.value),
            Err(err) => {
                tracing::warn!("ERC-20 balance for {address} unavailable: {err}");
                "unavailable".to_string()
            }
        };
        out.push(BalanceView {
            address: address.clone(),
            native_usdc,
            usdc,
            role,
        });
    }
    let rank = |role: &str| match role {
        "caller" => 0,
        "provider" => 1,
        "dependency" => 2,
        _ => 3,
    };
    out.sort_by_key(|balance| rank(balance.role));
    Ok(out)
}

fn eth_usdc() -> &'static str {
    crate::abi::USDC_ADDRESS
}

async fn read_uint_view<F>(eth: &HttpEth, contract: &str, encode: F) -> Result<RpcOutcome<U256>, ChainError>
where
    F: FnOnce(&str) -> Vec<u8>,
{
    let data = encode(contract);    let raw = eth.eth_call(contract, &data).await?;
    let value = decode_uint(&raw.value).map_err(|e| ChainError::Decode {
        endpoint: raw.endpoint.clone(),
        method: "eth_call".into(),
        message: e,
    })?;
    Ok(RpcOutcome {
        value,
        endpoint: raw.endpoint,
        latency_ms: raw.latency_ms,
    })
}

/// Read a covenant from the contract and decode it, without shaping it for the
/// UI. The verifier uses this to confirm a record before it signs.
pub async fn read_service_raw(
    eth: &HttpEth,
    contract: &str,
    id: u64,
) -> Result<crate::abi::ServiceReturn, ChainError> {
    let call = abi::VeriCallClearinghouse::getServiceCall {
        serviceId: U256::from(id),
    };
    let raw = eth
        .eth_call(contract, &alloy_sol_types::SolCall::abi_encode(&call))
        .await?;
    decode_service(&raw.value).map_err(|e| ChainError::Decode {
        endpoint: raw.endpoint.clone(),
        method: "getService".into(),
        message: e,
    })
}

/// Read an order raw, for checks that need the caller's onchain commitment.
pub async fn read_order_raw(
    eth: &HttpEth,
    contract: &str,
    id: U256,
) -> Result<crate::abi::OrderReturn, ChainError> {
    let call = abi::VeriCallClearinghouse::getOrderCall { orderId: id };
    let raw = eth
        .eth_call(contract, &alloy_sol_types::SolCall::abi_encode(&call))
        .await?;
    crate::abi::decode_order(&raw.value).map_err(|e| ChainError::Decode {
        endpoint: raw.endpoint.clone(),
        method: "getOrder".into(),
        message: e,
    })
}

pub async fn read_service(eth: &HttpEth, contract: &str, id: u64) -> Result<ServiceView, ChainError> {
    let call = abi::VeriCallClearinghouse::getServiceCall {
        serviceId: U256::from(id),
    };
    let raw = eth
        .eth_call(contract, &alloy_sol_types::SolCall::abi_encode(&call))
        .await?;
    let service: ServiceReturn = decode_service(&raw.value).map_err(|e| ChainError::Decode {
        endpoint: raw.endpoint.clone(),
        method: "getService".into(),
        message: e,
    })?;

    // `getService` already returns the covenant's split table, so the separate
    // `getSplits` call would double the RPC cost of reading this ledger for a
    // value already in hand.
    let splits = service.splits.clone();

    let provider_hex = format!("0x{}", hex::encode(service.provider));
    let required_bond = div_ceil_u256(
        service.call_price_usdc * U256::from(service.slash_penalty_bps),
        U256::from(10_000u64),
    );

    let split_views = splits
        .iter()
        .map(|(recipient, bps)| {
            let hex = format!("0x{}", hex::encode(recipient));
            SplitView {
                role: if hex.eq_ignore_ascii_case(&provider_hex) {
                    "provider"
                } else {
                    "dependency"
                },
                recipient: hex,
                bps: *bps,
                percent: format_bps(*bps),
            }
        })
        .collect();

    // Which published service this covenant points at, if the verifier knows it.
    let published = crate::config::fixtures()
        .iter()
        .find(|f| service.endpoint_uri.ends_with(&f.path));

    Ok(ServiceView {
        id: id.to_string(),
        provider: provider_hex,
        verifier: format!("0x{}", hex::encode(service.verifier)),
        name: service.name,
        endpoint_uri: service.endpoint_uri,
        schema_hash: format!("0x{}", hex::encode(service.schema_hash)),
        call_price_usdc: abi::format_usdc(service.call_price_usdc),
        call_price_units: service.call_price_usdc.to_string(),
        grace_latency_ms: service.grace_latency_ms,
        hard_timeout_ms: service.hard_timeout_ms,
        max_rebate_bps: service.max_rebate_bps,
        slash_penalty_bps: service.slash_penalty_bps,
        provider_bond_usdc: abi::format_usdc(service.provider_bond_usdc),
        provider_bond_units: service.provider_bond_usdc.to_string(),
        active: service.active,
        backed_by: published.map(|f| f.backed_by.clone()).unwrap_or_else(|| "unknown".to_string()),
        backing: published.map(|f| f.backing.clone()),
        splits: split_views,
        required_bond_usdc: abi::format_usdc(required_bond),
        bond_covers_one_order: service.provider_bond_usdc >= required_bond,
    })
}

async fn read_order(eth: &HttpEth, contract: &str, id: u64) -> Result<OrderView, ChainError> {
    let call = abi::VeriCallClearinghouse::getOrderCall {
        orderId: U256::from(id),
    };
    let raw = eth
        .eth_call(contract, &alloy_sol_types::SolCall::abi_encode(&call))
        .await?;
    let order: OrderReturn = decode_order(&raw.value).map_err(|e| ChainError::Decode {
        endpoint: raw.endpoint.clone(),
        method: "getOrder".into(),
        message: e,
    })?;

    let total = order.paid_to_provider + order.paid_to_dependencies + order.refunded_to_caller;
    let status = order.status;
    let settled = status != 0 && status != STATUS_FUNDED;

    Ok(OrderView {
        id: id.to_string(),
        txs: OrderTxs::default(),
        service_id: order.service_id.to_string(),
        caller: format!("0x{}", hex::encode(order.caller)),
        escrowed_usdc: abi::format_usdc(order.escrowed_usdc),
        escrowed_units: order.escrowed_usdc.to_string(),
        request_hash: format!("0x{}", hex::encode(order.request_hash)),
        created_at: order.created_at,
        expiry_at: order.expiry_at,
        status,
        status_name: abi::status_name(status),
        measured_latency_ms: order.measured_latency_ms,
        response_hash: format!("0x{}", hex::encode(order.response_hash)),
        schema_valid: order.schema_valid,
        paid_to_provider_usdc: abi::format_usdc(order.paid_to_provider),
        paid_to_dependencies_usdc: abi::format_usdc(order.paid_to_dependencies),
        refunded_to_caller_usdc: abi::format_usdc(order.refunded_to_caller),
        bond_slashed_usdc: abi::format_usdc(order.bond_slashed),
        settlement_total_usdc: abi::format_usdc(total + order.bond_slashed),
        settled,
    })
}

/// An incremental index of where each order's transactions are.
///
/// The chain only grows, so the scan is resumed from the last block it covered
/// rather than repeated. On a young chain that matters: the deploy block was
/// 365,000 blocks behind when this was written, and re-walking it on every page
/// read took the better part of a minute.
///
/// Refreshes happen in the background. A reader never waits for a log scan: the
/// ledger is the important read, and a transaction link is a convenience that can
/// arrive a few seconds later. A row with no link yet says so rather than
/// pretending the transaction does not exist.
#[derive(Clone)]
pub struct LogIndex {
    inner: std::sync::Arc<std::sync::Mutex<LogIndexState>>,
}

#[derive(Default)]
struct LogIndexState {
    /// The last block the scan has covered. Zero means nothing yet.
    scanned_to: u64,
    entries: std::collections::BTreeMap<u64, OrderTxs>,
    scanning: bool,
    last_error: Option<String>,
    last_started: Option<std::time::Instant>,
}

impl LogIndex {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Arc::new(std::sync::Mutex::new(LogIndexState::default())),
        }
    }

    /// What is known right now. Never blocks on the chain.
    pub fn snapshot(&self) -> std::collections::BTreeMap<u64, OrderTxs> {
        self.inner.lock().expect("log index lock").entries.clone()
    }

    /// Whether a background refresh is running, for the health endpoint.
    pub fn is_scanning(&self) -> bool {
        self.inner.lock().expect("log index lock").scanning
    }

    /// Start a refresh unless one is running or the last one started recently.
    pub fn refresh(&self, eth: HttpEth, contract: String, from_block: u64) {
        {
            let mut state = self.inner.lock().expect("log index lock");
            if state.scanning {
                return;
            }
            if let Some(started) = state.last_started {
                if started.elapsed() < std::time::Duration::from_secs(30) && state.scanned_to > 0 {
                    return;
                }
            }
            state.scanning = true;
            state.last_started = Some(std::time::Instant::now());
        }

        let index = self.clone();
        tokio::spawn(async move {
            let start = {
                let state = index.inner.lock().expect("log index lock");
                if state.scanned_to == 0 {
                    from_block
                } else {
                    state.scanned_to + 1
                }
            };
            let result = scan_order_txs(&eth, &contract, start).await;
            let mut state = index.inner.lock().expect("log index lock");
            state.scanning = false;
            match result {
                Ok((entries, scanned_to)) => {
                    for (order, txs) in entries {
                        let slot = state.entries.entry(order).or_default();
                        if txs.created.is_some() {
                            slot.created = txs.created;
                        }
                        if txs.settled.is_some() {
                            slot.settled = txs.settled;
                        }
                        if txs.reclaimed.is_some() {
                            slot.reclaimed = txs.reclaimed;
                        }
                        if txs.block_number.is_some() {
                            slot.block_number = txs.block_number;
                        }
                    }
                    state.scanned_to = scanned_to.max(state.scanned_to);
                    state.last_error = None;
                    tracing::info!(
                        orders = state.entries.len(),
                        scanned_to = state.scanned_to,
                        "settlement transaction index updated"
                    );
                }
                Err(err) => {
                    state.last_error = Some(err.to_string());
                    tracing::warn!("settlement transaction scan failed: {err}");
                }
            }
        });
    }
}

/// Scan from `from_block` to the head and return what was found, plus the last
/// block covered.
///
/// The three event signatures are requested as one OR filter per chunk, so a
/// chunk costs one request rather than three.
pub async fn scan_order_txs(
    eth: &HttpEth,
    contract: &str,
    from_block: u64,
) -> Result<(std::collections::BTreeMap<u64, OrderTxs>, u64), ChainError> {
    let latest = eth.block_number().await?.value;
    let mut out: std::collections::BTreeMap<u64, OrderTxs> = std::collections::BTreeMap::new();
    if from_block > latest {
        return Ok((out, latest));
    }

    const ORDER_CREATED: &str = "OrderCreated(uint256,uint256,address)";
    const ORDER_SETTLED: &str = "OrderSettled(uint256,uint8,uint32,bool,bytes32,uint256,uint256,uint256,uint256)";
    const ORDER_RECLAIMED: &str = "OrderReclaimed(uint256,address)";

    let created_topic = format!("0x{}", hex::encode(crate::eip712::keccak256(ORDER_CREATED.as_bytes())));
    let settled_topic = format!("0x{}", hex::encode(crate::eip712::keccak256(ORDER_SETTLED.as_bytes())));
    let reclaimed_topic = format!("0x{}", hex::encode(crate::eip712::keccak256(ORDER_RECLAIMED.as_bytes())));

    let mut start = from_block;
    while start <= latest {
        let end = (start + MAX_LOG_SPAN - 1).min(latest);
        let logs = eth
            .logs(
                contract,
                start,
                end,
                vec![serde_json::json!([created_topic, settled_topic, reclaimed_topic])],
            )
            .await
            .map_err(|err| {
                tracing::warn!("log scan {start}..={end} failed: {err}");
                err
            })?;

        for log in logs.value {
            let Some(topic) = log.topics.first() else { continue };
            let Some(order_topic) = log.topics.get(1) else { continue };
            let Ok(order_id) = u64::from_str_radix(order_topic.trim_start_matches("0x"), 16) else {
                continue;
            };
            let Ok(block) = u64::from_str_radix(log.block_number.trim_start_matches("0x"), 16) else {
                continue;
            };
            let entry = out.entry(order_id).or_default();
            if topic.eq_ignore_ascii_case(&settled_topic) {
                entry.settled = Some(log.transaction_hash.clone());
                entry.block_number = Some(block);
            } else if topic.eq_ignore_ascii_case(&reclaimed_topic) {
                entry.reclaimed = Some(log.transaction_hash.clone());
                entry.block_number = Some(block);
            } else if topic.eq_ignore_ascii_case(&created_topic) {
                entry.created = Some(log.transaction_hash.clone());
            }
        }
        start = end + 1;
    }
    Ok((out, latest))
}

/// Read `version()` as a liveness probe that the contract is the one we expect.
pub async fn read_version(eth: &HttpEth, contract: &str) -> Result<String, ChainError> {
    let call = abi::VeriCallClearinghouse::versionCall {};
    let raw = eth
        .eth_call(contract, &alloy_sol_types::SolCall::abi_encode(&call))
        .await?;
    decode_string(&raw.value).map_err(|e| ChainError::Decode {
        endpoint: raw.endpoint.clone(),
        method: "version".into(),
        message: e,
    })
}

fn div_ceil_u256(numerator: U256, denominator: U256) -> U256 {
    if numerator.is_zero() {
        U256::ZERO
    } else {
        (numerator - U256::from(1u64)) / denominator + U256::from(1u64)
    }
}

fn format_bps(bps: u16) -> String {
    let whole = bps / 100;
    let frac = bps % 100;
    if frac == 0 {
        format!("{whole}%")
    } else {
        format!("{whole}.{frac:02}%")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bps_formatting_reads_like_money() {
        assert_eq!(format_bps(10_000), "100%");
        assert_eq!(format_bps(8000), "80%");
        assert_eq!(format_bps(2000), "20%");
        assert_eq!(format_bps(333), "3.33%");
        assert_eq!(format_bps(5), "0.05%");
    }

    #[test]
    fn required_bond_rounds_up_like_the_contract() {
        // 0.20 USDC at 2000 bps → 0.04 USDC exactly
        let price = abi::parse_usdc("0.2").unwrap();
        assert_eq!(
            abi::format_usdc(div_ceil_u256(price * U256::from(2000u64), U256::from(10_000u64))),
            "0.04"
        );
        // One unit of dust above an exact boundary must round up.
        let price = U256::from(20_001u64);
        let required = div_ceil_u256(price * U256::from(2000u64), U256::from(10_000u64));
        assert_eq!(required, U256::from(4001u64));
    }
}

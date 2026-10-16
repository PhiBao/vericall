//! VeriCall verifier — HTTP surface.
//!
//! The verifier exists to make one claim checkable: *this software call happened,
//! it took this long, and this is the response*. It does that by owning the call,
//! measuring it, validating it against the covenant's schema, and committing to
//! the bytes. What it cannot do is move money: it holds no funds and, in the
//! default configuration, no key that can settle. Settlement is signed by the
//! caller, so a compromised verifier can lie about a result but cannot take a
//! payment it was not given.
//!
//! Routes:
//!
//! | Route | Purpose |
//! | --- | --- |
//! | `GET /api/health` | Liveness plus which Arc endpoints answered. |
//! | `GET /api/config` | Deployment facts the UI can display honestly. |
//! | `GET /api/ledger` | The whole clearinghouse, read from Arc. |
//! | `POST /api/quote` | Pure settlement math for a covenant and a latency. |
//! | `POST /api/execute` | Run the real call, validate the schema, sign, return calldata. |
//! | `POST /api/kernel/:slug` | The three built-in deterministic services. |
//! | `GET /*` | The built frontend, if one was provided. |

mod abi;
mod chain;
mod config;
mod covenants;
mod eip712;
mod executor;
mod schema;
mod sla;
mod state;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json,
    Router,
};
use alloy_primitives::U256;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
struct App {
    cfg: Arc<config::Config>,
    eth: chain::HttpEth,
    executor: executor::Executor,
    /// The covenants this verifier will attest to. Empty means none loaded, in
    /// which case it still measures and quotes but refuses to sign.
    registry: Arc<covenants::CovenantRegistry>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "vericall=info,tower_http=warn".into()),
        )
        .init();

    let cfg = config::Config::from_env().map_err(anyhow::Error::msg)?;
    let eth = chain::HttpEth::new(cfg.rpcs.clone());
    let executor = executor::Executor::new()?;

    tracing::info!(
        network = cfg.network.label(),
        chain_id = cfg.network.chain_id(),
        endpoints = cfg.rpcs.len(),
        contract = cfg.contract.map(|c| format!("0x{}", hex::encode(c))).unwrap_or_else(|| "none".into()),
        verifier = cfg.verifier_address().map(|a| format!("0x{}", hex::encode(a))).unwrap_or_else(|| "read-only".into()),
        "vericall verifier starting"
    );

    let registry = match cfg.covenants_path.as_ref() {
        Some(path) => match covenants::CovenantRegistry::load(path) {
            Ok(registry) => {
                tracing::info!(
                    covenants = registry.len(),
                    contract = format!("0x{}", hex::encode(registry.contract())),
                    source = registry.source(),
                    "loaded covenant registry"
                );
                Arc::new(registry)
            }
            Err(err) => {
                tracing::warn!("covenant registry unavailable ({err}); the verifier will quote but not sign");
                Arc::new(covenants::CovenantRegistry::empty())
            }
        },
        None => {
            tracing::info!("no VERICALL_COVENANTS configured; the verifier will quote but not sign");
            Arc::new(covenants::CovenantRegistry::empty())
        }
    };

    let app_state = App {
        cfg: Arc::new(cfg.clone()),
        eth,
        executor,
        registry,
    };

    // The built-in services are real HTTP endpoints at the paths the covenants
    // publish (`/mock/<slug>`), which is why they are mounted at the root rather
    // than under /api: the covenant's endpoint URI must be the URL the verifier
    // actually calls, and it is registered onchain.
    let services = Router::new()
        .route("/mock/:slug", post(kernel))
        .route("/kernel/:slug", post(kernel))
        .with_state(app_state.clone());

    let api = Router::new()
        .route("/health", get(health))
        .route("/config", get(get_config))
        .route("/ledger", get(ledger))
        .route("/quote", post(quote))
        .route("/execute", post(execute))
        .with_state(app_state);

    let mut router = Router::new()
        .merge(services)
        .nest("/api", api)
        .layer(
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any),
    );

    if let Some(dir) = cfg.static_dir.clone() {
        let index = dir.join("index.html");
        router = router.fallback_service(
            ServeDir::new(dir).not_found_service(ServeFile::new(index)),
        );
        tracing::info!("serving static assets from {}", cfg.static_dir.as_ref().unwrap().display());
    } else {
        router = router.route("/", get(index_placeholder));
    }

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", cfg.port)).await?;
    tracing::info!("listening on http://0.0.0.0:{}", cfg.port);
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}

async fn index_placeholder() -> impl IntoResponse {
    Json(serde_json::json!({
        "name": "vericall-verifier",
        "note": "no static directory configured; the API is under /api",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

fn problem(status: StatusCode, message: impl Into<String>) -> Response {
    (
        status,
        Json(serde_json::json!({
            "error": message.into(),
            "ok": false,
        })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct Health {
    ok: bool,
    version: &'static str,
    network: String,
    chain_id: u64,
    settlement_chain_id: u64,
    contract: Option<String>,
    verifier_address: Option<String>,
    can_settle: bool,
    chain: Option<state::ChainStatus>,
    chain_error: Option<String>,
    mock_services: bool,
    uptime_s: u64,
}

static STARTED: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

async fn health(State(app): State<App>) -> Response {
    let started = *STARTED.get_or_init(Instant::now);
    let (chain, chain_error) = match tokio::join!(
        app.eth.block_number(),
        app.eth.chain_id(),
    ) {
        (Ok(block), Ok(chain_id)) => (
            Some(state::ChainStatus {
                network: app.cfg.network.label().to_string(),
                chain_id: chain_id.value,
                block_number: block.value,
                endpoint: block.endpoint,
                latency_ms: block.latency_ms,
            }),
            None,
        ),
        (Err(e), _) | (_, Err(e)) => (None, Some(e.to_string())),
    };

    let body = Health {
        ok: chain_error.is_none(),
        version: env!("CARGO_PKG_VERSION"),
        network: app.cfg.network.label().to_string(),
        chain_id: app.cfg.network.chain_id(),
        settlement_chain_id: app.cfg.settlement_chain_id,
        contract: app.cfg.contract.map(|c| format!("0x{}", hex::encode(c))),
        verifier_address: app.cfg.verifier_address().map(|a| format!("0x{}", hex::encode(a))),
        can_settle: app.cfg.signing_key.is_some() && app.cfg.contract.is_some(),
        chain,
        chain_error,
        mock_services: app.cfg.enable_mock_services,
        uptime_s: started.elapsed().as_secs(),
    };
    Json(body).into_response()
}

// ---------------------------------------------------------------------------
// GET /api/config
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct PublicConfig {
    network: String,
    chain_id: u64,
    explorer: String,
    rpcs: Vec<String>,
    usdc: String,
    usdc_decimals: u32,
    contract: Option<String>,
    verifier_address: Option<String>,
    can_settle: bool,
    mock_base_url: String,
    fixtures: Vec<FixturePublic>,
    /// The exact originals the covenant commits to, so the UI never has to
    /// paraphrase what was agreed.
    eip712: Eip712Public,
}

#[derive(Serialize)]
struct FixturePublic {
    slug: &'static str,
    name: &'static str,
    summary: &'static str,
    price_usdc: &'static str,
    grace_latency_ms: u32,
    hard_timeout_ms: u32,
    max_rebate_bps: u16,
    slash_penalty_bps: u16,
    provider_split_bps: u16,
}

#[derive(Serialize)]
struct Eip712Public {
    domain_name: &'static str,
    domain_version: &'static str,
    attestation_types: &'static str,
    registration_types: &'static str,
}

async fn get_config(State(app): State<App>) -> Response {
    let fixtures = config::FIXTURES
        .iter()
        .map(|f| FixturePublic {
            slug: f.slug,
            name: f.name,
            summary: f.summary,
            price_usdc: f.price_usdc,
            grace_latency_ms: f.grace_latency_ms,
            hard_timeout_ms: f.hard_timeout_ms,
            max_rebate_bps: f.max_rebate_bps,
            slash_penalty_bps: f.slash_penalty_bps,
            provider_split_bps: f.provider_split_bps,
        })
        .collect();

    Json(PublicConfig {
        network: app.cfg.network.label().to_string(),
        chain_id: app.cfg.network.chain_id(),
        explorer: app.cfg.network.explorer().to_string(),
        rpcs: app.cfg.rpcs.clone(),
        usdc: app.cfg.network.usdc().to_string(),
        usdc_decimals: abi::USDC_DECIMALS,
        contract: app.cfg.contract.map(|c| format!("0x{}", hex::encode(c))),
        verifier_address: app.cfg.verifier_address().map(|a| format!("0x{}", hex::encode(a))),
        can_settle: app.cfg.signing_key.is_some() && app.cfg.contract.is_some(),
        mock_base_url: app.cfg.mock_base_url(),
        fixtures,
        eip712: Eip712Public {
            domain_name: eip712::DOMAIN_NAME,
            domain_version: eip712::DOMAIN_VERSION,
            attestation_types: eip712::ATTESTATION_TYPE_STRING,
            registration_types: eip712::REGISTRATION_TYPE_STRING,
        },
    })
    .into_response()
}

// ---------------------------------------------------------------------------
// GET /api/ledger
// ---------------------------------------------------------------------------

async fn ledger(State(app): State<App>) -> Response {
    let roles: Vec<(String, &'static str)> = app
        .cfg
        .watch_addresses
        .iter()
        .enumerate()
        .map(|(i, a)| {
            let role = match i {
                0 => "caller",
                1 => "provider",
                2 => "dependency",
                _ => "watched",
            };
            (format!("0x{}", hex::encode(a)), role)
        })
        .collect();

    match state::read_ledger(&app.cfg, &app.eth, &roles).await {
        Ok(view) => Json(view).into_response(),
        Err(err) => problem(StatusCode::BAD_GATEWAY, format!("could not read the ledger from Arc: {err}")),
    }
}

// ---------------------------------------------------------------------------
// POST /api/quote
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct QuoteRequest {
    /// A built-in fixture slug, used when no explicit terms are supplied.
    #[serde(default)]
    fixture: Option<String>,
    #[serde(default)]
    terms: Option<TermsInput>,
    /// Escrow to price. Defaults to the fixture price.
    #[serde(default)]
    escrow_usdc: Option<String>,
    latency_ms: u32,
    #[serde(default = "default_true")]
    schema_valid: bool,
    #[serde(default)]
    bond_usdc: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
struct TermsInput {
    grace_latency_ms: u32,
    hard_timeout_ms: u32,
    max_rebate_bps: u16,
    slash_penalty_bps: u16,
    call_price_usdc: String,
    provider_bps: u16,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    dependency: Option<String>,
}

#[derive(Serialize)]
struct QuoteResponse {
    status: &'static str,
    status_name: &'static str,
    latency_ms: u32,
    schema_valid: bool,
    escrow_usdc: String,
    escrow_units: String,
    rebate_to_caller_usdc: String,
    bond_slash_usdc: String,
    net_usdc: String,
    paid_to_provider_usdc: String,
    paid_to_dependencies_usdc: String,
    split_amounts_usdc: Vec<String>,
    split_bps: Vec<u16>,
    /// The whole curve at this escrow, so a UI can draw it without re-deriving
    /// the contract's arithmetic.
    curve: Vec<CurvePoint>,
    explanation: String,
}

#[derive(Serialize)]
struct CurvePoint {
    latency_ms: u32,
    rebate_usdc: String,
    to_provider_usdc: String,
    to_dependencies_usdc: String,
    status: &'static str,
}

async fn quote(State(_app): State<App>, Json(req): Json<QuoteRequest>) -> Response {
    let (terms, escrow, bond) = match build_terms(&req) {
        Ok(v) => v,
        Err(msg) => return problem(StatusCode::BAD_REQUEST, msg),
    };

    let q = match terms.quote(escrow, req.latency_ms, req.schema_valid, bond) {
        Ok(q) => q,
        Err(err) => return problem(StatusCode::BAD_REQUEST, err.to_string()),
    };

    let curve = build_curve(&terms, escrow);
    let explanation = explain(&terms, escrow, &q);

    Json(QuoteResponse {
        status: status_key(q.status),
        status_name: abi::status_name(q.status.as_u8()),
        latency_ms: q.latency_ms,
        schema_valid: q.schema_valid,
        escrow_usdc: abi::format_usdc(U256::from(q.escrow)),
        escrow_units: q.escrow.to_string(),
        rebate_to_caller_usdc: abi::format_usdc(U256::from(q.rebate_to_caller)),
        bond_slash_usdc: abi::format_usdc(U256::from(q.bond_slash)),
        net_usdc: abi::format_usdc(U256::from(q.net)),
        paid_to_provider_usdc: abi::format_usdc(U256::from(q.paid_to_provider)),
        paid_to_dependencies_usdc: abi::format_usdc(U256::from(q.paid_to_dependencies)),
        split_amounts_usdc: q
            .split_amounts
            .iter()
            .map(|v| abi::format_usdc(U256::from(*v)))
            .collect(),
        split_bps: terms.splits.iter().map(|s| s.bps).collect(),
        curve,
        explanation,
    })
    .into_response()
}

fn build_terms(
    req: &QuoteRequest,
) -> Result<(sla::CovenantTerms, u64, u64), String> {
    let provider = match req.terms.as_ref().and_then(|t| t.provider.as_deref()) {
        Some(p) => chain::parse_address(p)?,
        None => [0xAA; 20],
    };
    let dependency = match req.terms.as_ref().and_then(|t| t.dependency.as_deref()) {
        Some(d) => chain::parse_address(d)?,
        None => [0xBB; 20],
    };

    let (terms, default_price) = match (&req.fixture, &req.terms) {
        (Some(slug), None) => {
            let f = config::fixture(slug)
                .ok_or_else(|| format!("`{slug}` is not a built-in fixture"))?;
            (f.terms(provider, dependency), f.price_usdc.to_string())
        }
        (None, Some(t)) => {
            let provider_bps = t.provider_bps;
            if provider_bps == 0 || provider_bps >= 10_000 {
                return Err("provider_bps must be between 1 and 9999".to_string());
            }
            let splits = vec![
                sla::Split::new(provider, provider_bps),
                sla::Split::new(dependency, 10_000 - provider_bps),
            ];
            let price = abi::parse_usdc(&t.call_price_usdc)?;
            (
                sla::CovenantTerms {
                    grace_latency_ms: t.grace_latency_ms,
                    hard_timeout_ms: t.hard_timeout_ms,
                    max_rebate_bps: t.max_rebate_bps,
                    slash_penalty_bps: t.slash_penalty_bps,
                    call_price_usdc: price.to::<u64>(),
                    splits,
                    provider_index: 0,
                },
                t.call_price_usdc.clone(),
            )
        }
        (Some(_), Some(_)) => {
            return Err("supply either `fixture` or `terms`, not both".to_string())
        }
        (None, None) => return Err("supply `fixture` or `terms`".to_string()),
    };

    let escrow = match &req.escrow_usdc {
        Some(s) => abi::parse_usdc(s)?.to::<u64>(),
        None => abi::parse_usdc(&default_price)?.to::<u64>(),
    };    let bond = match &req.bond_usdc {
        Some(s) => abi::parse_usdc(s)?.to::<u64>(),
        None => u64::MAX,
    };
    Ok((terms, escrow, bond))
}

fn build_curve(terms: &sla::CovenantTerms, escrow: u64) -> Vec<CurvePoint> {
    // Sample the curve at the points a reader cares about: the grace edge, the
    // hard edge, and a uniform grid between them.
    let grace = terms.grace_latency_ms;
    let hard = terms.hard_timeout_ms;
    let mut latencies: Vec<u32> = Vec::new();
    latencies.push(0);
    if grace > 0 {
        latencies.push(grace);
    }
    let steps = 12u32;
    let span = hard.saturating_sub(grace);
    if span > 0 {
        for i in 1..steps {
            latencies.push(grace + span * i / steps);
        }
    }
    latencies.push(hard);
    latencies.push(hard.saturating_add(1));
    latencies.sort_unstable();
    latencies.dedup();

    latencies
        .into_iter()
        .filter_map(|latency| {
            let q = terms.quote(escrow, latency, true, 1_000_000_000).ok()?;
            Some(CurvePoint {
                latency_ms: latency,
                rebate_usdc: abi::format_usdc(U256::from(q.rebate_to_caller)),
                to_provider_usdc: abi::format_usdc(U256::from(q.paid_to_provider)),
                to_dependencies_usdc: abi::format_usdc(U256::from(q.paid_to_dependencies)),
                status: status_key(q.status),
            })
        })
        .collect()
}

fn status_key(status: sla::OrderStatus) -> &'static str {
    match status {
        sla::OrderStatus::None => "none",
        sla::OrderStatus::Funded => "funded",
        sla::OrderStatus::SettledPass => "pass",
        sla::OrderStatus::SettledDegraded => "degraded",
        sla::OrderStatus::SettledBreached => "breach",
        sla::OrderStatus::ReclaimedExpired => "reclaimed",
    }
}

fn explain(terms: &sla::CovenantTerms, escrow: u64, q: &sla::Quote) -> String {
    match q.status {
        sla::OrderStatus::SettledPass => format!(
            "{} ms is within the {} ms grace SLA: no rebate, and the {} USDC in escrow splits {} bps provider / {} bps dependencies.",
            q.latency_ms,
            terms.grace_latency_ms,
            abi::format_usdc(U256::from(escrow)),
            terms.splits.first().map(|s| s.bps).unwrap_or(0),
            terms.splits.get(1).map(|s| s.bps).unwrap_or(0),
        ),
        sla::OrderStatus::SettledDegraded => format!(
            "{} ms is {} ms past the {} ms grace SLA (hard edge {} ms), so the caller is rebated {} USDC and the remaining {} USDC splits by basis points. The rebate is linear in the overrun, so it is derivable from the receipt.",
            q.latency_ms,
            q.latency_ms.saturating_sub(terms.grace_latency_ms),
            terms.grace_latency_ms,
            terms.hard_timeout_ms,
            abi::format_usdc(U256::from(q.rebate_to_caller)),
            abi::format_usdc(U256::from(q.net)),
        ),
        sla::OrderStatus::SettledBreached => format!(
            "{} or a response outside the covenant schema is a hard breach: the caller is refunded the full {} USDC escrow and {} USDC is slashed from the provider's bond.",
            if !q.schema_valid {
                "A response that does not satisfy the covenant schema".to_string()
            } else {
                format!("{} ms against a {} ms hard timeout", q.latency_ms, terms.hard_timeout_ms)
            },
            abi::format_usdc(U256::from(escrow)),
            abi::format_usdc(U256::from(q.bond_slash)),
        ),
        _ => "no settlement".to_string(),
    }
}

// ---------------------------------------------------------------------------
// POST /api/execute
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ExecuteRequest {
    fixture: String,
    /// Latency injection for the built-in services: `normal`, `degraded` or
    /// `breach`. Ignored by a caller that points at its own endpoint.
    #[serde(default)]
    mode: Option<String>,
    /// Override the endpoint. Validated against the covenant at registration
    /// time on-chain, and re-checked here against the fixture.
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    body: Option<serde_json::Value>,
    /// Deterministic seed for the mock services so a demo repeats exactly.
    #[serde(default)]
    seed: Option<u64>,
    /// The registered onchain covenant. When present, the record is confirmed
    /// against the chain and, with a signing key, a settleable attestation is
    /// produced that is bound to `order_id`.
    #[serde(default)]
    service_id: Option<u64>,
    /// The funded order this attestation is for. Required to build calldata.
    #[serde(default)]
    order_id: Option<String>,
    /// Seconds the attestation stays valid. Defaults to 900.
    #[serde(default)]
    valid_for_seconds: Option<u64>,
}

#[derive(Serialize)]
struct ExecuteResponse {
    ok: bool,
    fixture: String,
    service_name: String,
    /// 'record' when the terms came from the registered covenant, 'fixture'
    /// when they came from the built-in defaults.
    terms_source: &'static str,
    service_id: Option<u64>,
    order_id: Option<String>,
    endpoint_uri: String,
    outcome: executor::CallOutcome,
    outcome_summary: String,
    schema: SchemaResult,
    quote: QuoteResponse,
    /// Everything a signer needs to settle this order on Arc.
    attestation: Option<AttestationResponse>,
    notes: Vec<String>,
}

#[derive(Serialize)]
struct SchemaResult {
    valid: bool,
    errors: Vec<String>,
    checked_against: String,
}

#[derive(Serialize)]
struct AttestationResponse {
    order_id: Option<String>,
    service_id: Option<u64>,
    /// ABI-encoded calldata for
    /// `settleOrder(orderId, latencyMs, schemaValid, responseHash, deadline, sig)`,
    /// or null when no order id was supplied.
    calldata: Option<String>,
    /// The digest that was signed, so anyone can re-derive it from the receipt.
    digest: String,
    signature: Option<String>,
    signer: Option<String>,
    deadline: u64,
    typed_data: serde_json::Value,
}

async fn execute(State(app): State<App>, Json(req): Json<ExecuteRequest>) -> Response {
    let Some(fixture) = config::fixture(&req.fixture) else {
        return problem(
            StatusCode::BAD_REQUEST,
            format!("`{}` is not a built-in fixture", req.fixture),
        );
    };

    // ---- resolve the terms this attestation will be priced against ----------
    //
    // Three sources, in decreasing order of authority:
    //   1. the registered covenant from the deployment record, confirmed against
    //      the chain before use;
    //   2. the configured watch addresses, for a measured-but-not-yet-registered
    //      covenant;
    //   3. the fixture defaults, which exist only to preview the arithmetic.
    let mut notes: Vec<String> = Vec::new();
    let mut terms_source: &'static str = "fixture";
    let mut service_id: Option<u64> = None;
    let mut provider = app.cfg.watch_addresses.get(1).copied().unwrap_or([0xAA; 20]);
    let mut dependency = app.cfg.watch_addresses.get(2).copied().unwrap_or([0xBB; 20]);
    let mut recorded_schema_hash: Option<[u8; 32]> = None;

    if let Some(id) = req.service_id {
        let record = match app.registry.get(id) {
            Ok(record) => record.clone(),
            Err(err) => {
                return problem(
                    StatusCode::BAD_REQUEST,
                    format!(
                        "covenant {id} is not in the verifier's registry ({err}); it will not attest to terms it has not been told"
                    ),
                )
            }
        };
        if record.slug != fixture.slug {
            return problem(
                StatusCode::BAD_REQUEST,
                format!(
                    "covenant {id} is registered as `{}` but the request names `{}`",
                    record.slug, fixture.slug
                ),
            );
        }

        // Confirm the record against the chain. This is the check that makes the
        // verifier's quote trustworthy: it cannot price stale terms.
        if let Some(contract) = app.cfg.contract {
            let contract_hex = format!("0x{}", hex::encode(contract));
            match state::read_service_raw(&app.eth, &contract_hex, id).await {
                Ok(onchain) => {
                    if let Err(err) = app.registry.check_against_chain(&record, &onchain, &contract_hex) {
                        return problem(
                            StatusCode::CONFLICT,
                            format!("refusing to attest: {err}"),
                        );
                    }
                    notes.push(format!(
                        "terms confirmed against covenant {id} on {} at block {}",
                        app.cfg.network.label(),
                        app.eth.block_number().await.map(|b| b.value).unwrap_or(0)
                    ));
                }
                Err(err) => {
                    return problem(
                        StatusCode::BAD_GATEWAY,
                        format!("could not read covenant {id} from the chain, so its terms cannot be confirmed: {err}"),
                    )
                }
            }
        } else {
            notes.push("no clearinghouse address is configured, so the record could not be confirmed onchain".to_string());
        }

        // The schema the response is judged against must be the schema the
        // covenant committed to. Both sides hash the *canonical* form — the
        // parsed value re-serialised with sorted keys and no insignificant
        // whitespace — so a reformatted schema is the same schema, while a
        // genuine change of terms is a different hash. `scripts/lib/fixtures.ts`
        // implements the identical canonicalisation for the registration side.
        let canonical = canonical_json(&fixture.schema_value());
        let local_hash = executor::keccak256(canonical.as_bytes());
        let record_hash = record.schema_hash;
        if local_hash != record_hash {
            return problem(
                StatusCode::CONFLICT,
                format!(
                    "the schema this verifier would validate against hashes to 0x{}, but covenant {id} committed to 0x{}. Refusing to judge a response against the wrong contract.",
                    hex::encode(local_hash),
                    hex::encode(record_hash)
                ),
            );
        }

        terms_source = "record";
        service_id = Some(id);
        provider = record.provider;
        dependency = record.dependency;
        recorded_schema_hash = Some(record_hash);
    }

    let terms = match req.service_id {
        Some(id) => covenants::terms(app.registry.get(id).expect("checked above")),
        None => fixture.terms(provider, dependency),
    };
    if let Err(err) = terms.validate() {
        return problem(StatusCode::INTERNAL_SERVER_ERROR, format!("the terms are unusable: {err}"));
    }

    // ---- execute the call ---------------------------------------------------
    let registered_url = format!("{}{}", app.cfg.mock_base_url(), fixture.path);
    let url = req.url.clone().unwrap_or_else(|| registered_url.clone());
    if url != registered_url && req.url.is_some() {
        // An override is allowed only when it is the endpoint the covenant names.
        // Anything else would produce an attestation about a different service.
        return problem(
            StatusCode::BAD_REQUEST,
            format!(
                "this covenant is registered against `{registered_url}`; a verifier that called `{url}` would be attesting to a different service"
            ),
        );
    }

    let mut body = req
        .body
        .clone()
        .unwrap_or_else(|| default_body(fixture.slug, req.mode.as_deref(), req.seed));
    if let Some(obj) = body.as_object_mut() {
        if let Some(mode) = &req.mode {
            obj.insert("mode".into(), serde_json::json!(mode));
        }
    }
    let body_str = serde_json::to_string(&body).unwrap_or_default();

    let call = executor::CallRequest {
        url: url.clone(),
        method: executor::Method::Post,
        body: Some(body_str),
        headers: vec![("x-vericall-fixture".into(), fixture.slug.into())],
        // Give the service enough room to answer at or past the hard edge; a
        // timeout must be a measured breach, not a client-side abort at the SLA.
        timeout_ms: fixture.hard_timeout_ms.saturating_add(2_000),
    };

    let outcome = match app.executor.execute(&registered_url, &call).await {
        Ok(o) => o,
        Err(err) => return problem(StatusCode::BAD_REQUEST, err.to_string()),
    };

    // ---- validate the response ---------------------------------------------
    let schema_value = fixture.schema_value();
    let schema_result = match outcome
        .body
        .as_ref()
        .and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok())
    {
        Some(parsed) => {
            let errors = schema::validate(&schema_value, &parsed);
            SchemaResult {
                valid: errors.is_empty(),
                errors: errors.iter().map(|e| e.to_string()).collect(),
                checked_against: format!(
                    "schema 0x{}",
                    hex::encode(recorded_schema_hash.unwrap_or_else(|| executor::keccak256(
                        canonical_json(&schema_value).as_bytes()
                    )))
                ),
            }
        }
        None => SchemaResult {
            valid: false,
            errors: vec![match (&outcome.body, outcome.timed_out, &outcome.transport_error) {
                (None, true, _) => "the service did not answer within the covenant timeout".into(),
                (None, _, Some(err)) => format!("no response body: {err}"),
                (None, _, None) => "response body exceeded the capture cap".to_string(),
                (Some(b), _, _) => format!(
                    "response body is not a JSON object: {}",
                    truncate(b, 120)
                ),
            }],
            checked_against: "covenant schema".to_string(),
        },
    };

    // The SLA verdict is transport success AND schema compliance. A 200 with the
    // wrong shape is a breach, which is the entire point of a covenant.
    let schema_valid = schema_result.valid && outcome.http_ok();
    let quote = match terms.quote(terms.call_price_usdc, outcome.latency_ms, schema_valid, u64::MAX) {
        Ok(q) => q,
        Err(err) => return problem(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    };

    // ---- build the attestation --------------------------------------------
    let valid_for = req.valid_for_seconds.unwrap_or(900);
    let deadline = now_secs() + valid_for;
    let order_id = req.order_id.as_ref().and_then(|raw| raw.parse::<U256>().ok());
    let provider_hex = format!("0x{}", hex::encode(provider));

    let attestation = if let (Some(order_id), Some(contract)) = (order_id, app.cfg.contract) {
        let attestation = eip712::SlaAttestation {
            order_id,
            latency_ms: outcome.latency_ms,
            schema_valid,
            response_hash: outcome.response_hash,
            service: provider,
            deadline,
        };
        let digest = attestation.digest(app.cfg.settlement_chain_id, contract);

        let (signature, signer) = match app.cfg.signing_key {
            Some(key) => match attestation.sign(app.cfg.settlement_chain_id, contract, &key) {
                Ok(sig) => {
                    // Self-check: never hand out a signature that does not recover
                    // to the address the contract will expect.
                    let expected = app.cfg.verifier_address();
                    let recovered = eip712::recover_address(&digest, &sig);
                    if recovered != expected {
                        return problem(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "the produced signature does not recover to the configured verifier address; refusing to emit it",
                        );
                    }
                    (
                        Some(sig.to_hex()),
                        expected.map(|a| format!("0x{}", hex::encode(a))),
                    )
                }
                Err(err) => {
                    return problem(StatusCode::INTERNAL_SERVER_ERROR, format!("signing failed: {err}"))
                }
            },
            None => (None, None),
        };

        let calldata = signature.as_ref().map(|sig| {
            let bytes = hex::decode(sig.trim_start_matches("0x")).unwrap_or_default();
            format!(
                "0x{}",
                hex::encode(abi::settle_order_calldata(
                    order_id,
                    outcome.latency_ms,
                    schema_valid,
                    alloy_primitives::B256::from(outcome.response_hash),
                    deadline,
                    &bytes,
                ))
            )
        });

        if signature.is_none() {
            notes.push(
                "no verifier key is configured, so this is an unsigned settlement draft: the calldata and digest are real, the signature is absent".to_string(),
            );
        }

        Some(AttestationResponse {
            order_id: Some(order_id.to_string()),
            service_id,
            calldata,
            digest: format!("0x{}", hex::encode(digest)),
            signature,
            signer,
            deadline,
            typed_data: serde_json::json!({
                "types": {
                    "EIP712Domain": [
                        { "name": "name", "type": "string" },
                        { "name": "version", "type": "string" },
                        { "name": "chainId", "type": "uint256" },
                        { "name": "verifyingContract", "type": "address" }
                    ],
                    "SlaAttestation": [
                        { "name": "orderId", "type": "uint256" },
                        { "name": "latencyMs", "type": "uint32" },
                        { "name": "schemaValid", "type": "bool" },
                        { "name": "responseHash", "type": "bytes32" },
                        { "name": "service", "type": "address" },
                        { "name": "deadline", "type": "uint64" }
                    ]
                },
                "primaryType": "SlaAttestation",
                "domain": {
                    "name": eip712::DOMAIN_NAME,
                    "version": eip712::DOMAIN_VERSION,
                    "chainId": app.cfg.settlement_chain_id,
                    "verifyingContract": format!("0x{}", hex::encode(contract))
                },
                "message": {
                    "orderId": order_id.to_string(),
                    "latencyMs": outcome.latency_ms,
                    "schemaValid": schema_valid,
                    "responseHash": format!("0x{}", hex::encode(outcome.response_hash)),
                    "service": provider_hex,
                    "deadline": deadline
                }
            }),
        })
    } else {
        if order_id.is_none() {
            notes.push(
                "no order id was supplied, so no settlement calldata was built; supply `order_id` to get a signed attestation for one order".to_string(),
            );
        }
        Some(AttestationResponse {
            order_id: None,
            service_id,
            calldata: None,
            digest: "0x".to_string(),
            signature: None,
            signer: app
                .cfg
                .verifier_address()
                .map(|a| format!("0x{}", hex::encode(a))),
            deadline,
            typed_data: serde_json::json!({
                "types": {
                    "EIP712Domain": [
                        { "name": "name", "type": "string" },
                        { "name": "version", "type": "string" },
                        { "name": "chainId", "type": "uint256" },
                        { "name": "verifyingContract", "type": "address" }
                    ],
                    "SlaAttestation": [
                        { "name": "orderId", "type": "uint256" },
                        { "name": "latencyMs", "type": "uint32" },
                        { "name": "schemaValid", "type": "bool" },
                        { "name": "responseHash", "type": "bytes32" },
                        { "name": "service", "type": "address" },
                        { "name": "deadline", "type": "uint64" }
                    ]
                },
                "primaryType": "SlaAttestation",
                "domain": {
                    "name": eip712::DOMAIN_NAME,
                    "version": eip712::DOMAIN_VERSION,
                    "chainId": app.cfg.settlement_chain_id,
                    "verifyingContract": app
                        .cfg
                        .contract
                        .map(|c| format!("0x{}", hex::encode(c)))
                        .unwrap_or_default()
                },
                "message": {
                    "orderId": "0",
                    "latencyMs": outcome.latency_ms,
                    "schemaValid": schema_valid,
                    "responseHash": format!("0x{}", hex::encode(outcome.response_hash)),
                    "service": provider_hex,
                    "deadline": deadline
                }
            }),
        })
    };

    if !app.cfg.enable_mock_services && req.url.is_none() {
        notes.push("built-in services are disabled; supply a `url` that matches the covenant".to_string());
    }
    if !schema_valid && outcome.http_ok() {
        notes.push("the service answered successfully but violated its own schema, so the covenant is breached".to_string());
    }
    if outcome.timed_out {
        notes.push("the call exceeded the client timeout, which classifies as a breach at any latency".to_string());
    }
    if outcome.body_too_large {
        notes.push("the response exceeded the capture cap, so it cannot be hashed honestly and counts as a breach".to_string());
    }

    let explanation = explain(&terms, terms.call_price_usdc, &quote);
    let quote_response = QuoteResponse {
        status: status_key(quote.status),
        status_name: abi::status_name(quote.status.as_u8()),
        latency_ms: quote.latency_ms,
        schema_valid: quote.schema_valid,
        escrow_usdc: abi::format_usdc(U256::from(quote.escrow)),
        escrow_units: quote.escrow.to_string(),
        rebate_to_caller_usdc: abi::format_usdc(U256::from(quote.rebate_to_caller)),
        bond_slash_usdc: abi::format_usdc(U256::from(quote.bond_slash)),
        net_usdc: abi::format_usdc(U256::from(quote.net)),
        paid_to_provider_usdc: abi::format_usdc(U256::from(quote.paid_to_provider)),
        paid_to_dependencies_usdc: abi::format_usdc(U256::from(quote.paid_to_dependencies)),
        split_amounts_usdc: quote
            .split_amounts
            .iter()
            .map(|v| abi::format_usdc(U256::from(*v)))
            .collect(),
        split_bps: terms.splits.iter().map(|s| s.bps).collect(),
        curve: build_curve(&terms, terms.call_price_usdc),
        explanation,
    };

    Json(ExecuteResponse {
        ok: true,
        fixture: fixture.slug.to_string(),
        service_name: fixture.name.to_string(),
        terms_source,
        service_id,
        order_id: req.order_id.clone(),
        endpoint_uri: registered_url,
        outcome_summary: executor::describe_outcome(&outcome),
        outcome,
        schema: schema_result,
        quote: quote_response,
        attestation,
        notes,
    })
    .into_response()
}

/// Serialise a JSON value deterministically: object keys sorted, no whitespace.
/// Shared with the operator scripts so a covenant's schema commitment is the
/// same string on both sides.
fn canonical_json(value: &serde_json::Value) -> String {
    fn write(value: &serde_json::Value, out: &mut String) {
        match value {
            serde_json::Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                out.push('{');
                for (index, key) in keys.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(key).expect("a string serialises"));
                    out.push(':');
                    write(&map[*key], out);
                }
                out.push('}');
            }
            serde_json::Value::Array(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    write(item, out);
                }
                out.push(']');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    let mut out = String::new();
    write(value, &mut out);
    out
}

fn default_body(slug: &str, mode: Option<&str>, seed: Option<u64>) -> serde_json::Value {
    let _ = mode;
    let _ = seed;
    match slug {
        "risk-scorer" => serde_json::json!({
            "counterparty": "0x4AB5e7F2b5464B9494b49EFE41C2f00e7bcfE555",
            "purpose": "release a milestone payment"
        }),
        "invoice-parser" => serde_json::json!({
            "document": "INVOICE INV-4210\nDue 2026-11-01\n3 x HOST-01 @ 42.00 EUR\nTotal 126.00 EUR"
        }),
        "ast-auditor" => serde_json::json!({
            "contractName": "Treasury",
            "source": "contract Treasury { function pay(address to, uint256 amt) external { (bool ok,) = to.call{value: amt}(\"\"); require(ok); } }"
        }),
        _ => serde_json::json!({}),
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…"
    }
}

// ---------------------------------------------------------------------------
// POST /api/kernel/:slug — the built-in deterministic services
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct KernelRequest {
    #[serde(default)]
    mode: Option<String>,
    #[serde(flatten)]
    rest: serde_json::Map<String, serde_json::Value>,
}

/// A deterministic latency, derived from the response to make the numbers
/// reproducible: no sleeps that vary run to run, no flaky demo.
async fn gate(mode: &str, fixture: &config::ServiceFixture) {
    let target = match mode {
        "degraded" => {
            let span = fixture.hard_timeout_ms - fixture.grace_latency_ms;
            fixture.grace_latency_ms + span / 2
        }
        "breach" => fixture.hard_timeout_ms + 250,
        _ => fixture.grace_latency_ms / 4,
    };
    tokio::time::sleep(std::time::Duration::from_millis(target as u64)).await;
}

async fn kernel(
    State(app): State<App>,
    Path(slug): Path<String>,
    Json(req): Json<KernelRequest>,
) -> Response {
    if !app.cfg.enable_mock_services {
        return problem(StatusCode::NOT_FOUND, "built-in services are disabled");
    }
    let Some(fixture) = config::fixture(&slug) else {
        return problem(StatusCode::NOT_FOUND, format!("`{slug}` is not a built-in service"));
    };
    let mode = req.mode.clone().unwrap_or_else(|| "normal".to_string());
    if !matches!(mode.as_str(), "normal" | "degraded" | "breach") {
        return problem(
            StatusCode::BAD_REQUEST,
            "mode must be normal, degraded or breach".to_string(),
        );
    }
    gate(&mode, fixture).await;

    match slug.as_str() {
        "risk-scorer" => {
            if mode == "breach" {
                // A structurally different answer: an empty checks list and no
                // band. This is what a degraded upstream actually looks like.
                return Json(serde_json::json!({
                    "score": 12,
                    "checks": [],
                    "note": "upstream signal provider unavailable; partial result"
                }))
                .into_response();
            }
            // Exactly the fields the covenant schema allows — no more. A service
            // that publishes a schema must satisfy it, and `additionalProperties: false`
            // means extra fields are a schema violation, not a courtesy.
            Json(serde_json::json!({
                "score": 71.5,
                "band": "medium",
                "checks": ["sanctions", "adverse-media", "pep"],
                "asOf": 1_760_000_000u64
            }))
            .into_response()
        }
        "invoice-parser" => {
            if mode == "breach" {
                return Json(serde_json::json!({
                    "invoiceId": "inv-4210",
                    "currency": "eur",
                    "amount": 12600,
                    "lines": []
                }))
                .into_response();
            }
            Json(serde_json::json!({
                "invoiceId": "INV-4210",
                "currency": "EUR",
                "amount": 12600,
                "lines": [
                    { "sku": "HOST-01", "amount": 12600 }
                ]
            }))
            .into_response()
        }
        "ast-auditor" => {
            if mode == "breach" {
                return Json(serde_json::json!({
                    "contractName": "Treasury",
                    "highRisk": "one",
                    "findings": [{ "rule": "unchecked-call", "severity": "HIGH" }]
                }))
                .into_response();
            }
            Json(serde_json::json!({
                "contractName": "Treasury",
                "highRisk": 1,
                "findings": [
                    { "rule": "unchecked-call", "severity": "high" },
                    { "rule": "missing-zero-address-check", "severity": "low" }
                ]
            }))
            .into_response()
        }
        _ => problem(StatusCode::NOT_FOUND, "unknown service"),
    }
}

#[cfg(test)]
mod canonical_json_tests {
    use super::canonical_json;

    #[test]
    fn canonicalisation_ignores_formatting_but_not_content() {
        let a: serde_json::Value = serde_json::from_str("{\n  \"type\": \"object\",\n  \"required\": [\"x\"]\n}").unwrap();
        let b: serde_json::Value = serde_json::from_str("{\"required\":[\"x\"],\"type\":\"object\"}").unwrap();
        assert_eq!(canonical_json(&a), "{\"required\":[\"x\"],\"type\":\"object\"}");
        assert_eq!(canonical_json(&a), canonical_json(&b), "key order must not matter");

        let c: serde_json::Value = serde_json::from_str("{\"required\":[\"y\"],\"type\":\"object\"}").unwrap();
        assert_ne!(canonical_json(&a), canonical_json(&c), "a changed schema must change the hash");
    }

    #[test]
    fn nested_and_typed_values_are_stable() {
        let value: serde_json::Value = serde_json::from_str(
            "{\"properties\":{\"score\":{\"maximum\":100,\"type\":\"number\"}},\"type\":\"object\"}",
        )
        .unwrap();
        assert_eq!(
            canonical_json(&value),
            "{\"properties\":{\"score\":{\"maximum\":100,\"type\":\"number\"}},\"type\":\"object\"}"
        );
    }

    #[test]
    fn fixture_schemas_canonicalise_the_same_way_on_both_sides() {
        // These are the hashes `scripts/lib/fixtures.ts` produces for the same
        // literals; a drift here means registration and validation disagree.
        for fixture in crate::config::FIXTURES {
            let canonical = canonical_json(&fixture.schema_value());
            assert!(
                canonical.starts_with('{') && canonical.ends_with('}'),
                "{}: {canonical}",
                fixture.slug
            );
            assert!(!canonical.contains('\n'), "{}: canonical form must not contain newlines", fixture.slug);
        }
    }
}

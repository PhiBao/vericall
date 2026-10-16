/**
 * The last page of the product: what settlement actually does.
 *
 * Everything the caller signs is derived here from data the chain would also
 * derive, so there is no path where the UI shows one number and the contract
 * pays another.
 */

export type OrderStatusName =
  | "none"
  | "funded"
  | "settled_pass"
  | "settled_degraded"
  | "settled_breached"
  | "reclaimed_expired";

export type Verdict = "pass" | "degraded" | "breach" | "pending" | "reclaimed";

export interface Split {
  recipient: string;
  bps: number;
  percent: string;
  role: "provider" | "dependency";
}

export interface ServiceView {
  id: string;
  provider: string;
  verifier: string;
  name: string;
  endpoint_uri: string;
  schema_hash: string;
  call_price_usdc: string;
  call_price_units: string;
  grace_latency_ms: number;
  hard_timeout_ms: number;
  max_rebate_bps: number;
  slash_penalty_bps: number;
  provider_bond_usdc: string;
  provider_bond_units: string;
  active: boolean;
  splits: Split[];
  required_bond_usdc: string;
  bond_covers_one_order: boolean;
}

export interface OrderTxs {
  created: string | null;
  settled: string | null;
  reclaimed: string | null;
  block_number: number | null;
}

export interface OrderView {
  id: string;
  /** Where to find this order's transactions, scanned from the contract's events. */
  txs?: OrderTxs;
  service_id: string;
  caller: string;
  escrowed_usdc: string;
  escrowed_units: string;
  request_hash: string;
  created_at: number;
  expiry_at: number;
  status: number;
  status_name: OrderStatusName;
  measured_latency_ms: number;
  response_hash: string;
  schema_valid: boolean;
  paid_to_provider_usdc: string;
  paid_to_dependencies_usdc: string;
  refunded_to_caller_usdc: string;
  bond_slashed_usdc: string;
  settlement_total_usdc: string;
  settled: boolean;
  /**
   * The settlement transaction, when the deployment records one. Orders are
   * contract state rather than transactions, so this is absent on a ledger read
   * that has no per-order tx index; the UI shows an explorer link only when it
   * is present.
   */
  tx_hash?: string | null;
}

export interface BalanceView {
  address: string;
  native_usdc: string;
  usdc: string;
  role: "caller" | "provider" | "dependency" | "watched";
}

export interface ChainStatus {
  network: string;
  chain_id: number;
  block_number: number;
  endpoint: string;
  latency_ms: number;
}

export interface LedgerView {
  chain: ChainStatus;
  contract: string | null;
  contract_code_present: boolean;
  usdc: string;
  explorer: string;
  total_escrowed_usdc: string;
  total_bond_usdc: string;
  invariant_ok: boolean;
  invariant_note: string;
  open_orders: number;
  services: ServiceView[];
  orders: OrderView[];
  balances: BalanceView[];
}

export interface FixturePublic {
  slug: string;
  name: string;
  summary: string;
  price_usdc: string;
  grace_latency_ms: number;
  hard_timeout_ms: number;
  max_rebate_bps: number;
  slash_penalty_bps: number;
  provider_split_bps: number;
}

export interface Eip712Public {
  domain_name: string;
  domain_version: string;
  attestation_types: string;
  registration_types: string;
}

export interface PublicConfig {
  network: string;
  chain_id: number;
  explorer: string;
  rpcs: string[];
  usdc: string;
  usdc_decimals: number;
  contract: string | null;
  verifier_address: string | null;
  can_settle: boolean;
  mock_base_url: string;
  fixtures: FixturePublic[];
  eip712: Eip712Public;
}

export interface Health {
  ok: boolean;
  version: string;
  network: string;
  chain_id: number;
  settlement_chain_id: number;
  contract: string | null;
  verifier_address: string | null;
  can_settle: boolean;
  chain: ChainStatus | null;
  chain_error: string | null;
  mock_services: boolean;
  uptime_s: number;
}

export interface CurvePoint {
  latency_ms: number;
  rebate_usdc: string;
  to_provider_usdc: string;
  to_dependencies_usdc: string;
  status: Verdict;
}

export interface QuoteResponse {
  status: Verdict;
  status_name: string;
  latency_ms: number;
  schema_valid: boolean;
  escrow_usdc: string;
  escrow_units: string;
  rebate_to_caller_usdc: string;
  bond_slash_usdc: string;
  net_usdc: string;
  paid_to_provider_usdc: string;
  paid_to_dependencies_usdc: string;
  split_amounts_usdc: string[];
  split_bps: number[];
  curve: CurvePoint[];
  explanation: string;
}

export interface CallOutcome {
  url: string;
  method: "get" | "post";
  status: number | null;
  latency_ms: number;
  timed_out: boolean;
  transport_error: string | null;
  body: string | null;
  body_too_large: boolean;
  response_bytes: number;
  response_hash: string;
  response_sha256: string;
  request_hash: string;
}

export interface SchemaResult {
  valid: boolean;
  errors: string[];
  checked_against: string;
}

/**
 * What a signer needs. `calldata` is the exact `settleOrder` payload for the
 * named order; `signature` is the verifier's EIP-712 attestation inside it.
 *
 * `order_id` / `service_id` are null when the run is not bound to a funded
 * order: `/api/execute` measures a call before any escrow exists, and returns
 * `calldata: null` in that state. Treat a missing id, or absent calldata, as
 * "nothing to settle yet" — never as zero.
 */
export interface AttestationView {
  order_id?: string | null;
  service_id?: number | string | null;
  calldata: string | null;
  digest: string;
  signature: string | null;
  signer: string | null;
  deadline: number;
  typed_data: unknown;
}

export interface ExecuteResponse {
  ok: boolean;
  fixture: string;
  service_name: string;
  /** `record` when the terms came from the registered covenant onchain, `fixture` when they are local defaults. */
  terms_source?: string;
  service_id?: number | null;
  order_id?: string | null;
  endpoint_uri: string;
  outcome: CallOutcome;
  outcome_summary: string;
  schema: SchemaResult;
  quote: QuoteResponse;
  attestation: AttestationView | null;
  notes: string[];
}

export const verdictOfStatus = (status: number): Verdict => {
  switch (status) {
    case 1:
      return "pending";
    case 2:
      return "pass";
    case 3:
      return "degraded";
    case 4:
      return "breach";
    case 5:
      return "reclaimed";
    default:
      return "pending";
  }
};

export const verdictLabel = (verdict: Verdict): string => {
  switch (verdict) {
    case "pass":
      return "promise kept";
    case "degraded":
      return "degraded · rebated";
    case "breach":
      return "breached · refunded";
    case "reclaimed":
      return "expired · reclaimed";
    default:
      return "in escrow";
  }
};

export const statusLabel = (name: OrderStatusName): string => {
  switch (name) {
    case "settled_pass":
      return "promise kept";
    case "settled_degraded":
      return "degraded · rebated";
    case "settled_breached":
      return "breached · refunded";
    case "reclaimed_expired":
      return "expired · reclaimed";
    case "funded":
      return "in escrow";
    default:
      return "not an order";
  }
};

export const verdictClass = (verdict: Verdict): string => {
  switch (verdict) {
    case "pass":
      return "tag tag--pass";
    case "degraded":
      return "tag tag--degraded";
    case "breach":
      return "tag tag--breach";
    case "reclaimed":
      return "tag tag--muted";
    default:
      return "tag tag--verified";
  }
};

export function shortAddress(address: string | null | undefined, size = 6): string {
  if (!address) return "—";
  if (address.length <= size * 2 + 2) return address;
  return `${address.slice(0, size + 2)}…${address.slice(-size)}`;
}

export function shortHash(hash: string | null | undefined, size = 10): string {
  if (!hash) return "—";
  if (hash.length <= size * 2 + 2) return hash;
  return `${hash.slice(0, size + 2)}…${hash.slice(-size)}`;
}

export function formatBps(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  return frac === 0 ? `${whole}%` : `${whole}.${String(frac).padStart(2, "0")}%`;
}

export function formatDuration(ms: number): string {
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

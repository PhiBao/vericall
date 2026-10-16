/**
 * Client for the VeriCall verifier (the Rust service in `verifier/`).
 *
 * The operator scripts never sign an SLA attestation themselves and never
 * measure latency themselves: that is the verifier's job, and a script that
 * duplicated it would be a second implementation to keep honest. Everything
 * here either asks the verifier to run and attest, or asks it what it knows.
 */

export interface VerifierConfig {
  network: string;
  chain_id: number;
  explorer: string;
  rpcs: string[];
  usdc: string;
  contract: string | null;
  verifier_address: string | null;
  can_settle: boolean;
  mock_base_url: string;
}

export interface VerifierHealth {
  ok: boolean;
  version: string;
  network: string;
  chain_id: number;
  contract: string | null;
  verifier_address: string | null;
  can_settle: boolean;
  chain: { block_number: number; endpoint: string; latency_ms: number } | null;
  chain_error: string | null;
  mock_services: boolean;
  /** Whether the model-backed services have a credential, and what bounds them. */
  model_services: {
    configured: boolean;
    daily_budget: number;
    daily_remaining: number;
    max_concurrent: number;
    per_minute: number;
  };
}

export interface Attestation {
  order_id: string | null;
  service_id: number | null;
  calldata: string | null;
  digest: string;
  signature: string | null;
  signer: string | null;
  deadline: number;
}

export interface ExecutionResult {
  ok: boolean;
  fixture: string;
  service_name: string;
  terms_source: "record" | "fixture";
  service_id: number | null;
  order_id: string | null;
  endpoint_uri: string;
  outcome_summary: string;
  outcome: {
    status: number | null;
    latency_ms: number;
    timed_out: boolean;
    transport_error: string | null;
    response_hash: string;
    response_sha256: string;
    request_hash: string;
    body: string | null;
    body_too_large: boolean;
    response_bytes: number;
  };
  schema: { valid: boolean; errors: string[]; checked_against: string };
  quote: {
    status: "pass" | "degraded" | "breach" | "pending" | "reclaimed";
    latency_ms: number;
    schema_valid: boolean;
    escrow_usdc: string;
    rebate_to_caller_usdc: string;
    bond_slash_usdc: string;
    net_usdc: string;
    paid_to_provider_usdc: string;
    paid_to_dependencies_usdc: string;
    split_amounts_usdc: string[];
    explanation: string;
  };
  attestation: Attestation | null;
  notes: string[];
}

export class VerifierError extends Error {
  // A plain property rather than a constructor parameter property: Node's
  // strip-only TypeScript loader rejects parameter properties, and these scripts
  // run without a build step.
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "VerifierError";
    this.status = status;
  }
}

function baseUrl(): string {
  return (process.env.VERICALL_API ?? "http://localhost:8787").replace(/\/$/, "");
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${baseUrl()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new VerifierError(
      `the verifier at ${baseUrl()} could not be reached (${error instanceof Error ? error.message : String(error)}). Start it with \`cd verifier && cargo run --release\`.`,
      0,
    );
  }
  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // keep the raw body
    }
    throw new VerifierError(message, response.status);
  }
  return JSON.parse(text) as T;
}

export function health(): Promise<VerifierHealth> {
  return request<VerifierHealth>("/api/health");
}

export function config(): Promise<VerifierConfig> {
  return request<VerifierConfig>("/api/config");
}

export interface ExecuteArgs {
  fixture: string;
  mode?: "normal" | "degraded" | "breach";
  serviceId?: number;
  orderId?: string;
  /**
   * The request body exactly as the caller committed it onchain. Required when
   * `orderId` is set: the verifier refuses to attest to a request the order does
   * not name, because otherwise anyone could point an order at a request they
   * knew would breach and collect the provider's bond.
   */
  bodyRaw?: string;
  /** How long the attestation stays valid. Defaults to 900 seconds. */
  validForSeconds?: number;
}

export function execute(args: ExecuteArgs): Promise<ExecutionResult> {
  return request<ExecutionResult>("/api/execute", {
    method: "POST",
    body: JSON.stringify({
      fixture: args.fixture,
      mode: args.mode ?? "normal",
      service_id: args.serviceId,
      order_id: args.orderId,
      body_raw: args.bodyRaw,
      valid_for_seconds: args.validForSeconds,
    }),
  });
}

export interface QuoteArgs {
  fixture: string;
  serviceId?: number;
  latencyMs: number;
  schemaValid?: boolean;
  escrowUsdc?: string;
}

export function quote(args: QuoteArgs): Promise<{
  status: string;
  latency_ms: number;
  rebate_to_caller_usdc: string;
  bond_slash_usdc: string;
  paid_to_provider_usdc: string;
  paid_to_dependencies_usdc: string;
  explanation: string;
}> {
  return request("/api/quote", {
    method: "POST",
    body: JSON.stringify({
      fixture: args.fixture,
      service_id: args.serviceId,
      latency_ms: args.latencyMs,
      schema_valid: args.schemaValid ?? true,
      escrow_usdc: args.escrowUsdc,
    }),
  });
}

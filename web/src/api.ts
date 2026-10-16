/**
 * Typed wrappers over the verifier's HTTP surface.
 *
 * Every failure mode is represented, including the one that matters most for
 * this product: the verifier not answering at all. A panel that cannot read the
 * chain must say so — it must never fall back to a plausible-looking number.
 */

import type {
  CallOutcome,
  ExecuteResponse,
  Health,
  LedgerView,
  PublicConfig,
  QuoteResponse,
} from "./types";

/** A failed API call, with enough context to render an honest error state. */
export class ApiError extends Error {
  /** HTTP status, or `null` when the request never reached the verifier. */
  readonly status: number | null;
  readonly path: string;
  /** The verifier's own `{ error }` message, or the raw body when it is not JSON. */
  readonly detail: string | null;

  constructor(
    message: string,
    options: { status: number | null; path: string; detail?: string | null },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    this.path = options.path;
    this.detail = options.detail ?? null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** One sentence a judge can act on, for any thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.detail ? `${error.message} — ${error.detail}` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (cause) {
    throw new ApiError(
      `the verifier at ${path} could not be reached — it is probably not running`,
      {
        status: null,
        path,
        detail: cause instanceof Error ? cause.message : String(cause),
      },
    );
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    // The verifier reports problems as `{ error, ok: false }`. Surface that
    // string verbatim: it is written for a human.
    const detail =
      isRecord(parsed) && typeof parsed.error === "string"
        ? parsed.error
        : text.slice(0, 400) || null;
    throw new ApiError(`HTTP ${response.status} from ${path}`, {
      status: response.status,
      path,
      detail,
    });
  }

  if (parsed === null) {
    throw new ApiError(`${path} answered ${response.status} with a body that is not JSON`, {
      status: response.status,
      path,
      detail: text.slice(0, 400) || null,
    });
  }

  return parsed as T;
}

function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * Hashes on the wire.
 *
 * `/api/execute` returns `request_hash` / `response_hash` as a JSON array of 32
 * bytes in some builds of the verifier and as `0x…` hex in others, because the
 * Rust field is a `[u8; 32]`. Normalising once, here, is what keeps that churn
 * out of the interface: a hash is displayed as hex or not at all.
 */
function normalizeHash(value: unknown): string {
  if (typeof value === "string" && value.startsWith("0x")) return value;
  if (Array.isArray(value)) {
    const bytes = value.filter((byte): byte is number => typeof byte === "number");
    if (bytes.length === 32) {
      return `0x${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    }
  }
  return "—";
}

function normalizeExecute(response: ExecuteResponse): ExecuteResponse {
  return {
    ...response,
    outcome: {
      ...response.outcome,
      request_hash: normalizeHash(response.outcome.request_hash),
      response_hash: normalizeHash(response.outcome.response_hash),
    },
  };
}

export const getHealth = (signal?: AbortSignal): Promise<Health> =>
  request<Health>("/api/health", { signal });

export const getConfig = (signal?: AbortSignal): Promise<PublicConfig> =>
  request<PublicConfig>("/api/config", { signal });

export const getLedger = (signal?: AbortSignal): Promise<LedgerView> =>
  request<LedgerView>("/api/ledger", { signal });

export interface QuoteRequest {
  /** A built-in fixture slug. Supply either this or `terms`, never both. */
  fixture?: string;
  escrow_usdc?: string;
  latency_ms: number;
  schema_valid?: boolean;
}

export const postQuote = (body: QuoteRequest, signal?: AbortSignal): Promise<QuoteResponse> =>
  postJson<QuoteResponse>("/api/quote", body, signal);

export type CallMode = "normal" | "degraded" | "breach";

export interface ExecuteRequest {
  fixture: string;
  mode?: CallMode;
  seed?: number;
  /**
   * The registered covenant to attest against. Required for a settlement: with
   * it, the verifier takes the provider address and the terms from the record it
   * has confirmed onchain, which is what makes the signature verify.
   */
  service_id?: number;
  /**
   * The funded order this run is attesting to. With an order id and a signing
   * key the verifier returns real `settleOrder` calldata; without one it returns
   * a measurement and nothing to settle.
   */
  order_id?: string;
}

export async function postExecute(
  body: ExecuteRequest,
  signal?: AbortSignal,
): Promise<ExecuteResponse> {
  return normalizeExecute(await postJson<ExecuteResponse>("/api/execute", body, signal));
}

/**
 * The verifier's transport-success predicate, restated so the interface can
 * explain the verdict instead of asserting it: a call is transport-successful
 * only when it neither timed out nor failed on the wire nor overflowed the body
 * cap, and answered 2xx. The covenant verdict is this AND schema compliance — so
 * a 200 with the wrong shape is a breach, which is the whole point of a covenant.
 */
export function httpOk(outcome: CallOutcome): boolean {
  return (
    !outcome.timed_out &&
    !outcome.body_too_large &&
    outcome.transport_error === null &&
    outcome.status !== null &&
    outcome.status >= 200 &&
    outcome.status < 300
  );
}

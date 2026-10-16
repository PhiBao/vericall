import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ExecuteResponse, FixturePublic } from "../types";
import { formatBps, formatDuration } from "../types";
import { httpOk } from "../api";
import {
  byteLength,
  formatGwei,
  selectorOf,
  sumUnits,
  timestamp,
  unitsToFixed,
  usdcToUnits,
} from "../format";

/**
 * The trace.
 *
 * Every row is built from a value the verifier returned for *this* call: the
 * measured latency, the status, the digests, the schema verdict, the quote, the
 * split and the attestation. Rows are revealed one at a time (see `REVEAL_MS`)
 * so a reader can follow the order of operations, but nothing in a row is
 * produced by the animation — the animation only delays when a fact appears.
 *
 * The `t` column carries a real event time only where one exists: 0 ms is the
 * moment the request went out, and the response row carries the measured
 * latency. Rows that describe derived facts leave it empty rather than
 * inventing a timestamp the verifier never measured.
 */

export type TraceLevel = "ok" | "warn" | "err" | "dim" | "key" | "plain";

export interface TraceRow {
  t: string;
  body: ReactNode;
  level: TraceLevel;
}

/* ------------------------------------------------------------ row builder -- */

const PHASE_WIDTH = 7;

const row = (t: string, level: TraceLevel, phase: string, body: ReactNode): TraceRow => ({
  t,
  level,
  body: (
    <>
      <span className="trace__key">{phase.padEnd(PHASE_WIDTH, " ")}</span>
      {body}
    </>
  ),
});

/** The EIP-712 message the verifier built, read without asserting a shape. */
function typedMessage(typed: unknown): Record<string, unknown> | null {
  if (typeof typed !== "object" || typed === null) return null;
  const message = (typed as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return null;
  return message as Record<string, unknown>;
}

/**
 * Turn one `/api/execute` response into the trace of how it was produced.
 *
 * `providerIndex` is `0` only when the fixture's own advertised provider share
 * matches the first basis-point figure the quote returned; otherwise the role of
 * a split row is not knowable from the response alone, and the row says
 * "recipient n" instead of guessing.
 */
export function buildExecuteTrace(
  run: ExecuteResponse,
  fixture: FixturePublic | null,
  providerIndex: number,
): TraceRow[] {
  const { outcome, schema, quote, attestation } = run;
  const rows: TraceRow[] = [];

  rows.push(row("0ms", "dim", "call", <>POST {outcome.url}</>));
  rows.push(
    row(
      "",
      run.terms_source === "record" ? "ok" : "warn",
      "call",
      run.terms_source === "record" ? (
        <>terms from covenant record #{run.service_id ?? "?"} — confirmed against the chain</>
      ) : (
        <>terms from the verifier&apos;s fixture defaults{run.service_id ? ` (service ${run.service_id})` : ""} — a signature from this run may not verify onchain</>
      ),
    ),
  );
  rows.push(
    row(
      "",
      run.order_id ? "key" : "dim",
      "call",
      run.order_id ? (
        <>attesting to order #{run.order_id}</>
      ) : (
        <>no order bound: measure only, nothing to settle</>
      ),
    ),
  );
  if (fixture) {
    // The promise the call is about to be judged against, stated before the
    // result so the trace reads as a test rather than a summary.
    rows.push(
      row(
        "",
        "dim",
        "call",
        <>
          covenant {fixture.slug} · price {fixture.price_usdc} USDC · grace{" "}
          {formatDuration(fixture.grace_latency_ms)} · hard {formatDuration(fixture.hard_timeout_ms)} ·
          max rebate {formatBps(fixture.max_rebate_bps)}
        </>,
      ),
    );
  }

  const httpSucceeded = httpOk(outcome);
  if (outcome.timed_out) {
    rows.push(
      row(
        formatDuration(outcome.latency_ms),
        "err",
        "http",
        <>no response within the client timeout — a breach at any latency</>,
      ),
    );
  } else if (outcome.status === null) {
    rows.push(
      row(formatDuration(outcome.latency_ms), "err", "http", <>transport failure: {outcome.transport_error ?? "unspecified"}</>),
    );
  } else {
    rows.push(
      row(
        formatDuration(outcome.latency_ms),
        httpSucceeded ? "ok" : "err",
        "http",
        <>
          ← HTTP {outcome.status} · {outcome.response_bytes} bytes · measured end to end by the
          verifier
        </>,
      ),
    );
  }

  if (outcome.body_too_large) {
    rows.push(row("", "err", "http", <>the response body exceeded the capture cap, which is itself a failure</>));
  }

  rows.push(
    row("", "dim", "hash", <>request_hash {outcome.request_hash} — keccak256(url ‖ body)</>),
  );
  rows.push(
    row(
      "",
      "dim",
      "hash",
      outcome.body === null ? (
        <>response_sha256 {outcome.response_sha256} · no body was captured</>
      ) : (
        <>response_sha256 {outcome.response_sha256}</>
      ),
    ),
  );
  rows.push(
    row("", "dim", "hash", <>response_hash {outcome.response_hash} — keccak256, what the contract stores</>),
  );

  rows.push(
    row(
      "",
      schema.valid ? "ok" : "err",
      "schema",
      <>
        {schema.valid ? "satisfied" : "violated"} · {schema.checked_against}
      </>,
    ),
  );
  for (const error of schema.errors) {
    rows.push(row("", "err", "schema", <>↳ {error}</>));
  }
  rows.push(
    row(
      "",
      quote.schema_valid ? "ok" : "err",
      "schema",
      <>
        covenant schema_valid = {String(quote.schema_valid)}
        <span className="trace__dim">
          {" "}
          ({schema.valid ? "schema satisfied" : "schema violated"} ∧ {httpSucceeded ? "HTTP 2xx" : "HTTP not 2xx"})
        </span>
      </>,
    ),
  );

  if (!schema.valid && httpSucceeded) {
    rows.push(
      row(
        "",
        "warn",
        "schema",
        <>the service answered successfully but broke its own schema, which is the breach</>,
      ),
    );
  }

  const overrun = quote.latency_ms - (fixture?.grace_latency_ms ?? 0);
  const span = (fixture?.hard_timeout_ms ?? 0) - (fixture?.grace_latency_ms ?? 0);
  if (quote.status === "degraded" && fixture && overrun > 0) {
    rows.push(
      row(
        "",
        "warn",
        "quote",
        <>{formatDuration(overrun)} past the {formatDuration(fixture.grace_latency_ms)} grace edge, of a {formatDuration(span)} span to the hard timeout</>,
      ),
    );
  }

  rows.push(
    row(
      "",
      quote.status === "pass" ? "ok" : quote.status === "degraded" ? "warn" : "err",
      "quote",
      <>
        {quote.status} · escrow {quote.escrow_usdc} USDC · rebate {quote.rebate_to_caller_usdc} USDC ·
        net {quote.net_usdc} USDC
      </>,
    ),
  );
  const bondSlash = usdcToUnits(quote.bond_slash_usdc);
  if (bondSlash !== null && bondSlash > 0n) {
    rows.push(
      row(
        "",
        "err",
        "quote",
        <>bond penalty {quote.bond_slash_usdc} USDC taken from the provider&rsquo;s stake</>,
      ),
    );
  }
  rows.push(row("", "dim", "quote", <>{quote.explanation}</>));

  quote.split_amounts_usdc.forEach((amount, index) => {
    const bps = quote.split_bps[index];
    rows.push(
      row(
        "",
        quote.status === "breach" ? "dim" : "ok",
        "split",
        <>
          {index === providerIndex ? "provider" : `recipient ${index}`} · {bps === undefined ? "—" : formatBps(bps)} →{" "}
          {amount} USDC
        </>,
      ),
    );
  });
  const total = sumUnits(quote.split_amounts_usdc);
  const net = usdcToUnits(quote.net_usdc);
  if (total !== null && net !== null) {
    rows.push(
      row(
        "",
        total === net ? "ok" : "err",
        "split",
        <>
          parts sum to {unitsToFixed(total)} USDC · net is {unitsToFixed(net)} USDC
          {total === net ? " — no dust stranded" : " — does not balance"}
        </>,
      ),
    );
  }

  if (attestation) {
    const digestBound = attestation.digest.length > 2 && attestation.digest !== "0x";
    rows.push(
      row(
        "",
        digestBound ? "key" : "warn",
        "attest",
        digestBound ? (
          <>digest {attestation.digest}</>
        ) : (
          <>digest not bound — no order id was supplied, so there is nothing to sign</>
        ),
      ),
    );
    rows.push(
      row(
        "",
        attestation.signer ? "key" : "warn",
        "attest",
        attestation.signer ? (
          <>verifier signer {attestation.signer}</>
        ) : (
          <>no verifier signer: this verifier holds no signing key</>
        ),
      ),
    );
    const signatureBytes = attestation.signature ? byteLength(attestation.signature) : null;
    rows.push(
      row(
        "",
        attestation.signature ? "key" : "dim",
        "attest",
        attestation.signature ? (
          <>signature {signatureBytes ?? "—"} bytes · deadline {timestamp(attestation.deadline)}</>
        ) : (
          <>no signature · deadline {timestamp(attestation.deadline)}</>
        ),
      ),
    );

    const message = typedMessage(attestation.typed_data);
    if (message) {
      rows.push(
        row(
          "",
          "dim",
          "attest",
          <>
            typed_data SlaAttestation(orderId {String(message.orderId)}, latencyMs{" "}
            {String(message.latencyMs)}, schemaValid {String(message.schemaValid)}, responseHash{" "}
            {String(message.responseHash)})
          </>,
        ),
      );
    }

    const calldata = attestation.calldata;
    if (calldata && calldata.length > 2) {
      const bytes = byteLength(calldata);
      rows.push(
        row(
          "",
          "key",
          "attest",
          <>
            settleOrder calldata {bytes ?? "—"} bytes · selector {selectorOf(calldata) ?? "—"}
          </>,
        ),
      );
    } else {
      rows.push(
        row(
          "",
          "warn",
          "attest",
          <>calldata 0x — nothing to send: settleOrder needs a funded order id to bind</>,
        ),
      );
    }
  } else {
    rows.push(row("", "warn", "attest", <>the verifier returned no attestation for this call</>));
  }

  for (const note of run.notes) {
    rows.push(row("", "warn", "note", <>{note}</>));
  }

  return rows;
}

/** Rows a settlement contributes once a transaction has actually been sent. */
export function settleTraceRows(entries: Array<{ t: string; level: TraceLevel; text: ReactNode }>): TraceRow[] {
  return entries.map((entry) => row(entry.t, entry.level, "settle", entry.text));
}

export const describeReceipt = (receipt: {
  status: "success" | "reverted";
  blockNumber: number | null;
  gasUsed: bigint | null;
  effectiveGasPriceWei: bigint | null;
}): ReactNode => (
  <>
    {receipt.status === "success" ? "confirmed" : "reverted"}
    {receipt.blockNumber !== null ? ` in block ${receipt.blockNumber}` : ""}
    {receipt.gasUsed !== null ? ` · gas used ${receipt.gasUsed}` : ""}
    {receipt.effectiveGasPriceWei !== null
      ? ` · paid ${formatGwei(receipt.effectiveGasPriceWei)}`
      : ""}
  </>
);

/* -------------------------------------------------------------- component -- */

interface TelemetryTraceProps {
  rows: TraceRow[];
  /** Changes when a new run starts, which resets the reveal. */
  runId: number;
  title: string;
  note: string;
  /** Empty-state copy that teaches what will appear here. */
  empty: ReactNode;
  children?: ReactNode;
}

const BASE_REVEAL_MS = 150;

export function TelemetryTrace({
  rows,
  runId,
  title,
  note,
  empty,
  children,
}: TelemetryTraceProps) {
  // Reveal one row at a time. State is keyed by runId so a new run starts from
  // zero even when it arrives in the same commit as more rows.
  const [state, setState] = useState({ runId, visible: 0 });
  if (state.runId !== runId) {
    setState({ runId, visible: 0 });
  }
  const visible = state.visible;

  useEffect(() => {
    if (visible >= rows.length) return;
    // Longer traces are revealed faster so the panel always settles quickly.
    const delay = rows.length > 16 ? BASE_REVEAL_MS / 2 : BASE_REVEAL_MS;
    const timer = window.setTimeout(
      () => setState((current) => ({ ...current, visible: Math.min(current.visible + 1, rows.length) })),
      delay,
    );
    return () => window.clearTimeout(timer);
  }, [visible, rows.length]);

  const boxRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || !pinnedRef.current) return;
    box.scrollTop = box.scrollHeight;
  }, [visible]);

  return (
    <section className="panel panel--instrument" aria-labelledby="trace-heading">
      <div className="panel__head">
        <h2 className="panel__title" id="trace-heading">
          {title}
        </h2>
        <span className="panel__note">{note}</span>
      </div>
      <div className="panel__body stack">
        <div
          className="trace"
          ref={boxRef}
          role="log"
          aria-live="polite"
          aria-label="Telemetry trace of the last call"
          tabIndex={0}
          onScroll={() => {
            const box = boxRef.current;
            if (!box) return;
            pinnedRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
          }}
        >
          {rows.length === 0 ? (
            <div className="trace__row">
              <span className="trace__t" />
              <span className="trace__dim">{empty}</span>
            </div>
          ) : (
            rows.slice(0, visible).map((line, index) => (
              <div className="trace__row" key={`${runId}-${index}`}>
                <span className="trace__t">{line.t}</span>
                <span className={line.level === "plain" ? undefined : `trace__${line.level}`}>
                  {line.body}
                </span>
              </div>
            ))
          )}
        </div>
        {children}
      </div>
    </section>
  );
}

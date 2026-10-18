import { useState } from "react";
import type { CallMode } from "../api";
import { httpOk } from "../api";
import type { ExecuteResponse, FixturePublic, OrderView } from "../types";
import { formatBps, formatDuration, shortHash, verdictClass, verdictLabel } from "../types";
import { splitRole, sumUnits, timestamp, unitsToFixed, usdcFixed, usdcToUnits } from "../format";

/**
 * The live call.
 *
 * Nothing on this panel is optional: the mode selects a latency the built-in
 * service is pinned to answer at, and everything else — the status, the measured
 * latency, the byte count, the schema verdict — is a property of the request the
 * verifier actually made.
 */

interface ExecutePanelProps {
  fixture: FixturePublic | null;
  mode: CallMode;
  onMode: (mode: CallMode) => void;
  onRun: () => void;
  running: boolean;
  run: ExecuteResponse | null;
  error: string | null;
  canRun: boolean;
  /** Funded orders of this covenant: the only runs that can be settled. */
  orders: OrderView[];
  boundOrderId: string | null;
  onBindOrder: (orderId: string | null) => void;
  /** Onchain ids for this fixture's covenant records, newest registration first. */
  covenantIds: number[];
}

/** What each mode makes the built-in service do. These are the verifier's own
 *  pinned latencies, so the label is a promise the demo can keep. */
const MODE_NOTE: Record<CallMode, string> = {
  normal: "answers at a quarter of the grace window",
  degraded: "answers halfway between grace and the hard timeout",
  breach:
    "answers 250 ms past the hard timeout, with a body that violates the covenant schema",
};

const MODES: CallMode[] = ["normal", "degraded", "breach"];

/** Copy to clipboard, only where the browser will allow it. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  if (typeof navigator === "undefined" || navigator.clipboard === undefined) return null;
  return (
    <button
      type="button"
      className="button button--quiet button--mono tiny"
      aria-label={`Copy ${label}`}
      onClick={() => {
        navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_200);
          })
          .catch(() => setCopied(false));
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

/** The response body is JSON in every non-breach case; pretty-print it when it
 *  parses and show the bytes untouched when it does not. */
function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function SplitTable({ run, providerIndex }: { run: ExecuteResponse; providerIndex: number }) {
  const { quote } = run;
  const total = sumUnits(quote.split_amounts_usdc);
  const net = usdcToUnits(quote.net_usdc);
  const balanced = total !== null && net !== null && total === net;
  return (
    <div className="stack--tight">
      <table className="table">
        <caption>Settlement split — floored per recipient, remainder to the provider</caption>
        <thead>
          <tr>
            <th scope="col">Recipient</th>
            <th scope="col" className="num">
              Basis points
            </th>
            <th scope="col" className="num">
              USDC
            </th>
          </tr>
        </thead>
        <tbody>
          {quote.split_amounts_usdc.map((amount, index) => (
            <tr key={`${index}-${amount}`}>
              <td>{splitRole(index, providerIndex)}</td>
              <td className="num">
                {quote.split_bps[index] === undefined ? "—" : formatBps(quote.split_bps[index])}
              </td>
              <td className="num">{amount}</td>
            </tr>
          ))}
          <tr>
            <td>
              <strong>net to split</strong>
            </td>
            <td className="num muted">—</td>
            <td className="num">
              <strong>{quote.net_usdc}</strong>
            </td>
          </tr>
        </tbody>
      </table>
      <div className="row">
        <span className={balanced ? "tag tag--pass" : "tag tag--breach"}>
          {balanced ? "parts sum to net" : total === null ? "sum unavailable" : "does not balance"}
        </span>
        <span className="tiny muted">
          {balanced
            ? "every base unit of the net amount is assigned; nothing is stranded"
            : "the parts and the net disagree, which is a bug worth investigating"}
        </span>
      </div>
    </div>
  );
}

export function ExecutePanel({
  fixture,
  mode,
  onMode,
  onRun,
  running,
  run,
  error,
  canRun,
  orders,
  boundOrderId,
  onBindOrder,
  covenantIds,
}: ExecutePanelProps) {
  // The provider's index in the split array is knowable only when the fixture's
  // advertised provider share matches the first figure the quote returned.
  const providerIndex =
    fixture && run && run.quote.split_bps[0] === fixture.provider_split_bps ? 0 : -1;

  const settlementTotal = run
    ? sumUnits([run.quote.rebate_to_caller_usdc, run.quote.bond_slash_usdc, run.quote.net_usdc])
    : null;

  // A 404 from the covenant's own endpoint is worth naming precisely, because
  // the alternative is a reader concluding the product is broken when in fact
  // the address in the covenant is not the address that serves the service.
  const endpointMissing =
    run !== null && run.outcome.status === 404 && run.outcome.url.includes("/mock/");

  const bindingNote =
    covenantIds.length === 0
      ? "the ledger holds no covenant record matching this fixture, so the verifier has no service id it can attest with"
      : orders.length === 0
        ? "this covenant has no funded order open — an order is funded onchain before a call can be settled"
        : boundOrderId === null
          ? "measure only: no order is bound, so the result cannot be settled"
          : `the attestation will be signed against order #${boundOrderId}${
              covenantIds.length > 1 ? ` and covenant record ${covenantIds.map((id) => `#${id}`).join(" / ")}` : ""
            }, which is what the contract will verify`;

  return (
    <section className="panel" aria-labelledby="execute-heading">
      <div className="panel__head">
        <h2 className="panel__title" id="execute-heading">
          Live call
        </h2>
        <span className="panel__note">
          one real HTTP request, measured and validated by the verifier
        </span>
      </div>

      <div className="panel__body stack">
        <div className="row--between">
          <div className="row">
            <div className="stack--tight">
              {fixture && fixture.backed_by === "deterministic" ? (
                <>
                  <span className="fact__label" id="mode-label">
                    Mode
                  </span>
                  <div className="segmented" role="group" aria-labelledby="mode-label">
                    {MODES.map((candidate) => (
                      <button
                        key={candidate}
                        type="button"
                        aria-pressed={mode === candidate}
                        onClick={() => onMode(candidate)}
                      >
                        {candidate}
                      </button>
                    ))}
                  </div>
                  <span className="tiny muted">{MODE_NOTE[mode]}</span>
                </>
              ) : (
                <>
                  <span className="fact__label">What this call is</span>
                  <span className="small">
                    {fixture?.backed_by === "external"
                      ? "a real request to a third-party API, at whatever latency it takes"
                      : "a real model call, at whatever latency it takes"}
                  </span>
                  <span className="tiny muted">{fixture?.backing}</span>
                </>
              )}
            </div>

            <div className="field field--compact">
              <label htmlFor="bind-order">Attest to order</label>
              <select
                id="bind-order"
                value={boundOrderId ?? ""}
                disabled={orders.length === 0}
                onChange={(event) => onBindOrder(event.target.value === "" ? null : event.target.value)}
              >
                <option value="">measure only</option>
                {orders.map((order) => (
                  <option key={order.id} value={order.id}>
                    #{order.id} · {usdcFixed(order.escrowed_usdc)} USDC · expires {timestamp(order.expiry_at)}
                  </option>
                ))}
              </select>
              <span className="tiny muted">{bindingNote}</span>
            </div>
          </div>

          <div className="stack--tight">
            <button
              type="button"
              className="button button--primary"
              onClick={onRun}
              disabled={!canRun || running}
            >
              {running ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Calling {fixture?.slug ?? "the service"}…
                </>
              ) : (
                "Run call"
              )}
            </button>
            <span className="tiny muted">
              {fixture
                ? `the verifier will ${fixture.method === "GET" ? "call" : "post to"} the covenant endpoint and measure it against ${formatBps(fixture.max_rebate_bps)} max rebate`
                : "pick a covenant first"}
            </span>
          </div>
        </div>

        {error ? (
          <p className="banner banner--error" role="alert">
            {error}
          </p>
        ) : null}

        {run === null ? (
          <p className="small muted">
            No call has been run yet. Run one and this panel shows the HTTP status, the latency the
            verifier measured, the schema verdict with each violation, the quote and the split — and
            the trace below shows how each of those was derived.
          </p>
        ) : (
          <div className="stack" aria-live="polite">
            <p className="lede">{run.outcome_summary}</p>

            {endpointMissing ? (
              <p className="banner banner--warn">
                The covenant names <code>{run.outcome.url}</code> and that path answers 404 — the
                verifier serves its built-in services at <code>/api/kernel/&lt;slug&gt;</code>, not at{" "}
                <code>/mock/&lt;slug&gt;</code>. The measurement stands exactly as taken: no body, no
                schema, a breach at the latency shown. Nothing here is adjusted to look better than
                the call was.
              </p>
            ) : null}

            <div className="facts">
              <div>
                <div className="fact__label">HTTP status</div>
                <div className="fact__value">
                  {run.outcome.status === null ? <span className="muted">none</span> : run.outcome.status}
                </div>
              </div>
              <div>
                <div className="fact__label">Measured latency</div>
                <div className="fact__value">{formatDuration(run.outcome.latency_ms)}</div>
              </div>
              <div>
                <div className="fact__label">Response bytes</div>
                <div className="fact__value">{run.outcome.response_bytes}</div>
              </div>
              <div>
                <div className="fact__label">Covenant verdict</div>
                <div className="fact__value fact__value--small">
                  <span className={verdictClass(run.quote.status)}>{verdictLabel(run.quote.status)}</span>
                </div>
              </div>
              <div>
                <div className="fact__label">Escrow</div>
                <div className="fact__value">{run.quote.escrow_usdc}</div>
              </div>
              <div>
                <div className="fact__label">Rebate to caller</div>
                <div className="fact__value">{run.quote.rebate_to_caller_usdc}</div>
              </div>
              <div>
                <div className="fact__label">To provider</div>
                <div className="fact__value">{run.quote.paid_to_provider_usdc}</div>
              </div>
              <div>
                <div className="fact__label">To dependencies</div>
                <div className="fact__value">{run.quote.paid_to_dependencies_usdc}</div>
              </div>
              <div>
                <div className="fact__label">Bond slashed</div>
                <div className="fact__value">{run.quote.bond_slash_usdc}</div>
              </div>
              <div>
                <div className="fact__label">Leaves the contract</div>
                <div className="fact__value">
                  {settlementTotal === null ? <span className="muted">—</span> : unitsToFixed(settlementTotal)}
                </div>
              </div>
              <div>
                <div className="fact__label">Terms from</div>
                <div className="fact__value fact__value--small">
                  {run.terms_source === "record" ? (
                    <span title="the verifier took the terms from the covenant it confirmed onchain">
                      onchain record #{run.service_id ?? "?"}
                    </span>
                  ) : (
                    <span
                      className="muted"
                      title="the verifier used its local fixture defaults, so a signature from this run may not verify against the registered covenant"
                    >
                      fixture defaults
                    </span>
                  )}
                </div>
              </div>
              <div>
                <div className="fact__label">Attested order</div>
                <div className="fact__value fact__value--small">
                  {run.order_id ? `#${run.order_id}` : <span className="muted">none</span>}
                </div>
              </div>
            </div>

            <dl className="kv">
              <dt>Endpoint</dt>
              <dd className="mono wrap-anywhere">{run.outcome.url}</dd>
              <dt>Transport</dt>
              <dd className="mono">
                {run.outcome.timed_out
                  ? "timed out"
                  : run.outcome.transport_error !== null
                    ? run.outcome.transport_error
                    : httpOk(run.outcome)
                      ? "HTTP 2xx, body captured"
                      : "answered, but not a usable 2xx response"}
              </dd>
              <dt>Schema</dt>
              <dd>
                <span className={run.schema.valid ? "tag tag--pass" : "tag tag--breach"}>
                  {run.schema.valid ? "satisfied" : "violated"}
                </span>{" "}
                <span className="tiny muted">{run.schema.checked_against}</span>
                {run.schema.errors.length > 0 ? (
                  <ul className="stack--tight small">
                    {run.schema.errors.map((problem) => (
                      <li key={problem}>
                        <span className="mono">↳ {problem}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </dd>
              <dt>Request hash</dt>
              <dd>
                <span className="hash">{run.outcome.request_hash}</span>{" "}
                <CopyButton value={run.outcome.request_hash} label="request hash" />
              </dd>
              <dt>Response sha256</dt>
              <dd>
                <span className="hash">{run.outcome.response_sha256}</span>{" "}
                <CopyButton value={run.outcome.response_sha256} label="response sha256" />
              </dd>
              <dt>Response keccak</dt>
              <dd>
                <span className="hash">{run.outcome.response_hash}</span>{" "}
                <CopyButton value={run.outcome.response_hash} label="response keccak hash" />
              </dd>
            </dl>

            <SplitTable run={run} providerIndex={providerIndex} />

            {run.notes.map((note) => (
              <p className="banner banner--warn" key={note}>
                {note}
              </p>
            ))}

            {run.outcome.body !== null ? (
              <details>
                <summary>
                  response body · {run.outcome.response_bytes} bytes ·{" "}
                  {shortHash(run.outcome.response_sha256, 8)}
                </summary>
                <pre className="pre">{pretty(run.outcome.body)}</pre>
              </details>
            ) : (
              <p className="small muted">
                No response body was captured, so there is nothing to show — the bytes the digests
                cover are the empty string in that case.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

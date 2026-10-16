import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Hash } from "viem";
import type { CallMode } from "../api";
import { describeError, postExecute, postQuote } from "../api";
import type { WalletController } from "../chain";
import { asAddress, asCalldata, walletErrorMessage } from "../chain";
import type { ArcReceipt } from "../chain";
import type {
  ExecuteResponse,
  FixturePublic,
  LedgerView,
  OrderView,
  PublicConfig,
  QuoteResponse,
} from "../types";
import { formatBps, formatDuration } from "../types";
import { txLink } from "../format";
import { ExecutePanel } from "./ExecutePanel";
import { PayoffCurve } from "./PayoffCurve";
import { TelemetryTrace, buildExecuteTrace, describeReceipt, settleTraceRows, type TraceRow } from "./TelemetryTrace";
import type { TraceLevel } from "./TelemetryTrace";

/**
 * The workbench.
 *
 * It owns three things and nothing else: the covenant under discussion, the
 * latency probe on its payoff curve, and the live call whose result feeds both
 * the trace and (when a wallet is connected and the verifier has bound an order)
 * the onchain settlement.
 */

interface SlaWorkbenchProps {
  config: PublicConfig | null;
  configError: string | null;
  /** The chain read, needed to find the covenant record and any funded order. */
  ledger: LedgerView | null;
  wallet: WalletController;
  onSettled: () => void;
}

type SettleState =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "pending"; hash: Hash }
  | { kind: "confirmed"; hash: Hash; receipt: ArcReceipt }
  | { kind: "failed"; hash: Hash | null; message: string };

const REASON_NO_CALL =
  "Settlement is available once a call has been measured: the verifier returns the exact settleOrder payload for it.";

export function SlaWorkbench({ config, configError, ledger, wallet, onSettled }: SlaWorkbenchProps) {
  const fixtures = useMemo<FixturePublic[]>(() => config?.fixtures ?? [], [config]);
  const [slug, setSlug] = useState<string | null>(null);
  const fixture = fixtures.find((candidate) => candidate.slug === slug) ?? fixtures[0] ?? null;

  /**
   * The onchain covenants this fixture corresponds to, newest registration first.
   *
   * A name can appear more than once on the ledger — re-registering a covenant
   * mints a new id — and the verifier's registry holds whichever registration the
   * deployment recorded. So the interface keeps every candidate and asks the
   * verifier to attest with the newest one first; the accepted id is remembered
   * so a second run does not repeat the walk. Matching is on the interface's own
   * labels (name, endpoint), never on position.
   */
  const covenantCandidates = useMemo(() => {
    if (!fixture || !ledger) return [];
    return ledger.services
      .filter((service) => service.name === fixture.name || service.endpoint_uri.includes(fixture.slug))
      .sort((a, b) => Number(b.id) - Number(a.id));
  }, [fixture, ledger]);

  const covenantRecord = covenantCandidates[0] ?? null;
  const covenantIds = useMemo(
    () =>
      covenantCandidates
        .map((service) => Number(service.id))
        .filter((id) => Number.isSafeInteger(id) && id > 0),
    [covenantCandidates],
  );

  const [acceptedCovenantId, setAcceptedCovenantId] = useState<number | null>(null);

  /**
   * Orders that can be settled by a run against this fixture.
   *
   * An attestation names the provider address, so an order is settlable by this
   * covenant only when its own service has the same provider — which is how a
   * funded order on an earlier registration of the same covenant stays usable.
   */
  const openOrders = useMemo<OrderView[]>(() => {
    if (!ledger || covenantRecord === null) return [];
    const provider = covenantRecord.provider.toLowerCase();
    const serviceIds = new Set(
      ledger.services
        .filter((service) => service.provider.toLowerCase() === provider)
        .map((service) => service.id),
    );
    return ledger.orders.filter((order) => order.status === 1 && serviceIds.has(order.service_id));
  }, [ledger, covenantRecord]);

  const [boundOrderId, setBoundOrderId] = useState<string | null>(null);
  // A selection from another covenant is not a selection: derive the effective
  // value instead of clearing state in an effect.
  const effectiveBoundOrderId = openOrders.some((order) => order.id === boundOrderId)
    ? boundOrderId
    : null;

  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [latency, setLatency] = useState(0);

  const [probe, setProbe] = useState<QuoteResponse | null>(null);
  const [probeLoading, setProbeLoading] = useState(false);
  const probeSeq = useRef(0);

  const [mode, setMode] = useState<CallMode>("normal");
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<ExecuteResponse | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runId, setRunId] = useState(0);

  const [settleRows, setSettleRows] = useState<TraceRow[]>([]);
  const [settle, setSettle] = useState<SettleState>({ kind: "idle" });

  // The covenant's own payoff curve, priced by the verifier at the covenant
  // price. This is also what sets the probe's initial position to the grace edge.
  useEffect(() => {
    if (!fixture) {
      setQuote(null);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setQuoteLoading(true);
    setQuoteError(null);
    setLatency(fixture.grace_latency_ms);
    postQuote(
      { fixture: fixture.slug, latency_ms: fixture.grace_latency_ms, schema_valid: true },
      controller.signal,
    )
      .then((response) => {
        if (!cancelled) setQuote(response);
      })
      .catch((cause: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setQuote(null);
        setQuoteError(describeError(cause));
      })
      .finally(() => {
        if (!cancelled) setQuoteLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fixture]);

  // The marker's figures: ask the verifier for the exact quote at the probed
  // latency. Interpolation covers the gap while the answer is in flight, and the
  // curve labels which of the two is on screen.
  useEffect(() => {
    if (!fixture || !quote) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const seq = probeSeq.current + 1;
      probeSeq.current = seq;
      setProbeLoading(true);
      postQuote({ fixture: fixture.slug, latency_ms: latency, schema_valid: true }, controller.signal)
        .then((response) => {
          if (probeSeq.current === seq) setProbe(response);
        })
        .catch(() => {
          // The sampled curve still stands; the readout falls back to
          // interpolation and says so.
        })
        .finally(() => {
          if (probeSeq.current === seq) setProbeLoading(false);
        });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [fixture, quote, latency]);

  const providerIndex =
    fixture && run && run.quote.split_bps[0] === fixture.provider_split_bps ? 0 : -1;

  const runCall = useCallback(async (): Promise<void> => {
    if (!fixture) return;
    setRunning(true);
    setRunError(null);
    setSettleRows([]);
    setSettle({ kind: "idle" });

    // Binding is what makes a result settleable: the service id selects the
    // record the verifier signs with, and the order id is what the contract
    // checks the signature against.
    const orderBinding = effectiveBoundOrderId === null ? {} : { order_id: effectiveBoundOrderId };
    const ordered = [
      ...(acceptedCovenantId === null ? [] : [acceptedCovenantId]),
      ...covenantIds.filter((id) => id !== acceptedCovenantId),
    ];

    const attempt = async (serviceId: number | null): Promise<ExecuteResponse> =>
      postExecute({
        fixture: fixture.slug,
        mode,
        ...(serviceId === null ? {} : { service_id: serviceId }),
        ...orderBinding,
      });

    try {
      let response: ExecuteResponse | null = null;
      let lastError = "";
      // The registry and the ledger can disagree about which registration is
      // current. A rejected id is refused before the verifier calls anything, so
      // trying the fixture's other candidate ids costs nothing real.
      for (const serviceId of ordered.length === 0 ? [null] : ordered) {
        try {
          response = await attempt(serviceId);
          if (serviceId !== null) setAcceptedCovenantId(serviceId);
          break;
        } catch (cause) {
          lastError = describeError(cause);
          if (!/registry/i.test(lastError)) throw cause;
        }
      }
      if (response === null) throw new Error(lastError);
      setRun(response);
      setRunId((current) => current + 1);
    } catch (cause) {
      setRun(null);
      setRunError(describeError(cause));
    } finally {
      setRunning(false);
    }
  }, [fixture, mode, covenantIds, acceptedCovenantId, effectiveBoundOrderId]);

  const rows = useMemo<TraceRow[]>(() => {
    const executeRows = run ? buildExecuteTrace(run, fixture, providerIndex) : [];
    return [...executeRows, ...settleRows];
  }, [run, fixture, providerIndex, settleRows]);

  const contract = asAddress(config?.contract ?? null);
  const calldata = asCalldata(run?.attestation?.calldata ?? null);
  const canSettle =
    contract !== null && calldata !== null && wallet.status === "connected" && wallet.onSettlementChain;

  const settleOnchain = useCallback(async (): Promise<void> => {
    if (!contract || !calldata) return;
    const startedAt = performance.now();
    const append = (level: TraceLevel, text: ReactNode): void => {
      const elapsed = `${Math.max(0, Math.round(performance.now() - startedAt))}ms`;
      setSettleRows((current) => [...current, ...settleTraceRows([{ t: elapsed, level, text }])]);
    };

    setSettle({ kind: "signing" });
    let hash: Hash | null = null;
    append(
      "dim",
      <>
        eth_sendTransaction to {contract} · from {wallet.address ?? "the connected account"}
      </>,
    );
    try {
      hash = await wallet.sendSettlement(contract, calldata);
      setSettle({ kind: "pending", hash });
      append("key", <>submitted {hash} · waiting for a receipt</>);
      const receipt = await wallet.waitForSettlement(hash);
      if (receipt === null) {
        append(
          "warn",
          <>
            no receipt after 90 s on {wallet.chain.name}: the transaction is broadcast and may still
            be pending
          </>,
        );
        return;
      }
      append(receipt.status === "success" ? "ok" : "err", describeReceipt(receipt));
      if (receipt.status === "success") {
        setSettle({ kind: "confirmed", hash, receipt });
        onSettled();
      } else {
        setSettle({ kind: "failed", hash, message: "the transaction was mined but reverted" });
      }
    } catch (cause) {
      const message = walletErrorMessage(cause);
      append("err", <>{message}</>);
      setSettle({ kind: "failed", hash, message });
    }
  }, [contract, calldata, wallet, onSettled]);

  const settleHash: Hash | null =
    settle.kind === "pending" || settle.kind === "confirmed" || settle.kind === "failed"
      ? settle.hash
      : null;
  const settleLink = txLink(wallet.chain.blockExplorers?.default.url ?? null, settleHash);

  /**
   * Why there is nothing to broadcast, in the order the reasons can occur. Each
   * branch names the missing fact rather than offering a button that cannot work.
   */
  const noCalldataReason: ReactNode =
    covenantIds.length === 0 ? (
      <>
        Nothing to send: the ledger holds no covenant record matching this fixture, so the verifier
        has no service id it could attest with.
      </>
    ) : run === null || run.order_id == null ? (
      <>
        Nothing to send from this run: it was measured without an order binding. Choose a funded
        order above, run the call again, and the verifier returns <code>settleOrder</code> calldata
        for it.
      </>
    ) : (
      <>
        The verifier returned no <code>settleOrder</code> calldata for order #{run.order_id}
        {run.notes.length > 0 ? `: ${run.notes.join(" ")}` : "."}
      </>
    );

  if (!config) {
    return (
      <section className="panel" aria-labelledby="workbench-heading">
        <div className="panel__head">
          <h2 className="panel__title" id="workbench-heading">
            SLA workbench
          </h2>
        </div>
        <div className="panel__body stack">
          <p className="banner banner--error" role="alert">
            The covenant list and the contract address come from the verifier at{" "}
            <code>/api/config</code>, which could not be read
            {configError ? `: ${configError}` : "."}
          </p>
          <p className="small muted">
            Start the verifier (<code>cargo run</code> in <code>verifier/</code>, listening on
            :8787) and reload. Until then this panel deliberately shows nothing rather than
            inventing a covenant to price.
          </p>
        </div>
      </section>
    );
  }

  return (
    <div className="stack">
      <section className="panel" aria-labelledby="workbench-heading">
        <div className="panel__head">
          <h2 className="panel__title" id="workbench-heading">
            SLA workbench
          </h2>
          <span className="panel__note">
            {fixtures.length} covenant{fixtures.length === 1 ? "" : "s"} published by this deployment
          </span>
        </div>
        <div className="panel__body stack">
          {fixture === null ? (
            <p className="small muted">
              This deployment publishes no covenants, so there is nothing to price. Covenants come
              from the verifier&rsquo;s own configuration.
            </p>
          ) : (
            <fieldset className="picker">
              <legend className="sr-only">Choose a covenant</legend>
              {fixtures.map((candidate) => (
                <label
                  key={candidate.slug}
                  className="picker__row"
                  data-selected={candidate.slug === fixture.slug}
                >
                  <input
                    type="radio"
                    name="covenant"
                    value={candidate.slug}
                    checked={candidate.slug === fixture.slug}
                    onChange={() => setSlug(candidate.slug)}
                  />
                  <span>
                    <span className="picker__title">
                      {candidate.name}
                      {/*
                        What produces the response changes what a latency
                        promise means, so it is stated rather than implied.
                      */}
                      <span
                        className={`tag tag--inline ${candidate.backed_by === "jev" ? "tag--verified" : "tag--muted"}`}
                        title={candidate.backing}
                      >
                        {candidate.backed_by === "jev" ? "model-backed" : "deterministic"}
                      </span>
                    </span>
                    <span className="picker__note">{candidate.summary}</span>
                    <span className="picker__facts">
                      <span>{candidate.price_usdc} USDC per call</span>
                      <span>grace {formatDuration(candidate.grace_latency_ms)}</span>
                      <span>hard {formatDuration(candidate.hard_timeout_ms)}</span>
                      <span>max rebate {formatBps(candidate.max_rebate_bps)}</span>
                      <span>
                        split {formatBps(candidate.provider_split_bps)} /{" "}
                        {formatBps(10_000 - candidate.provider_split_bps)}
                      </span>
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          {quoteError ? (
            <p className="banner banner--error" role="alert">
              The verifier could not price this covenant: {quoteError}
            </p>
          ) : null}
        </div>
      </section>

      {fixture ? (
        <section className="panel" aria-labelledby="curve-heading">
          <div className="panel__head">
            <h2 className="panel__title" id="curve-heading">
              Payoff curve
            </h2>
            <span className="panel__note">
              {quoteLoading ? (
                <>
                  <span className="spinner" aria-hidden="true" /> pricing the covenant…
                </>
              ) : quote ? (
                `escrow ${quote.escrow_usdc} USDC · priced by the verifier`
              ) : (
                "no price available"
              )}
            </span>
          </div>
          <div className="panel__body">
            {quote ? (
              <PayoffCurve
                curve={quote.curve}
                escrowUsdc={quote.escrow_usdc}
                graceMs={fixture.grace_latency_ms}
                hardMs={fixture.hard_timeout_ms}
                maxRebateBps={fixture.max_rebate_bps}
                latency={latency}
                onLatency={(ms) => setLatency(ms)}
                probe={probe}
                probeLoading={probeLoading}
                measured={
                  run && run.fixture === fixture.slug
                    ? { latencyMs: run.outcome.latency_ms, verdict: run.quote.status }
                    : null
                }
              />
            ) : quoteLoading ? (
              <p className="small muted">
                <span className="spinner" aria-hidden="true" /> Asking the verifier to price this
                covenant…
              </p>
            ) : (
              <p className="small muted">
                No curve to draw: the verifier has not returned the sampled settlement points for
                this covenant.
              </p>
            )}
          </div>
        </section>
      ) : null}

      <ExecutePanel
        fixture={fixture}
        mode={mode}
        onMode={setMode}
        onRun={() => void runCall()}
        running={running}
        run={run}
        error={runError}
        canRun={fixture !== null}
        orders={openOrders}
        boundOrderId={effectiveBoundOrderId}
        onBindOrder={setBoundOrderId}
        covenantIds={covenantIds}
      />

      <TelemetryTrace
        rows={rows}
        runId={runId}
        title="Telemetry trace"
        note="revealed in order from this run's response"
        empty={
          <>
            no call has run yet — this trace will show the request hash, the latency the verifier
            measured, the response digests, the schema verdict, the quote, the split and the exact
            settleOrder calldata
          </>
        }
      >
        <div className="stack--tight">
          <hr className="hairline" />
          {run === null ? (
            <p className="small muted">{REASON_NO_CALL}</p>
          ) : wallet.status !== "connected" ? (
            <p className="small muted">
              Connect a wallet to settle this order onchain. The verifier holds no funds and no key
              that can move them: the settlement is signed and sent by the caller.
            </p>
          ) : calldata === null || contract === null ? (
            <div className="banner banner--warn">
              <span>{noCalldataReason}</span>
            </div>
          ) : (
            <>
              <div className="row--between">
                <div className="row">
                  <button
                    type="button"
                    className="button button--primary"
                    onClick={() => void settleOnchain()}
                    disabled={!canSettle || settle.kind === "signing" || settle.kind === "pending"}
                  >
                    {settle.kind === "signing" ? (
                      <>
                        <span className="spinner" aria-hidden="true" /> Waiting for the wallet…
                      </>
                    ) : settle.kind === "pending" ? (
                      <>
                        <span className="spinner" aria-hidden="true" /> Settling…
                      </>
                    ) : (
                      "Settle onchain"
                    )}
                  </button>
                  {!wallet.onSettlementChain ? (
                    <button type="button" className="button" onClick={() => void wallet.switchToChain()}>
                      Switch to {wallet.chain.name}
                    </button>
                  ) : null}
                  {settleLink ? (
                    <a href={settleLink} target="_blank" rel="noreferrer noopener" className="mono small">
                      {settleHash ? `${settleHash.slice(0, 10)}…${settleHash.slice(-6)}` : ""} ↗
                    </a>
                  ) : null}
                </div>
                <span className="tiny muted">
                  settleOrder is sent from your wallet; the verifier never holds the funds
                </span>
              </div>

              {settle.kind === "pending" ? (
                <p className="small">
                  Submitted <span className="mono">{settle.hash}</span> — waiting for a receipt. A
                  broadcast transaction is not a settlement until a block includes it.
                </p>
              ) : null}
              {settle.kind === "confirmed" ? (
                <p className="small">
                  <span className="tag tag--pass">confirmed</span> in block{" "}
                  <span className="mono">{settle.receipt.blockNumber ?? "—"}</span> · gas used{" "}
                  <span className="mono">{settle.receipt.gasUsed?.toString() ?? "—"}</span>
                </p>
              ) : null}
              {settle.kind === "failed" ? (
                <p className="banner banner--error" role="alert">
                  {settle.message}
                </p>
              ) : null}

              <details>
                <summary>
                  settleOrder calldata · {Math.max(0, (calldata.length - 2) / 2)} bytes
                </summary>
                <pre className="pre">{calldata}</pre>
              </details>
            </>
          )}
        </div>
      </TelemetryTrace>
    </div>
  );
}

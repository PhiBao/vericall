import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { keccak256, toHex, type Hash } from "viem";
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
import { formatBps, formatDuration, verdictOfStatus } from "../types";
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
  /** Increments when the hero asks for a run; the panel runs on every change. */
  runSignal: number;
}

type SettleState =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "pending"; hash: Hash }
  | { kind: "confirmed"; hash: Hash; receipt: ArcReceipt }
  | { kind: "failed"; hash: Hash | null; message: string };

const REASON_NO_CALL =
  "Settlement is available once a call has been measured: the verifier returns the exact settleOrder payload for it.";

export function SlaWorkbench({ config, configError, ledger, wallet, onSettled, runSignal }: SlaWorkbenchProps) {
  const fixtures = useMemo<FixturePublic[]>(() => config?.fixtures ?? [], [config]);
  const [slug, setSlug] = useState<string | null>(null);
  const preferred = useMemo(() => {
    const external = fixtures.find((f) => f.backed_by === "external");
    const model = fixtures.find((f) => f.backed_by === "jev");
    return external ?? model ?? fixtures[0] ?? null;
  }, [fixtures]);
  const fixture = fixtures.find((candidate) => candidate.slug === slug) ?? preferred;

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
  /**
   * Settled calls to this covenant, as the chain recorded them.
   *
   * Filtered to the covenant's onchain ids so a re-registration does not mix two
   * price regimes into one distribution.
   */
  const history = useMemo(() => {
    if (!fixture || !ledger) return [];
    const ids = new Set(
      ledger.services
        .filter((service) => service.name === fixture.name || service.endpoint_uri.includes(fixture.slug))
        .map((service) => service.id),
    );
    return ledger.orders
      .filter((order) => ids.has(order.service_id))
      .map((order) => ({
        latencyMs: order.measured_latency_ms,
        verdict: verdictOfStatus(order.status),
      }));
  }, [fixture, ledger]);

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
  /**
   * The request body, as the caller will commit it.
   *
   * Starting a call means writing down what is being bought: these exact bytes
   * are hashed into the order, so the verifier can later prove it sent what the
   * caller asked for. Seeded from the service's own sample so the field is never
   * an empty box.
   */
  const [requestText, setRequestText] = useState<string>("");
  useEffect(() => {
    if (!fixture) return;
    setRequestText((current) => (current.trim() === "" ? (fixture.sample_request ?? "{}") : current));
    // Reset when the covenant changes: a body written for one service is not a
    // request the next one would accept.
  }, [fixture?.slug]);

  const [escrowedBody, setEscrowedBody] = useState<string | null>(null);
  /** The commitment this session made, so the run binds to *its* order. */
  const [escrowedHash, setEscrowedHash] = useState<string | null>(null);

  /**
   * The order this session escrowed, once the chain shows it.
   *
   * The wallet's transaction lands before the view of the chain catches up, so
   * the caller has to be waited for rather than shown an empty list: after
   * escrowing, look for our own commitment until it appears. A caller should
   * never have to reload a page to see money they just committed.
   */
  const ownOrder = useMemo(
    () =>
      escrowedHash === null
        ? null
        : (openOrders.find(
            (order) => order.request_hash.toLowerCase() === escrowedHash.toLowerCase(),
          ) ?? null),
    [escrowedHash, openOrders],
  );
  const awaitingOrder = escrowedHash !== null && ownOrder === null;

  useEffect(() => {
    if (!awaitingOrder) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started > 60_000) {
        window.clearInterval(timer);
        return;
      }
      onSettled();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [awaitingOrder, onSettled]);
  /**
   * Bind the order this session escrowed.
   *
   * By commitment, not by position: the ledger holds orders from other sessions,
   * and binding the newest of those would attest to a request this session never
   * wrote — which the verifier refuses, correctly, leaving the caller with an
   * unexplained 409. A selection the user made by hand stands, but only while it
   * is still a real order.
   */
  useEffect(() => {
    if (ownOrder === null) return;
    setBoundOrderId((current) =>
      current !== null && openOrders.some((order) => order.id === current) ? current : ownOrder.id,
    );
  }, [ownOrder, openOrders]);

  const [escrowState, setEscrowState] = useState<
    { kind: "idle" } | { kind: "signing" } | { kind: "done"; orderId: string; hash: string } | { kind: "failed"; message: string }
  >({ kind: "idle" });
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

  /**
   * The hero's button runs a call, but a call is only *bound* to a covenant once
   * the ledger has been read. Pressing it during the first read would produce an
   * unbound measurement — real, but weaker than it should be — so the request is
   * held until the chain state arrives.
   */
  const seenSignal = useRef(runSignal);
  const waitingForLedger = useRef(false);
  useEffect(() => {
    if (runSignal === seenSignal.current) return;
    seenSignal.current = runSignal;
    if (!ledger) {
      waitingForLedger.current = true;
      return;
    }
    void runCall();
    // `runCall` is stable for a given fixture; re-running on its identity would
    // fire a second time when the fixture object is rebuilt by a ledger refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runSignal]);

  useEffect(() => {
    if (!ledger || !waitingForLedger.current) return;
    waitingForLedger.current = false;
    void runCall();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledger]);

  /**
   * The URL the covenant names. A third-party service publishes an absolute
   * endpoint; the others are served by the verifier under its public base. The
   * request hash must be taken over this exact string, or the verifier's check
   * will — correctly — refuse to sign.
   */
  const covenantUrl = useMemo(() => {
    if (!fixture) return null;
    if (fixture.endpoint) return fixture.endpoint;
    const base = config?.mock_base_url;
    return base ? `${base.replace(/\/$/, "")}/mock/${fixture.slug}` : null;
  }, [fixture, config?.mock_base_url]);

  /**
   * Escrow this call from the connected wallet.
   *
   * The commitment comes first: the hash of the request goes onchain, and only
   * then can a call be run and attested to. A covenant's newest registration is
   * used, matching what the verifier will attest against.
   */
  const escrowCall = useCallback(async (): Promise<void> => {
    if (!fixture || !covenantRecord || !covenantUrl) return;
    const target = asAddress(config?.contract ?? null);
    if (target === null) {
      setEscrowState({ kind: "failed", message: "the verifier has not reported a clearinghouse address" });
      return;
    }
    setEscrowState({ kind: "signing" });
    try {
      const body = requestText.trim() === "" ? "{}" : requestText;
      const serviceId = BigInt(covenantRecord.id);
      const requestHash = keccak256(toHex(`${covenantUrl}\n${body}`));
      const usdc = asAddress(config?.usdc ?? null);
      if (usdc === null) {
        setEscrowState({ kind: "failed", message: "the verifier has not reported a USDC address" });
        return;
      }
      const price = BigInt(Math.round(Number(fixture.price_usdc) * 1_000_000));
      // The wallet grants the allowance if it needs one, then escrows. Both are
      // signed by the caller; the verifier never touches the money.
      const { orderHash } = await wallet.escrowCall({
        contract: target,
        usdc,
        serviceId,
        requestHash,
        ttlSeconds: 900n,
        price,
      });
      setEscrowedBody(body);
      setEscrowedHash(requestHash);
      setEscrowState({ kind: "done", orderId: "", hash: orderHash });
      // The order list comes from the chain; ask for it rather than assuming the
      // index is current.
      onSettled();
    } catch (cause) {
      setEscrowState({
        kind: "failed",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, [fixture, covenantRecord, covenantUrl, config?.contract, config?.usdc, requestText, wallet, onSettled]);

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
        // Only a request the caller wrote down here can be attested to, so the
        // body travels with the request for the verifier to check.
        ...(escrowedBody === null ? {} : { body_raw: escrowedBody }),
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
            Run a call
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
            Run a call
          </h2>
          <span className="panel__note">
            {fixtures.length} published covenants · pick one, then run it
          </span>
        </div>
        <div className="panel__body stack">
          {fixture === null ? (
            <p className="small muted">
              This deployment publishes no covenants, so there is nothing to price. Covenants come
              from the verifier&rsquo;s own configuration.
            </p>
          ) : (
            <div className="rail">
              <div className="rail__label" id="covenant-rail-label">
                Covenant
              </div>
              {/*
                A rail rather than a list: six services stacked with their terms
                pushes the curve and the runner below the fold, and the first
                thing a reader should meet is the selected covenant's terms, not a
                catalogue. Native radio inputs, visually hidden, so arrow keys and
                screen readers still work.
              */}
              <div className="rail__options" role="radiogroup" aria-labelledby="covenant-rail-label">
                {fixtures.map((candidate) => (
                  <label
                    key={candidate.slug}
                    className="rail__option"
                    data-selected={candidate.slug === fixture.slug}
                    title={candidate.backing}
                  >
                    <input
                      className="sr-only"
                      type="radio"
                      name="covenant"
                      value={candidate.slug}
                      checked={candidate.slug === fixture.slug}
                      onChange={() => setSlug(candidate.slug)}
                    />
                    <span className="rail__name">{candidate.name}</span>
                    <span className="rail__price mono">{candidate.price_usdc}</span>
                    <span
                      className={`rail__kind rail__kind--${candidate.backed_by}`}
                      aria-label={
                        candidate.backed_by === "jev"
                          ? "model-backed"
                          : candidate.backed_by === "external"
                            ? "third-party API"
                            : "reference service"
                      }
                    />
                  </label>
                ))}
              </div>

              <div className="rail__detail">
                <p className="rail__summary">{fixture.summary}</p>
                <p className="rail__facts mono">
                  <span>{fixture.price_usdc} USDC per call</span>
                  <span aria-hidden="true">·</span>
                  <span>grace {formatDuration(fixture.grace_latency_ms)}</span>
                  <span aria-hidden="true">·</span>
                  <span>hard {formatDuration(fixture.hard_timeout_ms)}</span>
                  <span aria-hidden="true">·</span>
                  <span>max rebate {formatBps(fixture.max_rebate_bps)}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    split {formatBps(fixture.provider_split_bps)} /{" "}
                    {formatBps(10_000 - fixture.provider_split_bps)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className={`rail__badge rail__badge--${fixture.backed_by}`}>
                    {fixture.backed_by === "jev"
                      ? "model-backed"
                      : fixture.backed_by === "external"
                        ? "third-party API"
                        : "reference service"}
                  </span>
                </p>
              </div>
            </div>
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
                history={history}
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

      <div id="run">
        {/*
          Starting a call is the caller's commitment, so it comes first: the
          request is written here, hashed, and escrowed onchain. Only then can a
          call be run and attested to — which is why the button below is the one
          that creates the order rather than a script.
        */}
        <section className="panel" aria-labelledby="start-heading">
          <div className="panel__head">
            <h2 className="panel__title" id="start-heading">
              Start a call
            </h2>
            <span className="panel__note">
              the request is committed onchain before the call runs
            </span>
          </div>
          <div className="panel__body stack">
            <div className="field">
              <label htmlFor="request-body">Request</label>
              <textarea
                id="request-body"
                className="mono"
                rows={3}
                spellCheck={false}
                value={requestText}
                onChange={(event) => setRequestText(event.target.value)}
                disabled={escrowedBody !== null}
              />
              <span className="tiny muted">
                These exact bytes are hashed into the order. The verifier sends them and refuses
                to attest to anything else, so what the contract judges is what was written here.
              </span>
            </div>

            <div className="row--between">
              <div className="row">
                <button
                  id="escrow-call"
                  type="button"
                  className="button button--primary"
                  onClick={() => void escrowCall()}
                  disabled={
                    wallet.status !== "connected" ||
                    wallet.onSettlementChain !== true ||
                    covenantRecord === null ||
                    escrowState.kind === "signing" ||
                    escrowedBody !== null
                  }
                >
                  {escrowState.kind === "signing"
                    ? "Waiting for the wallet…"
                    : escrowedBody !== null
                      ? "Escrowed"
                      : `Escrow ${fixture.price_usdc} USDC`}
                </button>
                {escrowedBody !== null ? (
                  <button
                    type="button"
                    className="button button--quiet"
                    onClick={() => {
                      setEscrowedBody(null);
                      setEscrowedHash(null);
                      setEscrowState({ kind: "idle" });
                      setBoundOrderId(null);
                    }}
                  >
                    start another
                  </button>
                ) : null}
              </div>
              <span className="tiny muted">
                {wallet.status !== "connected"
                  ? "connect a wallet to fund a call"
                  : covenantRecord === null
                    ? "the ledger holds no covenant this request can be escrowed against"
                    : "createOrder is sent from your wallet; the verifier never holds the funds"}
              </span>
            </div>

            {escrowState.kind === "failed" ? (
              <p className="banner banner--error" role="alert">
                {escrowState.message}
              </p>
            ) : null}
            {escrowState.kind === "done" ? (
              awaitingOrder ? (
                <p className="small">
                  <span className="spinner" aria-hidden="true" /> Escrowed. Waiting for Arc to show
                  the order before the call runs — this clears in a moment.
                </p>
              ) : (
                <p className="small">
                  Escrowed. Run the call below and the verifier will attest to this order —{" "}
                  <span className="mono">{escrowState.hash.slice(0, 12)}…</span>
                </p>
              )
            ) : null}
          </div>
        </section>

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
      </div>

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
                    id="settle-order"
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

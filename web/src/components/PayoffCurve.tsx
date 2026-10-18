import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { CurvePoint, QuoteResponse, Verdict } from "../types";
import { formatBps, formatDuration, verdictClass, verdictLabel } from "../types";
import { unitsToFixed, usdcToUnits } from "../format";

/**
 * The settlement payoff curve, drawn from the verifier's own samples.
 *
 * Two rules keep this honest:
 *
 * - The line is drawn only through points the verifier returned. Its grid stops
 *   one millisecond past the hard timeout; everything to the right of that is
 *   the same breach branch, so the final segment repeats the verifier's own last
 *   sample. Nothing is extrapolated from a formula re-implemented here.
 * - Floating point is used for pixel geometry only. Every figure a reader can
 *   read comes from the exact decimal strings in the API response, interpolated
 *   in 6-decimal base units with `bigint`, because the rebate really is
 *   piecewise linear between the sampled points.
 */

export interface MappedPoint {
  latency: number;
  rebate: string;
  provider: string;
  dependencies: string;
  verdict: Verdict;
}

/** What the marker readout shows, and where the figures came from. */
interface Shown {
  latency: number;
  rebate: string;
  provider: string;
  dependencies: string;
  bondSlash: string | null;
  verdict: Verdict;
  source: string;
}

interface PayoffCurveProps {
  curve: CurvePoint[];
  escrowUsdc: string;
  graceMs: number;
  hardMs: number;
  maxRebateBps: number;
  latency: number;
  onLatency: (ms: number) => void;
  /** The verifier's exact quote at `latency`, when that request has landed. */
  probe: QuoteResponse | null;
  probeLoading: boolean;
  /** The last executed call, so a real measurement lands on the curve. */
  measured: { latencyMs: number; verdict: Verdict } | null;
  /**
   * Every settled call to this covenant, placed where it actually landed. This is
   * what turns the drawing from an illustration of the terms into a picture of
   * how the terms have been used.
   */
  history: { latencyMs: number; verdict: Verdict }[];
}

const PAD = { top: 24, right: 16, bottom: 38, left: 66 };

/** USDC decimal string → a number for pixel geometry only. */
const geometryValue = (value: string): number => Number(usdcToUnits(value) ?? 0n) / 1_000_000;

/** Exact linear interpolation in 6-decimal base units. */
function lerpUnits(from: string, to: string, latA: number, latB: number, at: number): string | null {
  const a = usdcToUnits(from);
  const b = usdcToUnits(to);
  if (a === null || b === null) return null;
  if (latB === latA) return from;
  const span = BigInt(latB - latA);
  const offset = BigInt(Math.min(Math.max(at, latA), latB) - latA);
  return unitsToFixed(a + ((b - a) * offset) / span);
}

function sampleBetween(template: CurvePoint, latency: number, value: string): MappedPoint {
  return {
    latency,
    rebate: value,
    provider: template.to_provider_usdc,
    dependencies: template.to_dependencies_usdc,
    verdict: template.status,
  };
}

/**
 * Latency alone decides between pass, degraded and breach *for a schema-valid
 * response*. A schema violation breaches at any latency, which is a fact only
 * the measured call can supply — the curve is priced as if it did not happen.
 */
function verdictAt(latency: number, rebate: string, hardMs: number): Verdict {
  if (latency > hardMs) return "breach";
  return usdcToUnits(rebate) === 0n ? "pass" : "degraded";
}

/**
 * The value of the covenant at an arbitrary latency.
 *
 * Below the grace edge the samples are identical, so the pass branch is exact.
 * Inside the degraded band the rebate is linear and interpolation between the
 * verifier's own samples recovers it exactly (to the base unit). Past the hard
 * timeout the branch is constant, so the last breach sample is the answer — a
 * step, not a slope.
 */
function mapAt(curve: CurvePoint[], latency: number, hardMs: number): MappedPoint | null {
  if (curve.length === 0) return null;
  const samples = [...curve].sort((a, b) => a.latency_ms - b.latency_ms);
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return null;
  if (latency <= first.latency_ms) {
    return sampleBetween(first, latency, first.rebate_usdc);
  }
  if (latency > hardMs) {
    // The first sample past the hard edge is the breach branch, and it is flat
    // from there to the end of the plot.
    const breach = samples.find((s) => s.latency_ms > hardMs) ?? last;
    return sampleBetween(breach, latency, breach.rebate_usdc);
  }
  let lo = first;
  let hi = last;
  for (let i = 0; i < samples.length - 1; i += 1) {
    const current = samples[i];
    const next = samples[i + 1];
    if (!current || !next) break;
    if (current.latency_ms <= latency && next.latency_ms >= latency) {
      lo = current;
      hi = next;
      break;
    }
  }
  const rebate =
    lerpUnits(lo.rebate_usdc, hi.rebate_usdc, lo.latency_ms, hi.latency_ms, latency) ??
    lo.rebate_usdc;
  const provider =
    lerpUnits(lo.to_provider_usdc, hi.to_provider_usdc, lo.latency_ms, hi.latency_ms, latency) ??
    lo.to_provider_usdc;
  const dependencies =
    lerpUnits(
      lo.to_dependencies_usdc,
      hi.to_dependencies_usdc,
      lo.latency_ms,
      hi.latency_ms,
      latency,
    ) ?? lo.to_dependencies_usdc;
  return { latency, rebate, provider, dependencies, verdict: lo.status };
}

/** Measure the plot so type stays at a legible size on a 380px screen. */
function useContainerWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(760);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = (): void => {
      const next = Math.round(element.getBoundingClientRect().width);
      if (next > 0) setWidth(Math.max(300, next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

export function PayoffCurve({
  curve,
  escrowUsdc,
  graceMs,
  hardMs,
  maxRebateBps,
  latency,
  onLatency,
  probe,
  probeLoading,
  measured,
  history,
}: PayoffCurveProps) {
  const { ref, width } = useContainerWidth();

  const xMax = Math.max(1, Math.ceil(hardMs * 1.1));
  const height = width < 460 ? 230 : 300;
  const plotWidth = Math.max(120, width - PAD.left - PAD.right);
  const plotHeight = height - PAD.top - PAD.bottom;

  const escrowUnits = usdcToUnits(escrowUsdc) ?? 0n;
  const escrowValue = Number(escrowUnits) / 1_000_000;

  const x = (ms: number): number =>
    PAD.left + (Math.min(Math.max(ms, 0), xMax) / xMax) * plotWidth;
  const y = (usdc: number): number => {
    if (escrowValue <= 0) return PAD.top + plotHeight;
    const clamped = Math.min(Math.max(usdc, 0), escrowValue);
    return PAD.top + plotHeight - (clamped / escrowValue) * plotHeight;
  };

  const series = useMemo(() => {
    const samples = [...curve].sort((a, b) => a.latency_ms - b.latency_ms);
    const last = samples[samples.length - 1];
    const build = (pick: (point: CurvePoint) => string) => {
      const points = samples.map((sample) => ({
        latency: sample.latency_ms,
        value: geometryValue(pick(sample)),
      }));
      if (last && last.latency_ms < xMax) {
        points.push({ latency: xMax, value: geometryValue(pick(last)) });
      }
      return points;
    };
    return [
      { key: "rebate", className: "curve__rebate", points: build((p) => p.rebate_usdc) },
      { key: "provider", className: "curve__provider", points: build((p) => p.to_provider_usdc) },
      {
        key: "dependencies",
        className: "curve__dependency",
        points: build((p) => p.to_dependencies_usdc),
      },
    ];
  }, [curve, xMax]);

  const path = (points: Array<{ latency: number; value: number }>): string =>
    points
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"}${x(point.latency).toFixed(1)} ${y(point.value).toFixed(1)}`,
      )
      .join(" ");

  // The readout: the verifier's own quote when it matches this latency, and the
  // interpolated mapping otherwise. The label says which one is on screen.
  const shown = useMemo<Shown | null>(() => {
    if (probe && probe.latency_ms === latency) {
      return {
        latency: probe.latency_ms,
        rebate: probe.rebate_to_caller_usdc,
        provider: probe.paid_to_provider_usdc,
        dependencies: probe.paid_to_dependencies_usdc,
        bondSlash: probe.bond_slash_usdc,
        verdict: probe.status,
        source: "the verifier’s quote for this latency",
      };
    }
    const mapped = mapAt(curve, latency, hardMs);
    if (!mapped) return null;
    return {
      latency: mapped.latency,
      rebate: mapped.rebate,
      provider: mapped.provider,
      dependencies: mapped.dependencies,
      bondSlash: null,
      verdict: verdictAt(latency, mapped.rebate, hardMs),
      source: "interpolated between the verifier’s sampled points",
    };
  }, [probe, curve, hardMs, latency]);

  /**
   * The latency distribution of this covenant's settled calls.
   *
   * Nearest-rank percentiles over the measured milliseconds, so "p95" means a
   * real call a reader can find in the ledger, not an interpolated figure.
   */
  const distribution = useMemo(() => {
    if (history.length === 0) return null;
    const sorted = [...history].map((h) => h.latencyMs).sort((a, b) => a - b);
    const rank = (p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
    return {
      n: sorted.length,
      p50: rank(0.5),
      p95: rank(0.95),
      pass: history.filter((h) => h.verdict === "pass").length,
      degraded: history.filter((h) => h.verdict === "degraded").length,
      breach: history.filter((h) => h.verdict === "breach").length,
      reclaimed: history.filter((h) => h.verdict === "reclaimed").length,
    };
  }, [history]);

  const coarse = Math.max(1, Math.round(xMax / 20));
  const measuredX = measured ? x(measured.latencyMs) : null;

  const yTicks = [0, 1, 2, 3, 4].map((index) => {
    const fraction = index / 4;
    return {
      value: y(escrowValue * fraction),
      label: unitsToFixed((escrowUnits * BigInt(index)) / 4n),
    };
  });

  // Place the x labels left to right and drop any that would collide with the one
  // before it. At 380px the hard edge and the window's end sit a few pixels apart,
  // and two overlapping numbers are worse than one label plus an axis title that
  // states the window.
  const approxTextWidth = (text: string): number => text.length * 6.2;
  const xTickCandidates = [
    { value: 0, label: "0", anchor: "start" as const },
    { value: graceMs, label: `grace ${formatDuration(graceMs)}`, anchor: "middle" as const },
    { value: hardMs, label: `hard ${formatDuration(hardMs)}`, anchor: "middle" as const },
    { value: xMax, label: formatDuration(xMax), anchor: "end" as const },
  ];
  const xTicks: Array<{ value: number; label: string; anchor: "middle" | "end" | "start" }> = [];
  let lastRight = Number.NEGATIVE_INFINITY;
  for (const tick of xTickCandidates) {
    const width = approxTextWidth(tick.label);
    const centre = x(tick.value);
    const left =
      tick.anchor === "start" ? centre : tick.anchor === "end" ? centre - width : centre - width / 2;
    if (left >= lastRight + 10) {
      xTicks.push(tick);
      lastRight = left + width;
    }
  }
  const endIsLabelled = xTicks.some((tick) => tick.value === xMax);

  const onRangeKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // Coarse adjustment without a second control: shift + arrow jumps a
    // twentieth of the plotted window instead of one millisecond.
    if (!event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = (event.key === "ArrowRight" ? 1 : -1) * coarse;
    onLatency(Math.min(xMax, Math.max(0, latency + delta)));
  };

  const description = shown
    ? `Escrow ${escrowUsdc} USDC. At ${shown.latency} ms the caller is rebated ${shown.rebate} USDC, the provider receives ${shown.provider} USDC and dependencies receive ${shown.dependencies} USDC.`
    : "No covenant is selected.";

  return (
    <div className="stack" ref={ref}>
      <div className="curve-legend">
        <span className="key k-rebate">
          <i aria-hidden="true" /> rebate to caller
        </span>
        <span className="key k-provider">
          <i aria-hidden="true" /> provider share
        </span>
        <span className="key k-dependency">
          <i aria-hidden="true" /> dependency share
        </span>
        <span className="key k-escrow">
          <i aria-hidden="true" /> full escrow
        </span>
      </div>

      <svg
        className="curve"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Settlement payoff curve for a ${escrowUsdc} USDC escrow`}
      >
        <title>Payoff curve — latency against USDC</title>
        <desc>{description}</desc>

        {/* Zones: the three branches of the covenant, in the order they apply. */}
        <rect
          className="curve__zone--pass"
          x={x(0)}
          y={PAD.top}
          width={Math.max(0, x(graceMs) - x(0))}
          height={plotHeight}
        />
        <rect
          className="curve__zone--degraded"
          x={x(graceMs)}
          y={PAD.top}
          width={Math.max(0, x(hardMs) - x(graceMs))}
          height={plotHeight}
        />
        <rect
          className="curve__zone--breach"
          x={x(hardMs)}
          y={PAD.top}
          width={Math.max(0, x(xMax) - x(hardMs))}
          height={plotHeight}
        />

        {/* Grid and axes. */}
        {yTicks.map((tick) => (
          <g key={`y-${tick.label}`}>
            <line
              className="curve__grid"
              x1={PAD.left}
              x2={PAD.left + plotWidth}
              y1={tick.value}
              y2={tick.value}
            />
            <text className="curve__tick-label" x={PAD.left - 8} y={tick.value + 4} textAnchor="end">
              {tick.label}
            </text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <g key={`x-${tick.label}`}>
            <line
              className="curve__grid"
              x1={x(tick.value)}
              x2={x(tick.value)}
              y1={PAD.top}
              y2={PAD.top + plotHeight}
            />
            <text
              className="curve__tick-label"
              x={x(tick.value)}
              y={PAD.top + plotHeight + 16}
              textAnchor={tick.anchor}
            >
              {tick.label}
            </text>
          </g>
        ))}
        <line
          className="curve__axis"
          x1={PAD.left}
          x2={PAD.left + plotWidth}
          y1={PAD.top + plotHeight}
          y2={PAD.top + plotHeight}
        />
        <line className="curve__axis" x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + plotHeight} />

        <text className="curve__axis-label" x={PAD.left} y={PAD.top - 10}>
          USDC
        </text>
        <text
          className="curve__axis-label"
          x={PAD.left + plotWidth}
          y={PAD.top + plotHeight + 30}
          textAnchor="end"
        >
          {endIsLabelled ? "latency (ms)" : "latency (ms) · window 0 → hard +10%"}
        </text>

        {/* The full-escrow ceiling, so the legend's fourth entry is a real line. */}
        <line
          className="curve__escrow"
          x1={PAD.left}
          x2={PAD.left + plotWidth}
          y1={y(escrowValue)}
          y2={y(escrowValue)}
        />

        {/* Zone captions where the band is wide enough to hold them. */}
        {x(graceMs) - x(0) >= 62 ? (
          <text className="curve__zone-label" x={x(0) + 6} y={PAD.top + 14}>
            pass
          </text>
        ) : null}
        {x(hardMs) - x(graceMs) >= 62 ? (
          <text className="curve__zone-label" x={x(graceMs) + 6} y={PAD.top + 14}>
            degraded · rebated
          </text>
        ) : null}
        {x(xMax) - x(hardMs) >= 78 ? (
          <text className="curve__zone-label" x={x(hardMs) + 6} y={PAD.top + 14}>
            breach · refunded
          </text>
        ) : null}

        {/* The three flows. */}
        {series.map((line) => (
          <path key={line.key} className={line.className} d={path(line.points)} />
        ))}

        {/*
          Settled calls, placed by the latency that was measured for them. They sit
          on the provider line because that is what the contract paid at that
          latency; the colour says which branch the call fell into.
        */}
        {history.length > 0 ? (
          <g>
            {history.map((call, index) => (
              <circle
                key={`call-${index}`}
                className={`curve__call curve__call--${call.verdict}`}
                cx={x(Math.min(call.latencyMs, xMax))}
                cy={PAD.top + plotHeight}
                r={2.6}
              >
                <title>{`settled call · ${formatDuration(call.latencyMs)} · ${call.verdict}`}</title>
              </circle>
            ))}
            {distribution ? (
              <>
                <line
                  className="curve__percentile"
                  x1={x(Math.min(distribution.p50, xMax))}
                  x2={x(Math.min(distribution.p50, xMax))}
                  y1={PAD.top + plotHeight - 10}
                  y2={PAD.top + plotHeight}
                />
                <line
                  className="curve__percentile"
                  x1={x(Math.min(distribution.p95, xMax))}
                  x2={x(Math.min(distribution.p95, xMax))}
                  y1={PAD.top + plotHeight - 16}
                  y2={PAD.top + plotHeight}
                />
                <text
                  className="curve__label"
                  x={Math.min(x(distribution.p50), PAD.left + plotWidth - 40)}
                  y={PAD.top + plotHeight - 20}
                  textAnchor="middle"
                >
                  p50
                </text>
                <text
                  className="curve__label"
                  x={Math.min(x(distribution.p95), PAD.left + plotWidth - 40)}
                  y={PAD.top + plotHeight - 26}
                  textAnchor="middle"
                >
                  p95
                </text>
              </>
            ) : null}
          </g>
        ) : null}

        {/* A real measurement from the last executed call. */}
        {measured && measuredX !== null ? (
          <g>
            <line
              className="curve__marker--measured"
              x1={measuredX}
              x2={measuredX}
              y1={PAD.top}
              y2={PAD.top + plotHeight}
            />
            <text
              className="curve__label curve__label--fact"
              x={Math.min(Math.max(measuredX, PAD.left + 30), PAD.left + plotWidth - 30)}
              y={PAD.top + plotHeight - 8}
              textAnchor="middle"
            >
              measured {formatDuration(measured.latencyMs)}
            </text>
          </g>
        ) : null}

        {/* The probe. */}
        <line
          className="curve__marker"
          x1={x(latency)}
          x2={x(latency)}
          y1={PAD.top}
          y2={PAD.top + plotHeight}
        />
        {shown ? (
          <g>
            <circle className="curve__dot curve__dot--rebate" cx={x(latency)} cy={y(geometryValue(shown.rebate))} r={4.5} />
            <circle
              className="curve__dot curve__dot--provider"
              cx={x(latency)}
              cy={y(geometryValue(shown.provider))}
              r={4}
            />
            <text
              className="curve__label curve__label--strong"
              x={Math.min(Math.max(x(latency), PAD.left + 34), PAD.left + plotWidth - 34)}
              y={PAD.top - 10}
              textAnchor="middle"
            >
              {formatDuration(latency)}
            </text>
          </g>
        ) : null}
      </svg>

      <div className="range-row">
        <label className="sr-only" htmlFor="latency-probe">
          Latency probe in milliseconds
        </label>
        <input
          id="latency-probe"
          type="range"
          min={0}
          max={xMax}
          value={Math.min(latency, xMax)}
          onChange={(event) => onLatency(Number(event.target.value))}
          onKeyDown={onRangeKeyDown}
          aria-valuetext={
            shown
              ? `${shown.latency} milliseconds, ${verdictLabel(shown.verdict)}: caller rebated ${shown.rebate} USDC, provider ${shown.provider} USDC, dependencies ${shown.dependencies} USDC`
              : `${latency} milliseconds`
          }
        />
        <span className="mono small" aria-hidden="true">
          {formatDuration(latency)}
        </span>
      </div>

      <div className="row">
        <button type="button" className="button button--quiet button--mono tiny" onClick={() => onLatency(0)}>
          0
        </button>
        <button
          type="button"
          className="button button--quiet button--mono tiny"
          onClick={() => onLatency(graceMs)}
        >
          grace
        </button>
        <button
          type="button"
          className="button button--quiet button--mono tiny"
          onClick={() => onLatency(Math.min(xMax, graceMs + Math.round((hardMs - graceMs) / 2)))}
        >
          half overrun
        </button>
        <button
          type="button"
          className="button button--quiet button--mono tiny"
          onClick={() => onLatency(hardMs)}
        >
          hard edge
        </button>
        <button
          type="button"
          className="button button--quiet button--mono tiny"
          onClick={() => onLatency(Math.min(xMax, hardMs + 1))}
        >
          first breach
        </button>
        <span className="tiny muted">
          ← → move · shift + ← → jumps · the live call below is measured, not set here
        </span>
      </div>

      {shown ? (
        <div className="curve-readout">
          <div className="row--between">
            <div className="row">
              <span className={verdictClass(shown.verdict)}>{verdictLabel(shown.verdict)}</span>
              <span className="mono small">{formatDuration(shown.latency)}</span>
              <span className="tag tag--muted" title={`rebate cap ${formatBps(maxRebateBps)} of the escrow`}>
                max rebate {formatBps(maxRebateBps)}
              </span>
            </div>
            <span className="tiny muted">
              {probeLoading ? "asking the verifier…" : shown.source}
            </span>
          </div>
          <div className="facts">
            <div>
              <div className="fact__label">Rebate to caller</div>
              <div className="fact__value">{shown.rebate}</div>
            </div>
            <div>
              <div className="fact__label">To provider</div>
              <div className="fact__value">{shown.provider}</div>
            </div>
            <div>
              <div className="fact__label">To dependencies</div>
              <div className="fact__value">{shown.dependencies}</div>
            </div>
            <div>
              <div className="fact__label">Bond slashed</div>
              <div className="fact__value">
                {shown.bondSlash === null ? <span className="muted">—</span> : shown.bondSlash}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <p className="small muted">No curve is available for this covenant yet.</p>
      )}

      <p className="tiny muted">
        Shaded bands are the covenant&rsquo;s three branches: below the grace edge the promise is kept,
        between grace and the hard timeout the rebate grows linearly with the overrun, and past the
        hard timeout the escrow is refunded in full. A response that violates the covenant schema
        breaches at any latency; this curve assumes a schema-valid response, which is how the
        covenant is priced.
      </p>
    </div>
  );
}

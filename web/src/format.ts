/**
 * Formatting helpers.
 *
 * Two rules govern everything in this file:
 *
 * 1. Money never passes through a JavaScript `number` on its way to the screen.
 *    The verifier sends decimal strings and integer base units; those are what
 *    get rendered, via `bigint` where arithmetic is unavoidable. A double cannot
 *    represent 0.1, and a settlement figure that is off by one base unit is a
 *    wrong settlement figure.
 *
 * 2. USDC exists in two shapes on Arc and they are never mixed: the ERC-20 at
 *    0x3600…0000 carries 6 decimals, the native gas token carries 18. The
 *    verifier normalises the native balance to display units before sending it;
 *    `nativeUsdc`/`usdc` in `BalanceView` are therefore both USDC, but they are
 *    labelled with their wire precision so nobody reads one as the other.
 */

/** USDC's ERC-20 interface precision on Arc (both mainnet and testnet). */
export const USDC_DECIMALS = 6;

/** Native gas precision on Arc. Never the same number as `USDC_DECIMALS`. */
export const NATIVE_DECIMALS = 18;

const WEI_PER_GWEI = 1_000_000_000n;

/**
 * Parse a decimal USDC string into 6-decimal base units.
 *
 * Returns `null` rather than a guess when the string carries more precision
 * than the token can hold: silently rounding money is worse than refusing to
 * display it.
 */
export function usdcToUnits(value: string): bigint | null {
  const t = value.trim();
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
  const [whole = "", frac = ""] = t.split(".");
  if (frac.length > USDC_DECIMALS) return null;
  const padded = (frac + "000000").slice(0, USDC_DECIMALS);
  return BigInt(`${whole === "" ? "0" : whole}${padded}`);
}

/** Render base units as a fixed-precision decimal. `200000n` → `"0.200000"`. */
export function unitsToFixed(units: bigint, decimals = USDC_DECIMALS): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * Pad a decimal string to six places so columns of money line up by eye.
 * Unparseable input is returned untouched — the caller decides how to flag it.
 */
export function usdcFixed(value: string, decimals = USDC_DECIMALS): string {
  const units = usdcToUnits(value);
  return units === null ? value : unitsToFixed(units, decimals);
}

/** Sum decimal strings in base units. `null` if any input cannot be parsed. */
export function sumUnits(values: string[]): bigint | null {
  let total = 0n;
  for (const value of values) {
    const units = usdcToUnits(value);
    if (units === null) return null;
    total += units;
  }
  return total;
}

/**
 * Format wei as gwei. Arc's mempool drops anything below a 20 gwei tip, so this
 * is the unit a reader needs to judge a transaction fee. Truncated, never
 * rounded: the displayed fee must not be larger than the real one.
 */
export function formatGwei(wei: bigint): string {
  const whole = wei / WEI_PER_GWEI;
  const remainder = wei % WEI_PER_GWEI;
  if (remainder === 0n) return `${whole} gwei`;
  const frac = remainder.toString().padStart(9, "0").slice(0, 3);
  return `${whole}.${frac} gwei`;
}

/** `1760000000` → `"2026-10-09 09:20:00Z"`. Unix seconds, UTC. */
export function timestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  return `${new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ")}Z`;
}

/** Group block heights and counts so long integers stay readable. */
export function groupInt(value: number): string {
  return value.toLocaleString("en-US");
}

/** The 4-byte selector at the head of calldata, e.g. `0x1369f674`. */
export function selectorOf(data: string): string | null {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (!/^[0-9a-fA-F]{8,}$/.test(hex)) return null;
  return `0x${hex.slice(0, 8).toLowerCase()}`;
}

/** Byte length of a hex blob, `null` when it is not hex. */
export function byteLength(data: string): number | null {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (hex.length === 0) return 0;
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return null;
  return hex.length / 2;
}

/** Host of a URL, for labels that must not wrap. Falls back to the input. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Explorer link for a transaction; `null` when there is no explorer. */
export function txLink(explorer: string | null, hash: string | null): string | null {
  if (!explorer || !hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  return `${explorer.replace(/\/$/, "")}/tx/${hash}`;
}

/** Explorer link for an address. */
export function addressLink(explorer: string | null, address: string | null): string | null {
  if (!explorer || !address) return null;
  return `${explorer.replace(/\/$/, "")}/address/${address}`;
}

/** Role label for a split row: the API's own ordering decides, not a guess. */
export function splitRole(index: number, providerIndex: number): string {
  if (index === providerIndex) return "provider";
  return providerIndex === 0 ? `dependency ${index}` : `recipient ${index}`;
}

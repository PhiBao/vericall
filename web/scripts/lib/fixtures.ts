/**
 * The published services, read from `fixtures/services.json`.
 *
 * One source of truth for both languages. The Rust verifier embeds that file and
 * the tooling here reads it, so the terms a covenant is registered with are the
 * terms the verifier prices against — and the schema the verifier validates
 * against is the schema that was committed onchain. Writing them out twice is how
 * a covenant ends up priced against different numbers than it was registered
 * with, and the schema is the part that must not drift.
 *
 * The schema is kept as a parsed value rather than a string: the commitment is
 * taken over the canonical serialisation of the parsed value, so both languages
 * hash the same bytes by construction and a reformatted schema is still the same
 * schema.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toHex } from "viem";
import { repoRoot } from "./files.ts";

export interface CovenantFixture {
  slug: string;
  name: string;
  summary: string;
  /** The service's path, relative to the verifier's public base URL. */
  path: string;
  /** `deterministic` or `jev` — what actually produces the response. */
  backedBy: string;
  /** One sentence on what is behind the endpoint. */
  backing: string;
  /** The JSON Schema a passing response must satisfy. */
  schema: unknown;
  priceUsdc: string;
  graceLatencyMs: number;
  hardTimeoutMs: number;
  maxRebateBps: number;
  slashPenaltyBps: number;
  /** The provider's share; the remainder goes to the upstream dependency. */
  providerBps: number;
  initialBondUsdc: string;
}

interface FixtureFile {
  services: CovenantFixture[];
}

let cached: CovenantFixture[] | null = null;

export function fixtures(): CovenantFixture[] {
  if (cached) return cached;
  const path = join(repoRoot, "fixtures", "services.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as FixtureFile;
  if (!Array.isArray(parsed.services) || parsed.services.length === 0) {
    throw new Error(`${path} defines no services`);
  }
  cached = parsed.services;
  return cached;
}

export function fixture(slug: string): CovenantFixture {
  const found = fixtures().find((f) => f.slug === slug);
  if (!found) {
    throw new Error(`unknown service \`${slug}\`; known: ${fixtures().map((f) => f.slug).join(", ")}`);
  }
  return found;
}

/** Shown in the UI and the README: what is actually behind each endpoint. */
export function isModelBacked(f: CovenantFixture): boolean {
  return f.backedBy === "jev";
}

/**
 * The schema commitment a covenant stores onchain.
 *
 * Taken over the canonical serialisation — object keys sorted, no insignificant
 * whitespace — rather than the literal text, so a reformatted schema is the same
 * agreement while any change to the constraints is a different hash. The Rust
 * verifier implements the identical canonicalisation and refuses to attest if the
 * two disagree.
 */
export function schemaHash(schema: unknown): `0x${string}` {
  return keccak256(toHex(canonicalJson(schema)));
}

/** The exact bytes the commitment is taken over, for display. */
export function schemaCanonicalText(schema: unknown): string {
  return canonicalJson(schema);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** Parse `--bonds "slug=amount,slug=amount"` into a lookup. */
export function parseBondOverrides(spec: string | undefined): Record<string, string> {
  if (!spec) return {};
  const out: Record<string, string> = {};
  for (const part of spec.split(",")) {
    const [slug, amount] = part.split("=").map((piece) => piece.trim());
    if (!slug || !amount) throw new Error(`--bonds entries look like slug=amount; got \`${part}\``);
    out[slug] = amount;
  }
  return out;
}

/** USDC amounts are 6-decimal base units everywhere in this repo. */
export function parseUsdc(value: string): bigint {
  const [whole = "0", frac = ""] = value.trim().split(".");
  if (frac.length > 6) {
    throw new Error(`${value} has more precision than USDC carries (6 decimals)`);
  }
  return BigInt(whole) * 1_000_000n + BigInt((frac || "0").padEnd(6, "0") || "0");
}

export function formatUsdc(units: bigint): string {
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const whole = magnitude / 1_000_000n;
  const frac = magnitude % 1_000_000n;
  const sign = negative ? "-" : "";
  if (frac === 0n) return `${sign}${whole}`;
  return `${sign}${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

/** A signed delta, for reporting a balance change. */
export function formatDelta(delta: bigint): string {
  const text = formatUsdc(delta);
  return delta >= 0n ? `+${text}` : text;
}

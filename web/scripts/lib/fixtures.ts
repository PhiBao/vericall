/**
 * The three covenants the demo publishes, with their real SLA terms.
 *
 * One definition, consumed by both the operator scripts and the Rust verifier,
 * so the terms a service is registered with are the same terms the verifier
 * prices against. A JSON schema that a judge can read is the whole point of the
 * product, so each one is written out rather than generated.
 *
 * The latencies are chosen so the built-in services can exercise all three
 * settlement paths on demand:
 *   risk-scorer     pass 125 ms · degraded 1250 ms · breach 2250 ms
 *   invoice-parser  pass 100 ms · degraded  950 ms · breach 1750 ms
 *   ast-auditor     pass 250 ms · degraded 2000 ms · breach 3250 ms
 */

import { keccak256, toHex } from "viem";

export interface CovenantFixture {
  slug: string;
  name: string;
  summary: string;
  path: string;
  /** The JSON a passing response must satisfy, verbatim. */
  schema: string;
  priceUsdc: string;
  graceLatencyMs: number;
  hardTimeoutMs: number;
  maxRebateBps: number;
  slashPenaltyBps: number;
  /** The provider's share; the remaining bps go to the upstream dependency. */
  providerBps: number;
  initialBondUsdc: string;
}

export const FIXTURES: CovenantFixture[] = [
  {
    slug: "risk-scorer",
    name: "Counterparty Risk Scorer",
    summary: "Scores a counterparty from sanctions and adverse-media signals before a payment is released.",
    path: "/mock/risk-scorer",
    schema: `{
  "type": "object",
  "required": ["score", "band", "checks", "asOf"],
  "properties": {
    "score": { "type": "number", "minimum": 0, "maximum": 100 },
    "band": { "type": "string", "enum": ["low", "medium", "high"] },
    "checks": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
    "asOf": { "type": "integer", "minimum": 1 }
  },
  "additionalProperties": false
}`,
    priceUsdc: "0.2",
    graceLatencyMs: 500,
    hardTimeoutMs: 2000,
    maxRebateBps: 4000,
    slashPenaltyBps: 2000,
    providerBps: 8000,
    initialBondUsdc: "0.1",
  },
  {
    slug: "invoice-parser",
    name: "Invoice Field Extractor",
    summary: "Turns a PDF or email invoice into typed fields a payment run can act on.",
    path: "/mock/invoice-parser",
    schema: `{
  "type": "object",
  "required": ["invoiceId", "currency", "amount", "lines"],
  "properties": {
    "invoiceId": { "type": "string", "pattern": "^INV-[0-9]{4,}$" },
    "currency": { "type": "string", "pattern": "^[A-Z]{3}$" },
    "amount": { "type": "integer", "minimum": 1 },
    "lines": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["sku", "amount"],
        "properties": {
          "sku": { "type": "string", "minLength": 3 },
          "amount": { "type": "integer", "minimum": 1 }
        }
      }
    }
  },
  "additionalProperties": false
}`,
    priceUsdc: "0.15",
    graceLatencyMs: 400,
    hardTimeoutMs: 1500,
    maxRebateBps: 5000,
    slashPenaltyBps: 2500,
    providerBps: 7000,
    initialBondUsdc: "0.1",
  },
  {
    slug: "ast-auditor",
    name: "Contract Surface Auditor",
    summary: "Reports the external surface and risky patterns of a Solidity source file.",
    path: "/mock/ast-auditor",
    schema: `{
  "type": "object",
  "required": ["contractName", "highRisk", "findings"],
  "properties": {
    "contractName": { "type": "string", "minLength": 1 },
    "highRisk": { "type": "integer", "minimum": 0 },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["rule", "severity"],
        "properties": {
          "rule": { "type": "string" },
          "severity": { "type": "string", "enum": ["info", "low", "medium", "high", "critical"] }
        }
      }
    }
  },
  "additionalProperties": false
}`,
    priceUsdc: "0.5",
    graceLatencyMs: 1000,
    hardTimeoutMs: 3000,
    maxRebateBps: 3000,
    slashPenaltyBps: 1500,
    providerBps: 9000,
    initialBondUsdc: "0.2",
  },
];

export function fixture(slug: string): CovenantFixture {
  const found = FIXTURES.find((f) => f.slug === slug);
  if (!found) {
    throw new Error(`unknown service \`${slug}\`; known: ${FIXTURES.map((f) => f.slug).join(", ")}`);
  }
  return found;
}

/**
 * The schema commitment a covenant stores onchain.
 *
 * The hash is taken over a *canonical* serialisation — the parsed value with
 * object keys sorted and no insignificant whitespace — rather than the literal
 * text. That way a covenant can be reformatted without changing its commitment,
 * while any real change to the terms produces a different hash. The Rust
 * verifier implements the identical canonicalisation
 * (`verifier/src/main.rs::canonical_json`), and both sides hash the schema they
 * will actually validate against.
 */
export function schemaHash(schemaText: string): `0x${string}` {
  const parsed: unknown = JSON.parse(schemaText);
  return keccak256(toHex(canonicalJson(parsed)));
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

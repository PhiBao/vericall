/**
 * Persistent state for the operator scripts.
 *
 * Files under `deployments/` are the record of what actually exists onchain.
 * They are written by the deploy/register/order scripts and read by the settle
 * and verify scripts, so a run always names the same addresses a previous run
 * created — and so a judge can reproduce any step from the committed record.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const deploymentsDir = join(repoRoot, "deployments");

export function deploymentPath(networkKey: string): string {
  return join(deploymentsDir, `${networkKey}.json`);
}

export function covenantPath(networkKey: string): string {
  return join(deploymentsDir, `covenants-${networkKey}.json`);
}

export interface Deployment {
  network: string;
  chainId: number;
  contract: `0x${string}`;
  owner: `0x${string}`;
  usdc: `0x${string}`;
  deployedAt: string;
  txHash: `0x${string}`;
  blockNumber: number;
  gasUsed: string;
  deployFeeUsdc: string;
  /** The Studio app that authored the contract, for the submission's provenance. */
  arcStudioApp?: string;
}

export interface CovenantRecord {
  slug: string;
  serviceId: number;
  provider: `0x${string}`;
  verifier: `0x${string}`;
  dependency: `0x${string}`;
  name: string;
  endpointUri: string;
  schemaHash: `0x${string}`;
  callPriceUsdc: string;
  graceLatencyMs: number;
  hardTimeoutMs: number;
  maxRebateBps: number;
  slashPenaltyBps: number;
  providerBps: number;
  initialBondUsdc: string;
  registeredAt: string;
  txHash: `0x${string}`;
}

export interface CovenantFile {
  network: string;
  chainId: number;
  contract: `0x${string}`;
  covenants: CovenantRecord[];
}

export function readJson<T>(path: string, what: string): T {
  if (!existsSync(path)) {
    throw new Error(`${what} not found at ${path}. Run the earlier step first.`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function loadDeployment(networkKey: string): Deployment {
  return readJson<Deployment>(deploymentPath(networkKey), `${networkKey} deployment`);
}

export function loadCovenants(networkKey: string, contract: string): CovenantFile {
  const file = readJson<CovenantFile>(covenantPath(networkKey), `${networkKey} covenants`);
  if (file.contract.toLowerCase() !== contract.toLowerCase()) {
    throw new Error(
      `covenants-${networkKey}.json was written for ${file.contract} but the deployment is ${contract}. Re-register.`,
    );
  }
  return file;
}

export function upsertCovenant(file: CovenantFile, record: CovenantRecord): CovenantFile {
  const others = file.covenants.filter((c) => c.slug !== record.slug && c.serviceId !== record.serviceId);
  return { ...file, covenants: [...others, record].sort((a, b) => a.serviceId - b.serviceId) };
}

export function log(...parts: unknown[]): void {
  console.log(...parts);
}

export function section(title: string): void {
  console.log(`\n${title}\n${"─".repeat(Math.max(title.length, 24))}`);
}

/** Parse `--flag value` style arguments without a dependency. */
export function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  return fallback;
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

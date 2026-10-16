#!/usr/bin/env node
/**
 * Write the covenant record for a deployment *before* registering, using the
 * service ids the registration will produce.
 *
 * The verifier refuses to attest to a covenant it has not been told about, and
 * it confirms that record against the chain before signing. Having the record
 * exist first is what makes that check meaningful: `register.ts` fills in the
 * transaction hash afterwards, and if a registration lands at a different id
 * than predicted, the mismatch is visible immediately instead of showing up as
 * a failing settlement later.
 *
 *   node scripts/plan-covenants.ts --network arc-mainnet
 */

import {
  arg,
  loadDeployment,
  log,
  section,
  upsertCovenant,
  writeJson,
  covenantPath,
  type CovenantFile,
  type CovenantRecord,
} from "./lib/files.ts";
import { FIXTURES, fixture, parseBondOverrides, schemaHash } from "./lib/fixtures.ts";

async function main() {
  const key = (arg("network", "arc-mainnet") ?? "arc-mainnet") as "arc-mainnet" | "arc-testnet";
  const deployment = loadDeployment(key);

  const provider = (arg("provider") ?? process.env.PROVIDER_ADDRESS) as `0x${string}` | undefined;
  const verifier = (arg("verifier") ?? process.env.VERICALL_VERIFIER_ADDRESS) as `0x${string}` | undefined;
  const dependency = (arg("dependency") ?? process.env.DEPENDENCY_ADDRESS) as `0x${string}` | undefined;
  if (!provider || !verifier || !dependency) {
    throw new Error("pass --provider/--verifier/--dependency or set PROVIDER_ADDRESS/VERICALL_VERIFIER_ADDRESS/DEPENDENCY_ADDRESS");
  }

  // Service ids count up from 1 on a fresh deployment. Passing --start-id lets a
  // re-plan target the next free id instead of guessing.
  const startId = Number(arg("start-id", "1"));

  // Stake sizes, for a deployment whose wallet cannot fund the per-service
  // defaults. Sizing a stake to what the provider can actually lose is a feature
  // of the demo, not a shortcut: every bond still has to cover one order's
  // maximum penalty or `createOrder` refuses the covenant.
  const bondOverride = arg("bond");
  const perService = parseBondOverrides(arg("bonds"));

  section(`Planning covenants for ${key}`);
  log(`  contract    ${deployment.contract}`);
  log(`  provider    ${provider}`);
  log(`  verifier    ${verifier}`);
  log(`  dependency  ${dependency}`);
  log(`  start id    ${startId}`);

  const base = process.env.VERICALL_PUBLIC_BASE_URL ?? "http://localhost:8787";
  let file: CovenantFile = {
    network: deployment.network,
    chainId: deployment.chainId,
    contract: deployment.contract,
    covenants: [],
  };

  FIXTURES.forEach((slug, index) => {
    const terms = fixture(slug.slug);
    const record: CovenantRecord = {
      slug: slug.slug,
      serviceId: startId + index,
      provider,
      verifier,
      dependency,
      name: terms.name,
      endpointUri: `${base}${terms.path}`,
      schemaHash: schemaHash(terms.schema),
      callPriceUsdc: terms.priceUsdc,
      graceLatencyMs: terms.graceLatencyMs,
      hardTimeoutMs: terms.hardTimeoutMs,
      maxRebateBps: terms.maxRebateBps,
      slashPenaltyBps: terms.slashPenaltyBps,
      providerBps: terms.providerBps,
      initialBondUsdc: perService[slug.slug] ?? bondOverride ?? terms.initialBondUsdc,
      registeredAt: "",
      txHash: "0x",
    };
    file = upsertCovenant(file, record);
    log(`  ${record.serviceId}  ${record.slug.padEnd(16)} ${record.callPriceUsdc.padStart(5)} USDC · ${record.graceLatencyMs}/${record.hardTimeoutMs} ms`);
  });

  writeJson(covenantPath(key), file);
  log(`\n  written to ${covenantPath(key)}`);
  log("  the tx hashes and timestamps are filled in by scripts/register.ts");
}

main().catch((error: unknown) => {
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

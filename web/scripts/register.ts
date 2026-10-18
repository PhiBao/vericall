#!/usr/bin/env node
/**
 * Publish the demo covenants on Arc.
 *
 * Registration is the moment a promise becomes enforceable: price, grace SLA,
 * hard timeout, maximum rebate, breach penalty and the split table all go on
 * chain, and the provider's stake is pulled from the provider's own wallet.
 *
 *   DEPLOYER_KEY=… PROVIDER_KEY=… node scripts/register.ts --network arc-mainnet
 *
 * The provider address is derived from PROVIDER_KEY, so the bond is funded by
 * whoever will be accountable for the promise rather than by the operator.
 */

import {
  arg,
  flag,
  loadDeployment,
  log,
  section,
  upsertCovenant,
  writeJson,
  covenantPath,
  loadCovenants,
  type CovenantFile,
  type CovenantRecord,
} from "./lib/files.ts";
import { fixture, fixtures, formatUsdc, parseBondOverrides, parseUsdc, resolveEndpoint, schemaHash } from "./lib/fixtures.ts";
import { explorerTx, network, reader, sendTransaction, signerFromEnv } from "./lib/chain.ts";
import { CLEARINGHOUSE_ABI, USDC_ADDRESS, ERC20_ABI } from "./lib/abi.ts";
import { encodeFunctionData } from "viem";

const NETWORKS = ["arc-mainnet", "arc-testnet"] as const;
type NetworkKey = (typeof NETWORKS)[number];

async function main() {
  const key = (arg("network", "arc-mainnet") ?? "arc-mainnet") as NetworkKey;
  if (!NETWORKS.includes(key)) throw new Error(`--network must be one of ${NETWORKS.join(", ")}`);

  const net = network(key);
  const deployment = loadDeployment(key);
  const owner = signerFromEnv("DEPLOYER_KEY");
  const provider = signerFromEnv("PROVIDER_KEY");

  // The verifier's address signs attestations. It is derived from its key so the
  // covenant names the address the verifier will actually sign with.
  const verifierKeyRaw = process.env.VERICALL_VERIFIER_KEY;
  if (!verifierKeyRaw) {
    throw new Error(
      "VERICALL_VERIFIER_KEY is not set. The covenant must name the address the verifier signs with, " +
        "so export the verifier's key and it will be derived here (it is never printed).",
    );
  }
  const { privateKeyToAccount } = await import("viem/accounts");
  const verifierAddress = privateKeyToAccount(
    (verifierKeyRaw.startsWith("0x") ? verifierKeyRaw : `0x${verifierKeyRaw}`) as `0x${string}`,
  ).address;

  const dependencyAddress = (arg("dependency") ??
    process.env.DEPENDENCY_ADDRESS ??
    "0x0382bca3Fc934169a43c7ebe1Ee4B4d6A69C1e67") as `0x${string}`;

  if (owner.address.toLowerCase() !== deployment.owner.toLowerCase()) {
    throw new Error(
      `DEPLOYER_KEY derives ${owner.address}, but ${key}.json records ${deployment.owner} as the owner. ` +
        "Only the owner can register a covenant through the authorized path.",
    );
  }

  const client = reader(net);
  const slugs = arg("service") ? [arg("service")!] : fixtures().map((f) => f.slug);
  const bondOverride = arg("bond");
  const perService = parseBondOverrides(arg("bonds"));
  const bondFor = (slug: string, fallback: string): string => perService[slug] ?? bondOverride ?? fallback;

  // Every stake must cover one order's maximum penalty, or the covenant is
  // unfunded and `createOrder` would refuse it. Checked here so a bad override
  // fails before spending anything.
  for (const slug of slugs) {
    const terms = fixture(slug);
    const bond = parseUsdc(bondFor(slug, terms.initialBondUsdc));
    const required = (parseUsdc(terms.priceUsdc) * BigInt(terms.slashPenaltyBps)) / 10_000n;
    if (bond < required) {
      throw new Error(
        `${slug}: a bond of ${formatUsdc(bond)} USDC cannot cover one order's penalty of ${formatUsdc(required)} USDC`,
      );
    }
  }

  section(`Publishing covenants on ${net.label}`);
  log(`  contract    ${deployment.contract}`);
  log(`  owner       ${owner.address}   (registration authority)`);
  log(`  provider    ${provider.address} (stakes its own bond)`);
  log(`  verifier    ${verifierAddress}`);
  log(`  dependency  ${dependencyAddress}`);
  log(`  services    ${slugs.join(", ")}`);

  const existing: CovenantFile = (() => {
    try {
      return loadCovenants(key, deployment.contract);
    } catch {
      return { network: net.label, chainId: net.chain.id, contract: deployment.contract, covenants: [] };
    }
  })();
  let file = existing;

  // The provider must be able to pay for its own stake, and the stake is pulled
  // in the same transaction as the registration, so approve first.
  const totalBondNeeded = slugs.reduce(
    (acc, slug) => acc + parseUsdc(bondFor(slug, fixture(slug).initialBondUsdc)),
    0n,
  );
  const allowance = await client.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [provider.address, deployment.contract],
  });
  if (allowance < totalBondNeeded) {
    log(`\n  approving ${formatUsdc(totalBondNeeded)} USDC of bond from the provider to the clearinghouse`);
    const approveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      // The bonds this registration will deposit, no more.
      args: [deployment.contract, BigInt(totalBondNeeded)],
    });
    const result = await sendTransaction(net, provider, USDC_ADDRESS, approveData, {
      label: "approve USDC for bonds",
    });
    log(`  ${result.status} · ${explorerTx(net, result.hash)}`);
  }

  const balance = await client.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [provider.address],
  });
  log(`\n  provider holds ${formatUsdc(balance)} USDC (ERC-20 view)`);
  if (balance < totalBondNeeded) {
    throw new Error(
      `the provider holds ${formatUsdc(balance)} USDC but the stakes total ${formatUsdc(totalBondNeeded)}. Fund it and re-run.`,
    );
  }

  for (const slug of slugs) {
    const terms = fixture(slug);
    const schemaCommitment = schemaHash(terms.schema);
    const price = parseUsdc(terms.priceUsdc);
    const bondAmount = bondFor(slug, terms.initialBondUsdc);
    const bond = parseUsdc(bondAmount);

    // Already registered *and recorded* is a no-op, so the script is safe to
    // re-run without paying a second stake. A plan record (txHash still 0x) is
    // not evidence of registration: the chain is.
    const planned = file.covenants.find((c) => c.slug === slug);
    if (planned && planned.txHash !== "0x") {
      log(`\n  ${slug}: already registered as service ${planned.serviceId} (${planned.txHash})`);
      continue;
    }

    log(`\n  ${slug}`);
    log(`    price          ${terms.priceUsdc} USDC`);
    log(`    grace / hard   ${terms.graceLatencyMs} ms / ${terms.hardTimeoutMs} ms`);
    log(`    max rebate     ${terms.maxRebateBps / 100}%   breach penalty ${terms.slashPenaltyBps / 100}%`);
    log(`    split          ${terms.providerBps / 100}% provider / ${(10_000 - terms.providerBps) / 100}% dependency`);
    log(`    bond           ${terms.initialBondUsdc} USDC`);
    log(`    schema hash    ${schemaCommitment}`);

    const data = encodeFunctionData({
      abi: CLEARINGHOUSE_ABI,
      functionName: "registerServiceAuthorized",
      args: [
        provider.address,
        verifierAddress,
        terms.name,
        resolveEndpoint(terms, process.env.VERICALL_PUBLIC_BASE_URL ?? "http://localhost:8787"),
        schemaCommitment,
        price,
        terms.graceLatencyMs,
        terms.hardTimeoutMs,
        terms.maxRebateBps,
        terms.slashPenaltyBps,
        bond,
        [provider.address, dependencyAddress],
        [terms.providerBps, 10_000 - terms.providerBps],
      ],
    });

    if (flag("dry-run")) {
      log("    dry run: registration not sent");
      continue;
    }

    const result = await sendTransaction(net, owner, deployment.contract, data, {
      label: `register ${slug}`,
    });
    if (result.status !== "success") {
      throw new Error(`registration of ${slug} reverted: ${explorerTx(net, result.hash)}`);
    }

    const count = await client.readContract({
      address: deployment.contract,
      abi: CLEARINGHOUSE_ABI,
      functionName: "getServiceCount",
    });
    const serviceId = Number(count);

    const record: CovenantRecord = {
      slug,
      serviceId,
      provider: provider.address,
      verifier: verifierAddress,
      dependency: dependencyAddress,
      name: terms.name,
      endpointUri: resolveEndpoint(terms, process.env.VERICALL_PUBLIC_BASE_URL ?? "http://localhost:8787"),
      schemaHash: schemaCommitment,
      callPriceUsdc: terms.priceUsdc,
      graceLatencyMs: terms.graceLatencyMs,
      hardTimeoutMs: terms.hardTimeoutMs,
      maxRebateBps: terms.maxRebateBps,
      slashPenaltyBps: terms.slashPenaltyBps,
      providerBps: terms.providerBps,
      initialBondUsdc: bondAmount,
      registeredAt: new Date().toISOString(),
      txHash: result.hash,
    };
    file = upsertCovenant(file, record);
    writeJson(covenantPath(key), file);

    log(`    service ${serviceId} · ${result.status} · fee ${result.feeUsdc} USDC`);
    log(`    ${explorerTx(net, result.hash)}`);
  }

  log(`\n  covenant record written to ${covenantPath(key)}`);
}

main().catch((error: unknown) => {
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

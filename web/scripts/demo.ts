#!/usr/bin/env node
/**
 * One command that tells the whole story, on any network.
 *
 * This is the run the video walkthrough follows: escrow a call, then settle it
 * three ways — a promise kept, a promise kept late with an automatic rebate, and
 * a promise broken with a refund and a bond penalty — printing the exact amounts
 * the chain moved for each.
 *
 * On testnet it creates the orders it settles. On mainnet it refuses to spend
 * without `--confirm-mainnet`, because a demo script that quietly moves real
 * money is a bad demo script.
 *
 *   node scripts/demo.ts --network arc-testnet
 *   node scripts/demo.ts --network arc-mainnet --confirm-mainnet
 */

import {
  arg,
  flag,
  loadCovenants,
  loadDeployment,
  loadRequests,
  log,
  saveRequests,
  section,
  type RequestRecord,
} from "./lib/files.ts";
import { explorerTx, network, reader, sendTransaction, signerFromEnv } from "./lib/chain.ts";
import { CLEARINGHOUSE_ABI, ERC20_ABI, STATUS_NAME, USDC_ADDRESS } from "./lib/abi.ts";
import { formatDelta, formatUsdc } from "./lib/fixtures.ts";
import { execute, health } from "./lib/verifier.ts";
import { encodeFunctionData, keccak256, toHex } from "viem";

const MODES = [
  { mode: "normal" as const, label: "a promise kept", note: "the call answers inside the grace SLA" },
  { mode: "degraded" as const, label: "a promise kept late", note: "the answer arrives past grace, inside the timeout" },
  { mode: "breach" as const, label: "a promise broken", note: "the answer arrives too late, or in the wrong shape" },
];

async function main() {
  const key = (arg("network", "arc-testnet") ?? "arc-testnet") as "arc-mainnet" | "arc-testnet";
  const slug = arg("service", "risk-scorer")!;
  const net = network(key);
  const isMainnet = key === "arc-mainnet";

  if (isMainnet && !flag("confirm-mainnet")) {
    throw new Error("refusing to spend real USDC without --confirm-mainnet");
  }

  const deployment = loadDeployment(key);
  const covenants = loadCovenants(key, deployment.contract);
  const record = covenants.covenants.find((c) => c.slug === slug);
  if (!record) throw new Error(`\`${slug}\` is not registered on ${net.label}`);

  const caller = signerFromEnv("DEPLOYER_KEY");
  const client = reader(net);

  const verifier = await health();
  if (verifier.contract && verifier.contract.toLowerCase() !== deployment.contract.toLowerCase()) {
    throw new Error(`the verifier is pointed at ${verifier.contract}, not ${deployment.contract}`);
  }

  section(`VeriCall on ${net.label} · ${record.name}`);
  log(`  contract    ${deployment.contract}`);
  log(`  explorer    ${net.explorer}/address/${deployment.contract}`);
  log(`  verifier    ${verifier.verifier_address ?? "read-only"} (${verifier.can_settle ? "can sign" : "cannot sign"})`);
  log(`  price       ${record.callPriceUsdc} USDC · grace ${record.graceLatencyMs} ms · hard ${record.hardTimeoutMs} ms`);
  log(`  split       ${record.providerBps / 100}% provider / ${(10_000 - record.providerBps) / 100}% dependency`);
  log(`  caller      ${caller.address}`);

  const price = BigInt(Math.round(Number(record.callPriceUsdc) * 1_000_000));
  const allowance = (await client.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [caller.address, deployment.contract],
  })) as bigint;
  if (allowance < price * 3n) {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [deployment.contract, (1n << 256n) - 1n],
    });
    const approved = await sendTransaction(net, caller, USDC_ADDRESS, data, { label: "approve USDC" });
    log(`\n  approved USDC for escrow · ${explorerTx(net, approved.hash)}`);
  }

  const summary: Record<string, unknown>[] = [];
  // The endpoint the covenant names. The request hash commits to this URI, so it
  // has to be the one the verifier will dial.
  const endpointUri = `${process.env.VERICALL_PUBLIC_BASE_URL ?? "http://localhost:8787"}${record.endpointUri.replace(/^https?:\/\/[^/]+/, "")}`;

  const requests = (() => {
    try {
      return loadRequests(key);
    } catch {
      return { network: net.label, requests: [] };
    }
  })();

  for (const step of MODES) {
    section(`${step.label} — ${step.note}`);

    // 1. Escrow, committing to the exact request bytes the verifier will send.
    const requestBody = JSON.stringify({
      counterparty: caller.address,
      purpose: `demo/${step.mode}`,
      mode: step.mode,
    });
    const requestHash = keccak256(toHex(`${endpointUri}\n${requestBody}`));
    const create = encodeFunctionData({
      abi: CLEARINGHOUSE_ABI,
      functionName: "createOrder",
      args: [BigInt(record.serviceId), requestHash, 900n],
    });
    const escrowed = await sendTransaction(net, caller, deployment.contract, create, { label: "createOrder" });
    const orderId = (await client.readContract({
      address: deployment.contract,
      abi: CLEARINGHOUSE_ABI,
      functionName: "getOrderCount",
    })) as bigint;
    log(`  order ${orderId} funded · ${formatUsdc(price)} USDC escrowed · fee ${escrowed.feeUsdc} USDC`);
    log(`  ${explorerTx(net, escrowed.hash)}`);

    // Record the request so the verifier can be shown to be sending exactly
    // these bytes, not a request invented after the fact.
    const stored = await client.readContract({
      address: deployment.contract,
      abi: CLEARINGHOUSE_ABI,
      functionName: "getOrder",
      args: [orderId],
    });
    if (stored.requestHash.toLowerCase() !== requestHash.toLowerCase()) {
      throw new Error(`order ${orderId} stored ${stored.requestHash}, expected ${requestHash}`);
    }
    const entry: RequestRecord = {
      orderId: orderId.toString(),
      slug,
      mode: step.mode,
      body: requestBody,
      endpointUri,
      requestHash,
      createdAt: new Date().toISOString(),
    };
    requests.requests = [...requests.requests.filter((r) => r.orderId !== entry.orderId), entry];
    saveRequests(key, requests);

    // The contract refuses to settle an order in its own creation second, and
    // Arc's sub-second blocks can share a timestamp; let the clock move.
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    // 2. The verifier runs the call and reports what it observed.
    const probe = await execute({
      fixture: slug,
      mode: step.mode,
      serviceId: record.serviceId,
      bodyRaw: requestBody,
    });
    log(`\n  the verifier called ${probe.endpoint_uri}`);
    log(`    committed request hashes to ${requestHash.slice(0, 18)}…`);
    log(`    ${probe.outcome_summary}`);
    log(`    schema  ${probe.schema.valid ? "satisfied" : `violated — ${probe.schema.errors.join("; ")}`}`);
    log(`    response sha256 ${probe.outcome.response_sha256.slice(0, 24)}…`);

    // 3. Sign for this order, then settle.
    const addressed = await execute({
      fixture: slug,
      mode: step.mode,
      serviceId: record.serviceId,
      orderId: orderId.toString(),
      bodyRaw: requestBody,
    });
    if (!addressed.attestation?.calldata) {
      throw new Error(`the verifier produced no calldata (${addressed.notes.join(" ") || "no reason given"})`);
    }
    // The verifier checked, against the chain, that the bytes it just sent are
    // the bytes this order committed to. Print that check rather than assuming it.
    for (const note of addressed.notes.filter((n) => n.includes("commitment") || n.includes("bound"))) {
      log(`    ${note}`);
    }

    const before = await balances(client, caller.address, record);
    const settled = await sendTransaction(
      net,
      caller,
      deployment.contract,
      addressed.attestation.calldata as `0x${string}`,
      { label: `settleOrder(${orderId})` },
    );
    const after = await balances(client, caller.address, record);
    const order = await client.readContract({
      address: deployment.contract,
      abi: CLEARINGHOUSE_ABI,
      functionName: "getOrder",
      args: [orderId],
    });

    log(`\n  settled as ${STATUS_NAME[Number(order.status)]} at ${order.measuredLatencyMs} ms`);
    log(`    caller       ${formatDelta(after.caller - before.caller)} USDC (settlement only; escrow left earlier)`);
    log(`    provider     ${formatDelta(after.provider - before.provider)} USDC`);
    log(`    dependency   ${formatDelta(after.dependency - before.dependency)} USDC`);
    log(`    ${explorerTx(net, settled.hash)}`);

    summary.push({
      orderId: orderId.toString(),
      mode: step.mode,
      verdict: STATUS_NAME[Number(order.status)],
      latencyMs: Number(order.measuredLatencyMs),
      schemaValid: order.schemaValid,
      rebateToCallerUsdc: addressed.quote.rebate_to_caller_usdc,
      paidToProviderUsdc: addressed.quote.paid_to_provider_usdc,
      paidToDependenciesUsdc: addressed.quote.paid_to_dependencies_usdc,
      bondSlashedUsdc: addressed.quote.bond_slash_usdc,
      attestationDigest: addressed.attestation.digest,
      txHash: settled.hash,
      explorer: explorerTx(net, settled.hash),
      blockNumber: Number(settled.blockNumber),
      gasUsed: settled.gasUsed.toString(),
    });
  }

  section("What the chain was asked to do, and what it did");
  console.log(JSON.stringify({ network: net.label, contract: deployment.contract, service: slug, runs: summary }, null, 2));

  log(`\n  verify the whole thing without a key:  node scripts/verify.ts --network ${key}`);
}

async function balances(
  client: ReturnType<typeof reader>,
  caller: `0x${string}`,
  record: { provider: `0x${string}`; dependency: `0x${string}` },
) {
  const [c, p, d] = await Promise.all([
    client.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [caller] }),
    client.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [record.provider] }),
    client.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [record.dependency] }),
  ]);
  return { caller: c as bigint, provider: p as bigint, dependency: d as bigint };
}

main().catch((error: unknown) => {
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

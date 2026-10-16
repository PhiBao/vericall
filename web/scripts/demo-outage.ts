#!/usr/bin/env node
/**
 * Demonstrate the SLA pricing a real outage.
 *
 * The interesting claim is not that a working service gets paid — it is that a
 * service that stops answering costs the provider money instead of costing the
 * caller. This script produces exactly that, on mainnet, using the model-backed
 * service's own limits rather than a simulated failure:
 *
 *   1. escrow one call to a model-backed service;
 *   2. spend that service's per-minute model budget with real requests, until it
 *      starts refusing them — the refusal is genuine, not injected;
 *   3. settle the order while the service is refusing. The call fails, the schema
 *      check fails with it, and the covenant pays the caller back and slashes the
 *      provider's stake.
 *
 * The outage is orchestrated; every consequence of it is the contract's own
 * arithmetic. Nothing here is mocked, and the script says so in its output so a
 * reader never has to guess which is which.
 *
 *   node scripts/demo-outage.ts --network arc-mainnet --confirm-mainnet
 */

import { encodeFunctionData, keccak256, toHex } from "viem";
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

const BASE = (process.env.VERICALL_API ?? "http://localhost:8787").replace(/\/$/, "");

async function main(): Promise<void> {
  const key = (arg("network", "arc-testnet") ?? "arc-testnet") as "arc-mainnet" | "arc-testnet";
  const slug = arg("service", "payment-guard")!;
  const net = network(key);
  if (key === "arc-mainnet" && !flag("confirm-mainnet")) {
    throw new Error("refusing to spend real USDC without --confirm-mainnet");
  }

  const deployment = loadDeployment(key);
  const record = loadCovenants(key, deployment.contract).covenants.find((c) => c.slug === slug);
  if (!record) throw new Error(`\`${slug}\` is not registered on ${net.label}`);

  const caller = signerFromEnv("DEPLOYER_KEY");
  const client = reader(net);
  const endpointUri = `${process.env.VERICALL_PUBLIC_BASE_URL ?? BASE}${record.endpointUri.replace(/^https?:\/\/[^/]+/, "")}`;

  section(`Pricing an outage on ${net.label} · ${record.name}`);
  log(`  service     ${record.serviceId} · ${record.callPriceUsdc} USDC at stake`);
  log(`  verifier    ${BASE}`);

  // ---- 1. escrow one call -------------------------------------------------
  const requestBody = JSON.stringify({
    payment: {
      amount: 320,
      currency: "USDC",
      counterparty: "0x2f9a4c7e1b3d5a8f0c2e4b6d8a1f3c5e7b9d0a2c",
      memo: "Quarterly platform fee",
      requestedBy: "finance@example.com",
    },
    mode: "normal",
  });
  const requestHash = keccak256(toHex(`${endpointUri}\n${requestBody}`));

  const createData = encodeFunctionData({
    abi: CLEARINGHOUSE_ABI,
    functionName: "createOrder",
    args: [BigInt(record.serviceId), requestHash, 900n],
  });
  const created = await sendTransaction(net, caller, deployment.contract, createData, {
    label: "createOrder",
  });
  const orderId = (await client.readContract({
    address: deployment.contract,
    abi: CLEARINGHOUSE_ABI,
    functionName: "getOrderCount",
  })) as bigint;
  log(`\n  order ${orderId} funded · ${record.callPriceUsdc} USDC escrowed · fee ${created.feeUsdc}`);
  log(`  ${explorerTx(net, created.hash)}`);

  const requests = (() => {
    try {
      return loadRequests(key);
    } catch {
      return { network: net.label, requests: [] };
    }
  })();
  const entry: RequestRecord = {
    orderId: orderId.toString(),
    slug,
    mode: "normal",
    body: requestBody,
    endpointUri,
    requestHash,
    createdAt: new Date().toISOString(),
  };
  requests.requests = [...requests.requests.filter((r) => r.orderId !== entry.orderId), entry];
  saveRequests(key, requests);

  // ---- 2. consume the service's own model budget --------------------------
  const healthBefore = await health();
  const perMinute = healthBefore.model_services?.per_minute ?? 12;
  log(`\n  spending the service's ${perMinute}-per-minute model budget with real requests`);
  log(`  (these are genuine calls to a real model; the refusal that follows is the service's own)`);

  let refused = 0;
  let attempted = 0;
  for (let i = 0; i < perMinute + 2 && refused === 0; i += 1) {
    attempted += 1;
    const response = await fetch(`${endpointUri}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payment: { amount: 12, currency: "USDC", counterparty: "0x1", memo: "routine" },
      }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!response || !response.ok) {
      refused = response?.status ?? 0;
    }
    process.stdout.write(response?.ok ? "." : "x");
  }
  console.log();
  if (refused === 0) {
    log(`  the service is still answering after ${attempted} calls, so there is no outage to price.`);
    log(`  Re-run within the same minute, or point this at a service whose budget is smaller.`);
    return;
  }
  log(`  the service is now refusing calls with HTTP ${refused}: the outage is real, not injected`);

  // ---- 3. settle while the service is refusing ---------------------------
  const probe = await execute({ fixture: slug, serviceId: record.serviceId, bodyRaw: requestBody });
  log(`\n  the verifier measured: ${probe.outcome_summary}`);
  log(`  schema: ${probe.schema.valid ? "satisfied" : `violated — ${probe.schema.errors.slice(0, 2).join("; ")}`}`);
  log(`  the covenant therefore reads: ${probe.quote.status.toUpperCase()}`);

  if (probe.quote.status !== "breach") {
    log(`\n  the service answered in time, so there is nothing to price. Re-run to catch an outage.`);
    return;
  }

  // A refused call is still a measured one: the verifier saw an HTTP status and a
  // body, and it attests to exactly that. The covenant then prices the failure
  // itself — the caller is refunded and the provider's stake pays the penalty.
  // That is stronger than leaving the order to expire, and it is what the
  // contract actually does, so the script does not second-guess it.
  const addressed = await execute({
    fixture: slug,
    serviceId: record.serviceId,
    orderId: orderId.toString(),
    bodyRaw: requestBody,
  });
  if (!addressed.attestation?.calldata) {
    throw new Error(`the verifier produced no calldata: ${addressed.notes.join(" ") || "no reason given"}`);
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

  section("Settled");
  log(`  status      ${STATUS_NAME[Number(order.status)]}`);
  log(`  caller      ${formatDelta(after.caller - before.caller)} USDC (the escrow, refunded)`);
  log(`  provider    ${formatDelta(after.provider - before.provider)} USDC (no revenue, and a penalty)`);
  log(`  dependency  ${formatDelta(after.dependency - before.dependency)} USDC`);
  log(`  escrowed    ${formatUsdc(order.escrowedUsdc)} USDC · bond slashed ${formatUsdc(order.bondSlashed)} USDC`);
  log(`  fee         ${settled.feeUsdc} USDC`);
  log(`  ${explorerTx(net, settled.hash)}`);
  log(`\n  The outage cost the caller nothing but gas and cost the provider its stake.`);
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

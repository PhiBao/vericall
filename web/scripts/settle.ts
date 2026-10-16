#!/usr/bin/env node
/**
 * Run the call, then settle it on Arc.
 *
 * This is the product's whole loop in one command:
 *
 *   1. ask the verifier to execute the registered endpoint and measure it;
 *   2. read the settlement the covenant implies from the verifier's quote;
 *   3. send the verifier's signed attestation to `settleOrder`, which pays the
 *      provider and its dependency, or rebates the caller, or refunds the caller
 *      and slashes the bond — decided by the contract, not by this script.
 *
 * The script refuses to settle with terms it has not confirmed: the verifier
 * does that check, and its refusal is surfaced verbatim rather than worked
 * around.
 *
 *   DEPLOYER_KEY=… node scripts/settle.ts --order 1 --service risk-scorer --mode degraded
 */

import { arg, flag, loadCovenants, loadDeployment, loadRequests, log, section } from "./lib/files.ts";
import { explorerTx, network, reader, sendTransaction, signerFromEnv } from "./lib/chain.ts";
import { CLEARINGHOUSE_ABI, STATUS_NAME, USDC_ADDRESS, ERC20_ABI } from "./lib/abi.ts";
import { formatDelta, formatUsdc } from "./lib/fixtures.ts";
import { execute, health, type ExecutionResult } from "./lib/verifier.ts";

type Mode = "normal" | "degraded" | "breach";

function printQuote(result: ExecutionResult, label: string): void {
  const { quote, outcome, schema } = result;
  console.log(`  ${label}`);
  console.log(`    latency        ${outcome.latency_ms} ms (HTTP ${outcome.status ?? "—"})`);
  console.log(`    schema         ${schema.valid ? "satisfied" : `violated: ${schema.errors.join("; ")}`}`);
  console.log(`    verdict        ${quote.status}`);
  console.log(`    escrowed       ${quote.escrow_usdc} USDC`);
  console.log(`    rebate caller  ${quote.rebate_to_caller_usdc} USDC`);
  console.log(`    bond slash     ${quote.bond_slash_usdc} USDC`);
  console.log(`    provider       ${quote.paid_to_provider_usdc} USDC`);
  console.log(`    dependencies   ${quote.paid_to_dependencies_usdc} USDC`);
  console.log(`    ${quote.explanation}`);
}

async function main() {
  const key = (arg("network", "arc-mainnet") ?? "arc-mainnet") as "arc-mainnet" | "arc-testnet";
  const slug = arg("service", "risk-scorer")!;
  const mode = (arg("mode", "normal") ?? "normal") as Mode;
  const orderArg = arg("order");
  const net = network(key);
  const deployment = loadDeployment(key);
  const covenants = loadCovenants(key, deployment.contract);
  const record = covenants.covenants.find((c) => c.slug === slug);
  if (!record) {
    throw new Error(`\`${slug}\` is not registered on ${net.label}. Run scripts/register.ts first.`);
  }

  section(`Executing and settling a ${slug} call on ${net.label}`);

  const verifier = await health();
  log(`  verifier      ${verifier.version} · ${verifier.network} · ${verifier.can_settle ? "can sign" : "read-only"}`);
  log(`  verifier addr ${verifier.verifier_address ?? "not configured"}`);
  if (verifier.contract && verifier.contract.toLowerCase() !== deployment.contract.toLowerCase()) {
    throw new Error(
      `the verifier is pointed at ${verifier.contract} but ${key}.json records ${deployment.contract}. ` +
        "Set VERICALL_CONTRACT for the verifier and restart it, or the attestation will be bound to the wrong contract.",
    );
  }
  if (verifier.verifier_address && verifier.verifier_address.toLowerCase() !== record.verifier.toLowerCase()) {
    throw new Error(
      `the covenant names ${record.verifier} as verifier but the running verifier signs as ${verifier.verifier_address}. ` +
        "The contract would reject the attestation; fix the key or re-register.",
    );
  }

  const orderId = orderArg ? BigInt(orderArg) : await latestOpenOrder(net, deployment.contract, record.serviceId);
  log(`  order         ${orderId}`);

  // The bytes this order committed to. The verifier will refuse to attest unless
  // the request it is about to send hashes to the same value, so this is the
  // request the call is judged on — not one this script made up now.
  const requests = (() => {
    try {
      return loadRequests(key);
    } catch {
      return { network: net.label, requests: [] };
    }
  })();
  const committed = requests.requests.find((r) => r.orderId === orderId.toString());
  if (!committed) {
    throw new Error(
      `no recorded request for order ${orderId}. Create the order with scripts/order.ts first — the request has to be committed onchain before it can be attested.`,
    );
  }
  log(`  request       ${committed.body}`);

  // 1. Execute and measure, without an order id: nothing is signed yet.
  const probe = await execute({
    fixture: slug,
    mode,
    serviceId: record.serviceId,
    bodyRaw: committed.body,
  });
  printQuote(probe, `measured (${committed.mode})`);

  // 2. Sign the attestation bound to this order and this request.
  const addressed = await execute({
    fixture: slug,
    mode,
    serviceId: record.serviceId,
    orderId: orderId.toString(),
    bodyRaw: committed.body,
  });
  if (!addressed.attestation?.signature || !addressed.attestation.calldata) {
    throw new Error(
      `the verifier returned no signature (${addressed.notes.join(" ") || "no reason given"}). ` +
        "Set VERICALL_VERIFIER_KEY for the verifier and confirm VERICALL_COVENANTS points at the record.",
    );
  }
  log(`\n  attestation`);
  log(`    digest        ${addressed.attestation.digest}`);
  log(`    signer        ${addressed.attestation.signer}`);
  log(`    deadline      ${new Date(addressed.attestation.deadline * 1000).toISOString()}`);

  if (flag("dry-run")) {
    log("\n  dry run: nothing was settled.");
    log(`  calldata      ${addressed.attestation.calldata}`);
    return;
  }

  const callerBefore = await balances(net, deployment.contract, record);

  // 3. Settle. The caller pays the gas because the caller owns the outcome.
  const sender = signerFromEnv("DEPLOYER_KEY");
  const result = await sendTransaction(net, sender, deployment.contract, addressed.attestation.calldata as `0x${string}`, {
    label: `settleOrder(${orderId})`,
  });
  if (result.status !== "success") {
    throw new Error(`settlement reverted: ${explorerTx(net, result.hash)}`);
  }

  const client = reader(net);
  const order = await client.readContract({
    address: deployment.contract,
    abi: CLEARINGHOUSE_ABI,
    functionName: "getOrder",
    args: [orderId],
  });
  const callerAfter = await balances(net, deployment.contract, record);

  section("Settled");
  log(`  status        ${STATUS_NAME[Number(order.status)]}`);
  log(`  latency       ${order.measuredLatencyMs} ms · schema ${order.schemaValid ? "valid" : "invalid"}`);
  log(`  escrowed      ${formatUsdc(order.escrowedUsdc)} USDC (committed when the order was created)`);
  // Balance changes measured across *this settlement*. The caller's escrow left
  // its wallet when the order was created, so on a pass the caller's delta here
  // is gas alone — stated plainly rather than dressed up.
  log(`  caller        ${formatDelta(callerAfter.caller - callerBefore.caller)} USDC`);
  log(`  provider      ${formatDelta(callerAfter.provider - callerBefore.provider)} USDC`);
  log(`  dependency    ${formatDelta(callerAfter.dependency - callerBefore.dependency)} USDC`);
  log(`  fee paid      ${result.feeUsdc} USDC`);
  log(`  tx            ${explorerTx(net, result.hash)}`);
  log(`  block         ${result.blockNumber}`);

  console.log(
    JSON.stringify(
      {
        orderId: orderId.toString(),
        serviceId: record.serviceId,
        slug,
        mode,
        verdict: addressed.quote.status,
        latencyMs: addressed.outcome.latency_ms,
        schemaValid: addressed.schema.valid,
        responseHash: addressed.outcome.response_hash,
        attestationDigest: addressed.attestation.digest,
        rebateToCallerUsdc: addressed.quote.rebate_to_caller_usdc,
        paidToProviderUsdc: addressed.quote.paid_to_provider_usdc,
        paidToDependenciesUsdc: addressed.quote.paid_to_dependencies_usdc,
        bondSlashedUsdc: addressed.quote.bond_slash_usdc,
        txHash: result.hash,
        explorer: explorerTx(net, result.hash),
        blockNumber: Number(result.blockNumber),
        gasUsed: result.gasUsed.toString(),
        feeUsdc: result.feeUsdc,
      },
      null,
      2,
    ),
  );
}

async function latestOpenOrder(
  net: ReturnType<typeof network>,
  contract: `0x${string}`,
  serviceId: number,
): Promise<bigint> {
  const client = reader(net);
  const count = (await client.readContract({
    address: contract,
    abi: CLEARINGHOUSE_ABI,
    functionName: "getOrderCount",
  })) as bigint;
  for (let id = count; id > 0n; id -= 1n) {
    const order = await client.readContract({
      address: contract,
      abi: CLEARINGHOUSE_ABI,
      functionName: "getOrder",
      args: [id],
    });
    if (Number(order.serviceId) === serviceId && Number(order.status) === 1) {
      return id;
    }
  }
  throw new Error(
    `no funded order for service ${serviceId}. Create one with scripts/order.ts --service ${
      serviceId === 1 ? "risk-scorer" : String(serviceId)
    }`,
  );
}

async function balances(
  net: ReturnType<typeof network>,
  _contract: `0x${string}`,
  record: { provider: `0x${string}`; dependency: `0x${string}` },
): Promise<{ caller: bigint; provider: bigint; dependency: bigint }> {
  const client = reader(net);
  const caller = signerFromEnv("DEPLOYER_KEY").address;
  const [callerBalance, providerBalance, dependencyBalance] = await Promise.all([
    client.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [caller] }),
    client.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [record.provider] }),
    client.readContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [record.dependency],
    }),
  ]);
  return {
    caller: callerBalance as bigint,
    provider: providerBalance as bigint,
    dependency: dependencyBalance as bigint,
  };
}

main().catch((error: unknown) => {
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});



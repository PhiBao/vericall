#!/usr/bin/env node
/**
 * Escrow one call.
 *
 * The caller funds the order from its own wallet, which is the point of the
 * product: nobody else can commit the caller's money. The request hash commits
 * to the exact request the verifier will send, so the attestation that follows
 * cannot describe a different call.
 *
 *   DEPLOYER_KEY=… node scripts/order.ts --service risk-scorer --request '{"counterparty":"0x…"}'
 */

import { encodeFunctionData, keccak256, toHex } from "viem";
import {
  arg,
  loadCovenants,
  loadDeployment,
  log,
  section,
} from "./lib/files.ts";
import { explorerTx, network, reader, sendTransaction, signerFromEnv } from "./lib/chain.ts";
import { CLEARINGHOUSE_ABI, ERC20_ABI, STATUS_NAME, USDC_ADDRESS } from "./lib/abi.ts";

async function main() {
  const key = (arg("network", "arc-mainnet") ?? "arc-mainnet") as "arc-mainnet" | "arc-testnet";
  const slug = arg("service", "risk-scorer")!;
  const ttl = Number(arg("ttl", "900"));
  const net = network(key);
  const deployment = loadDeployment(key);
  const covenants = loadCovenants(key, deployment.contract);
  const record = covenants.covenants.find((c) => c.slug === slug);
  if (!record) {
    throw new Error(`\`${slug}\` is not registered on ${net.label}. Run scripts/register.ts first.`);
  }

  const caller = signerFromEnv("DEPLOYER_KEY");

  // The request body the verifier will send. Committing to its hash up front is
  // what ties the eventual attestation to this order and no other.
  const requestBody =
    arg("request") ??
    JSON.stringify({
      counterparty: "0x4AB5e7F2b5464B9494b49EFE41C2f00e7bcfE555",
      purpose: "release a milestone payment",
    });
  const requestHash = keccak256(toHex(requestBody));

  section(`Escrowing a ${slug} call on ${net.label}`);
  log(`  service   ${record.serviceId} · ${record.name}`);
  log(`  price     ${record.callPriceUsdc} USDC`);
  log(`  caller    ${caller.address}`);
  log(`  request   ${requestBody}`);
  log(`  req hash  ${requestHash}`);
  log(`  ttl       ${ttl}s`);

  // The escrow is pulled from the caller, so the caller approves once. The
  // allowance is checked rather than assumed, so the script works on a fresh
  // wallet and costs nothing to re-run.
  const client = reader(net);
  const price = BigInt(Math.round(Number(record.callPriceUsdc) * 1_000_000));
  const allowance = (await client.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [caller.address, deployment.contract],
  })) as bigint;
  if (allowance < price) {
    log(`\n  approving USDC for escrow (allowance ${allowance} < price ${price})`);
    const approveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [deployment.contract, (1n << 256n) - 1n],
    });
    const approved = await sendTransaction(net, caller, USDC_ADDRESS, approveData, { label: "approve USDC" });
    log(`  ${approved.status} · ${explorerTx(net, approved.hash)}`);
  }

  const data = encodeFunctionData({
    abi: CLEARINGHOUSE_ABI,
    functionName: "createOrder",
    args: [BigInt(record.serviceId), requestHash, BigInt(ttl)],
  });

  const result = await sendTransaction(net, caller, deployment.contract, data, {
    label: "createOrder",
  });

  const orderCount = await client.readContract({
    address: deployment.contract,
    abi: CLEARINGHOUSE_ABI,
    functionName: "getOrderCount",
  });
  const orderId = orderCount as bigint;
  const order = await client.readContract({
    address: deployment.contract,
    abi: CLEARINGHOUSE_ABI,
    functionName: "getOrder",
    args: [orderId],
  });

  // Print the onchain record, not what was intended: this is the object the
  // verifier will be asked about.
  console.log(
    JSON.stringify(
      {
        orderId: orderId.toString(),
        serviceId: record.serviceId,
        slug,
        requestHash,
        requestBody,
        escrowedUsdc: record.callPriceUsdc,
        expiryAt: Number(order.expiryAt),
        status: STATUS_NAME[Number(order.status)],
        caller: caller.address,
        txHash: result.hash,
        explorer: explorerTx(net, result.hash),
        feeUsdc: result.feeUsdc,
      },
      null,
      2,
    ),
  );

  log(`\n  order ${orderId} · ${result.status} · fee ${result.feeUsdc} USDC`);
  log(`  ${explorerTx(net, result.hash)}`);
  log(`\n  next: node scripts/settle.ts --order ${orderId} --service ${slug} --mode degraded`);
}

main().catch((error: unknown) => {
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

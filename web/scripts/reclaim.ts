#!/usr/bin/env node
/**
 * Reclaim an escrow the service never settled.
 *
 * The escape hatch. A verifier that goes dark, a provider that disappears, or a
 * caller whose software crashed must not be able to trap a caller's money, so
 * once an order's window closes anyone may send it home — the refund can only
 * ever go to the original caller.
 *
 *   DEPLOYER_KEY=… node scripts/reclaim.ts --order 7
 */

import { encodeFunctionData } from "viem";
import { arg, loadDeployment, log, section } from "./lib/files.ts";
import { explorerTx, network, reader, sendTransaction, signerFromEnv } from "./lib/chain.ts";
import { CLEARINGHOUSE_ABI, STATUS_NAME } from "./lib/abi.ts";
import { formatUsdc } from "./lib/fixtures.ts";

async function main() {
  const key = (arg("network", "arc-mainnet") ?? "arc-mainnet") as "arc-mainnet" | "arc-testnet";
  const orderArg = arg("order");
  if (!orderArg) throw new Error("pass --order <id>");

  const net = network(key);
  const deployment = loadDeployment(key);
  const client = reader(net);
  const orderId = BigInt(orderArg);

  const order = await client.readContract({
    address: deployment.contract,
    abi: CLEARINGHOUSE_ABI,
    functionName: "getOrder",
    args: [orderId],
  });

  section(`Reclaiming order ${orderId} on ${net.label}`);
  log(`  status    ${STATUS_NAME[Number(order.status)]}`);
  log(`  escrowed  ${formatUsdc(order.escrowedUsdc)} USDC`);
  log(`  caller    ${order.caller}`);
  log(`  expiry    ${new Date(Number(order.expiryAt) * 1000).toISOString()}`);

  if (Number(order.status) !== 1) {
    throw new Error("only a funded order can be reclaimed");
  }

  const now = Math.floor(Date.now() / 1000);
  const remaining = Number(order.expiryAt) - now;
  if (remaining > 0) {
    log(`\n  the window has ${remaining}s left, so the order cannot be reclaimed yet.`);
    log(`  Waiting is the honest behaviour: settling must be possible until the deadline.`);
    // Wait rather than force: the whole point of the deadline is that a service
    // gets the full window it promised.
    if (remaining < 600) {
      log(`  waiting ${remaining}s…`);
      await new Promise((resolve) => setTimeout(resolve, (remaining + 5) * 1000));
    } else {
      throw new Error(`re-run once the window closes (in ${Math.ceil(remaining / 60)} minutes)`);
    }
  }

  // Anyone may do this. It is signed by whoever runs the script, which shows the
  // permissionlessness directly rather than claiming it.
  const sender = signerFromEnv(process.env.SENDER_KEY_VAR ?? "DEPLOYER_KEY");
  const data = encodeFunctionData({
    abi: CLEARINGHOUSE_ABI,
    functionName: "reclaimExpiredOrder",
    args: [orderId],
  });
  const result = await sendTransaction(net, sender, deployment.contract, data, {
    label: `reclaimExpiredOrder(${orderId})`,
  });

  const after = await client.readContract({
    address: deployment.contract,
    abi: CLEARINGHOUSE_ABI,
    functionName: "getOrder",
    args: [orderId],
  });

  log(`\n  status    ${STATUS_NAME[Number(after.status)]}`);
  log(`  refunded  ${formatUsdc(after.refundedToCaller)} USDC to the caller`);
  log(`  sent by   ${sender.address} (any address could have done this)`);
  log(`  tx        ${explorerTx(net, result.hash)}`);
}

main().catch((error: unknown) => {
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

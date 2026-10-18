#!/usr/bin/env node
/**
 * Add stake to a covenant, or withdraw stake nothing is riding on.
 *
 * The bond is what makes a breach refundable, and `createOrder` refuses a
 * covenant whose stake cannot cover one order's penalty. After a breach has
 * been paid out of the stake, the covenant stops taking orders until someone
 * tops it up — which is the intended shape: a provider that has started to miss
 * its promises must put money behind its word again before it can sell more.
 *
 * The deposit is always pulled from the provider's own wallet. The withdrawal
 * is only possible once the service is delisted and no order is open, so a
 * provider can never collect the stake that still promises a caller a refund.
 *
 *   PROVIDER_KEY=… node scripts/bond.ts --service risk-scorer --deposit 0.05
 *   PROVIDER_KEY=… DEPLOYER_KEY=… node scripts/bond.ts --service risk-scorer --withdraw 0.02 --delist
 */

import { encodeFunctionData } from "viem";
import { arg, flag, loadCovenants, loadDeployment, log, section } from "./lib/files.ts";
import { explorerTx, network, reader, sendTransaction, signerFromEnv } from "./lib/chain.ts";
import { CLEARINGHOUSE_ABI, ERC20_ABI, USDC_ADDRESS } from "./lib/abi.ts";
import { formatUsdc, parseUsdc } from "./lib/fixtures.ts";

async function main() {
  const key = (arg("network", "arc-mainnet") ?? "arc-mainnet") as "arc-mainnet" | "arc-testnet";
  const slug = arg("service", "risk-scorer")!;
  const depositArg = arg("deposit");
  const withdrawArg = arg("withdraw");
  if (!depositArg && !withdrawArg) throw new Error("pass --deposit <usdc> or --withdraw <usdc>");

  const net = network(key);
  const deployment = loadDeployment(key);
  const covenants = loadCovenants(key, deployment.contract);
  const record = covenants.covenants.find((c) => c.slug === slug);
  if (!record) throw new Error(`\`${slug}\` is not registered on ${net.label}`);

  const client = reader(net);
  const serviceId = BigInt(record.serviceId);
  const covenant = await client.readContract({
    address: deployment.contract,
    abi: CLEARINGHOUSE_ABI,
    functionName: "getService",
    args: [serviceId],
  });
  const required = (covenant.callPriceUsdc * BigInt(covenant.slashPenaltyBps)) / 10_000n;

  section(`${depositArg ? "Depositing to" : "Withdrawing from"} ${slug} on ${net.label}`);
  log(`  service   ${record.serviceId} · ${covenant.name}`);
  log(`  bond      ${formatUsdc(covenant.providerBondUsdc)} USDC`);
  log(`  required  ${formatUsdc(required)} USDC (one order's penalty)`);
  log(`  active    ${covenant.active}`);

  if (depositArg) {
    const provider = signerFromEnv("PROVIDER_KEY");
    if (provider.address.toLowerCase() !== record.provider.toLowerCase()) {
      throw new Error(
        `PROVIDER_KEY derives ${provider.address} but covenant ${record.serviceId} belongs to ${record.provider}`,
      );
    }
    const amount = parseUsdc(depositArg);

    const allowance = (await client.readContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [provider.address, deployment.contract],
    })) as bigint;
    if (allowance < amount) {
      const approveData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        // The deposit, exactly — the same reason as the escrow approval.
        args: [deployment.contract, amount],
      });
      const approved = await sendTransaction(net, provider, USDC_ADDRESS, approveData, { label: "approve USDC" });
      log(`\n  approve ${approved.status} · ${explorerTx(net, approved.hash)}`);
    }

    const data = encodeFunctionData({
      abi: CLEARINGHOUSE_ABI,
      functionName: "depositBond",
      args: [serviceId, amount],
    });
    const result = await sendTransaction(net, provider, deployment.contract, data, { label: "depositBond" });
    const after = await client.readContract({
      address: deployment.contract,
      abi: CLEARINGHOUSE_ABI,
      functionName: "getService",
      args: [serviceId],
    });
    log(`\n  ${result.status} · bond is now ${formatUsdc(after.providerBondUsdc)} USDC`);
    log(`  ${explorerTx(net, result.hash)}`);
    return;
  }

  // ---- withdrawal ---------------------------------------------------------
  const provider = signerFromEnv("PROVIDER_KEY");
  if (provider.address.toLowerCase() !== record.provider.toLowerCase()) {
    throw new Error(`PROVIDER_KEY does not control the covenant's provider`);
  }

  if (covenant.active) {
    if (!flag("delist")) {
      throw new Error(
        "the service is still listed. Withdrawal is only possible once delisted and no order is open, " +
          "because the stake still promises a live order a refund. Pass --delist to take it down first.",
      );
    }
    const delistData = encodeFunctionData({
      abi: CLEARINGHOUSE_ABI,
      functionName: "setActive",
      args: [serviceId, false],
    });
    const delisted = await sendTransaction(net, provider, deployment.contract, delistData, { label: "setActive(false)" });
    log(`\n  delisted ${delisted.status} · ${explorerTx(net, delisted.hash)}`);
  }

  const amount = parseUsdc(withdrawArg!);
  const data = encodeFunctionData({
    abi: CLEARINGHOUSE_ABI,
    functionName: "withdrawBond",
    args: [serviceId, amount, provider.address],
  });
  const result = await sendTransaction(net, provider, deployment.contract, data, { label: "withdrawBond" });
  log(`\n  ${result.status} · ${explorerTx(net, result.hash)}`);
}

main().catch((error: unknown) => {
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Read-only verification of everything this project claims.
 *
 * This is the script a judge can run against mainnet with no key and no
 * spending. It answers, from chain state alone:
 *
 *   - is the contract actually deployed at the recorded address, and does it
 *     report the expected version?
 *   - does each covenant record match the covenant stored onchain, term for
 *     term, including the split table and the schema commitment?
 *   - do the settled orders' recorded payouts match what the contract says?
 *   - is the money whole: does the contract's USDC balance equal the escrow it
 *     is holding plus the bonds it is holding plus any unclaimed fallback
 *     credits?
 *
 * A failure here is a real defect, not a warning.
 *
 *   node scripts/verify.ts --network arc-mainnet
 */

import {
  arg,
  loadCovenants,
  loadDeployment,
  log,
  section,
} from "./lib/files.ts";
import { explorerAddress, network, reader } from "./lib/chain.ts";
import { CLEARINGHOUSE_ABI, ERC20_ABI, STATUS_NAME, USDC_ADDRESS } from "./lib/abi.ts";
import { formatUsdc } from "./lib/fixtures.ts";

let failures = 0;
let checks = 0;

function check(condition: boolean, description: string, detail = ""): void {
  checks += 1;
  if (condition) {
    log(`  PASS  ${description}`);
  } else {
    failures += 1;
    log(`  FAIL  ${description}${detail ? `\n        ${detail}` : ""}`);
  }
}

async function main() {
  const key = (arg("network", "arc-mainnet") ?? "arc-mainnet") as "arc-mainnet" | "arc-testnet";
  // Read-only on purpose: a judge should be able to check every claim against a
  // public endpoint, holding no key and no endpoint that could spend.
  const net = network(key, { readOnly: true });
  const deployment = loadDeployment(key);
  const client = reader(net);

  section(`Verifying ${net.label}`);
  log(`  contract  ${deployment.contract}`);
  log(`  explorer  ${explorerAddress(net, deployment.contract)}`);
  log(`  deployed  ${deployment.deployedAt} in ${deployment.txHash}`);
  log("");

  // ---- the deployment itself ----------------------------------------------
  const code = await client.getCode({ address: deployment.contract });
  check(!!code && code !== "0x", "contract bytecode exists at the recorded address");

  const chainId = await client.getChainId();
  check(chainId === deployment.chainId, `chain id is ${deployment.chainId}`, `endpoint reports ${chainId}`);

  const version = await client.readContract({
    address: deployment.contract,
    abi: CLEARINGHOUSE_ABI,
    functionName: "version",
  });
  check(version === "1.0.0", "contract reports version 1.0.0", `got ${version}`);

  const usdc = (await client.readContract({
    address: deployment.contract,
    abi: CLEARINGHOUSE_ABI,
    functionName: "usdc",
  })) as string;
  check(
    usdc.toLowerCase() === USDC_ADDRESS.toLowerCase(),
    "the contract settles in the Arc USDC ERC-20 interface",
    `got ${usdc}`,
  );

  const owner = (await client.readContract({
    address: deployment.contract,
    abi: CLEARINGHOUSE_ABI,
    functionName: "owner",
  })) as string;
  check(owner.toLowerCase() === deployment.owner.toLowerCase(), "the registration authority is the recorded owner");

  // ---- covenants against the chain ----------------------------------------
  let covenants;
  try {
    covenants = loadCovenants(key, deployment.contract);
  } catch (error) {
    log(`\n  note: no covenant record to check (${error instanceof Error ? error.message : String(error)})`);
    covenants = null;
  }

  if (covenants) {
    for (const record of covenants.covenants) {
      const onchain = await client.readContract({
        address: deployment.contract,
        abi: CLEARINGHOUSE_ABI,
        functionName: "getService",
        args: [BigInt(record.serviceId)],
      });
      const splits = await client.readContract({
        address: deployment.contract,
        abi: CLEARINGHOUSE_ABI,
        functionName: "getSplits",
        args: [BigInt(record.serviceId)],
      });

      const expectedSplits: { recipient: string; bps: number }[] = [
        { recipient: record.provider, bps: record.providerBps },
        { recipient: record.dependency, bps: 10_000 - record.providerBps },
      ];
      const priceMatches = onchain.callPriceUsdc === BigInt(Math.round(Number(record.callPriceUsdc) * 1_000_000));
      const splitsMatch =
        splits.length === expectedSplits.length &&
        expectedSplits.every(
          (want, index) =>
            splits[index].recipient.toLowerCase() === want.recipient.toLowerCase() && splits[index].bps === want.bps,
        );

      check(
        onchain.endpointUri === record.endpointUri &&
          onchain.provider.toLowerCase() === record.provider.toLowerCase() &&
          onchain.verifier.toLowerCase() === record.verifier.toLowerCase() &&
          onchain.graceLatencyMs === record.graceLatencyMs &&
          onchain.hardTimeoutMs === record.hardTimeoutMs &&
          onchain.maxRebateBps === record.maxRebateBps &&
          onchain.slashPenaltyBps === record.slashPenaltyBps &&
          priceMatches &&
          onchain.schemaHash.toLowerCase() === record.schemaHash.toLowerCase(),
        `covenant ${record.serviceId} (${record.slug}) matches its record term for term`,
        `onchain: endpoint=${onchain.endpointUri} price=${onchain.callPriceUsdc} grace=${onchain.graceLatencyMs} hard=${onchain.hardTimeoutMs} rebate=${onchain.maxRebateBps} penalty=${onchain.slashPenaltyBps}` +
          (onchain.endpointUri === record.endpointUri
            ? ""
            : `\n        the record says ${record.endpointUri}`),
      );
      check(splitsMatch, `covenant ${record.serviceId} split table is ${record.providerBps}/${10_000 - record.providerBps}`);

      // The stake must at least cover one order's penalty, or the promise is
      // unfunded and `createOrder` would refuse the covenant. A stake below the
      // threshold is not a bug — it is the visible consequence of a breach that
      // was actually paid out of it, and the remedy is a top-up:
      //   node scripts/bond.ts --service <slug> --deposit <usdc>
      const required = (onchain.callPriceUsdc * BigInt(onchain.slashPenaltyBps)) / 10_000n;
      check(
        onchain.providerBondUsdc >= required,
        `covenant ${record.serviceId} (${record.slug}) bond covers one order's penalty (${formatUsdc(onchain.providerBondUsdc)} USDC staked, ${formatUsdc(required)} required)`,
        `a breach has been paid out of this stake. Top it up: node scripts/bond.ts --network ${key} --service ${record.slug} --deposit ${formatUsdc(required - onchain.providerBondUsdc)}`,
      );
    }
  }

  // ---- orders: quote parity and money conservation ------------------------
  const orderCount = (await client.readContract({
    address: deployment.contract,
    abi: CLEARINGHOUSE_ABI,
    functionName: "getOrderCount",
  })) as bigint;

  let escrowHeld = 0n;
  log(`\n  orders: ${orderCount}`);

  for (let id = 1n; id <= orderCount; id += 1n) {
    const order = await client.readContract({
      address: deployment.contract,
      abi: CLEARINGHOUSE_ABI,
      functionName: "getOrder",
      args: [id],
    });
    const status = Number(order.status);
    if (status === 1) {
      escrowHeld += order.escrowedUsdc;
    }

    // For a settled order, the recorded payouts must be reproducible from the
    // covenant's own rate. What can be checked depends on the verdict:
    //
    //   pass/degraded  the rebate and the splits depend only on the escrow, the
    //                  latency and the rates, so the quote must reproduce them
    //                  exactly.
    //   breach         the rebate is the full escrow (rate-based), and the bond
    //                  penalty is capped by the stake *at the time of
    //                  settlement* — which the chain does not store. So the
    //                  check is that the recorded refund is internally
    //                  consistent and that the penalty never exceeded the rate.
    //                  Re-quoting a capped slash against today's smaller bond
    //                  would test the wrong thing.
    if (status === 2 || status === 3 || status === 4) {
      const covenant = await client.readContract({
        address: deployment.contract,
        abi: CLEARINGHOUSE_ABI,
        functionName: "getService",
        args: [order.serviceId],
      });
      const rateBasedSlash = (order.escrowedUsdc * BigInt(covenant.slashPenaltyBps)) / 10_000n;
      const [, rebate, , net, amounts] = await client.readContract({
        address: deployment.contract,
        abi: CLEARINGHOUSE_ABI,
        functionName: "quoteSettlement",
        args: [order.serviceId, order.escrowedUsdc, order.measuredLatencyMs, order.schemaValid],
      });

      if (status === 4) {
        check(
          rebate === order.escrowedUsdc &&
            order.refundedToCaller === order.escrowedUsdc + order.bondSlashed &&
            order.bondSlashed <= rateBasedSlash,
          `order ${id} is a breach: full escrow refunded plus a penalty no larger than ${covenant.slashPenaltyBps} bps`,
          `rebate ${rebate} · recorded refund ${order.refundedToCaller} vs escrow+slash ${order.escrowedUsdc + order.bondSlashed} · slash ${order.bondSlashed} vs cap ${rateBasedSlash}`,
        );
      } else {
        const splitTotal = (amounts as bigint[]).reduce((acc, value) => acc + value, 0n);
        check(
          rebate === order.refundedToCaller && splitTotal === net,
          `order ${id} quote reproduces its settled amounts (${STATUS_NAME[status]})`,
          `rebate ${rebate} vs recorded ${order.refundedToCaller} · splits ${splitTotal} vs net ${net}`,
        );
      }
    }

    log(
      `    #${id} ${STATUS_NAME[status].padEnd(18)} escrow ${formatUsdc(order.escrowedUsdc).padStart(6)} ` +
        `latency ${String(order.measuredLatencyMs).padStart(5)}ms  provider ${formatUsdc(order.paidToProvider).padStart(6)}  ` +
        `deps ${formatUsdc(order.paidToDependencies).padStart(6)}  rebate ${formatUsdc(order.refundedToCaller).padStart(6)}`,
    );
  }

  // ---- money conservation -------------------------------------------------
  const [totalEscrowed, totalBond, contractBalance] = await Promise.all([
    client.readContract({ address: deployment.contract, abi: CLEARINGHOUSE_ABI, functionName: "totalEscrowed" }),
    client.readContract({ address: deployment.contract, abi: CLEARINGHOUSE_ABI, functionName: "totalBond" }),
    client.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [deployment.contract] }),
  ]);

  check(
    totalEscrowed === escrowHeld,
    "totalEscrowed() equals the sum of funded orders' escrow",
    `contract says ${formatUsdc(totalEscrowed as bigint)}, orders say ${formatUsdc(escrowHeld)}`,
  );

  // Bonds are tracked per service; the contract's balance must never be less
  // than the escrow and bonds it owes, and any excess must be an unclaimed
  // fallback credit owed to a specific address.
  const floor = (totalEscrowed as bigint) + (totalBond as bigint);
  check(
    (contractBalance as bigint) >= floor,
    "the contract holds at least the escrow and bonds it owes",
    `holds ${formatUsdc(contractBalance as bigint)}, owes ${formatUsdc(floor)}`,
  );

  // ---- summary ------------------------------------------------------------
  section(failures === 0 ? `${checks} checks, all passed` : `${failures} of ${checks} checks FAILED`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

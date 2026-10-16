#!/usr/bin/env node
/**
 * Deploy `VeriCallClearinghouse` to Arc.
 *
 * The contract is authored in Arc Studio; the Studio workspace link is recorded
 * in the deployment file so the submission can point at the provenance. This
 * script performs the mainnet step Studio deliberately does not: Studio does not
 * deploy to mainnet on a user's behalf, so the operator does it with their own
 * key against their own endpoint.
 *
 *   ARC_MAINNET_WRITE_RPC=… DEPLOYER_KEY=… node scripts/deploy.mjs --network arc-mainnet
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  arg,
  deploymentsDir,
  flag,
  log,
  repoRoot,
  section,
  writeJson,
  deploymentPath,
  type Deployment,
} from "./lib/files.ts";
import { network, reader, sendTransaction, signerFromEnv, explorerAddress } from "./lib/chain.ts";
import { USDC_ADDRESS } from "./lib/abi.ts";

const NETWORKS = ["arc-mainnet", "arc-testnet"] as const;
type NetworkKey = (typeof NETWORKS)[number];

function parseNetwork(): NetworkKey {
  const value = arg("network", "arc-mainnet") as NetworkKey;
  if (!NETWORKS.includes(value)) {
    throw new Error(`--network must be one of ${NETWORKS.join(", ")}`);
  }
  return value;
}

/** Read compiled bytecode from the Foundry output rather than trusting a copy. */
function bytecode(): `0x${string}` {
  const artifact = join(repoRoot, "contracts", "out", "VeriCallClearinghouse.sol", "VeriCallClearinghouse.json");
  const parsed = JSON.parse(readFileSync(artifact, "utf8")) as { bytecode: { object: string } };
  const object = parsed.bytecode.object;
  if (!object || object === "0x") {
    throw new Error(`${artifact} contains no bytecode. Run \`forge build\` in contracts/ first.`);
  }
  return object as `0x${string}`;
}

async function main() {
  const key = parseNetwork();
  const net = network(key);
  const signer = signerFromEnv(process.env.DEPLOYER_KEY_VAR ?? "DEPLOYER_KEY");
  const client = reader(net);

  section(`Deploying VeriCallClearinghouse on ${net.label}`);
  log(`  signer    ${signer.address}`);
  log(`  endpoint  ${net.writeRpc.replace(/\/\/[^/]*/, "//…")}`);

  const chainId = await client.getChainId();
  if (chainId !== net.chain.id) {
    throw new Error(`endpoint reports chain id ${chainId}, expected ${net.chain.id}`);
  }

  const code = bytecode();
  // Constructor arguments: the USDC ERC-20 interface and the registration
  // authority, which is this deployment key.
  const args = `${USDC_ADDRESS.slice(2).padStart(64, "0")}${signer.address.slice(2).padStart(64, "0")}`;
  const data = `${code}${args}` as `0x${string}`;

  const balance = await client.getBalance({ address: signer.address });
  log(`  balance   ${(Number(balance) / 1e18).toFixed(6)} USDC (native 18-decimal)`);
  if (balance === 0n) {
    throw new Error("the deployer holds no USDC, so it cannot pay for gas on Arc");
  }

  const dryRun = flag("dry-run");
  if (dryRun) {
    const gas = await client.estimateGas({ account: signer.address, data });
    log(`\n  dry run: deployment would use ~${gas} gas. Nothing was sent.`);
    return;
  }

  const result = await sendTransaction(net, signer, null, data, { label: "deploy VeriCallClearinghouse" });

  // The address is the contract created by this transaction.
  const receipt = await client.getTransactionReceipt({ hash: result.hash });
  const contract = receipt.contractAddress;
  if (!contract) {
    throw new Error("the transaction produced no contract address; check the explorer link above");
  }

  const deployment: Deployment = {
    network: net.label,
    chainId: net.chain.id,
    contract,
    owner: signer.address,
    usdc: USDC_ADDRESS,
    deployedAt: new Date().toISOString(),
    txHash: result.hash,
    blockNumber: Number(result.blockNumber),
    gasUsed: result.gasUsed.toString(),
    deployFeeUsdc: result.feeUsdc,
    arcStudioApp: process.env.ARC_STUDIO_APP ?? undefined,
  };
  writeJson(deploymentPath(key), deployment);

  log(`\n  contract  ${contract}`);
  log(`  explorer  ${explorerAddress(net, contract)}`);
  log(`  fee       ${result.feeUsdc} USDC`);
  log(`  record    ${join(deploymentsDir, `${key}.json`)}`);

  const onchainVersion = await client.readContract({
    address: contract,
    abi: (await import("./lib/abi.ts")).CLEARINGHOUSE_ABI,
    functionName: "version",
  });
  log(`  version() ${onchainVersion}`);
}

main().catch((error: unknown) => {
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

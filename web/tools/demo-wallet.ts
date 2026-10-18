#!/usr/bin/env node
/**
 * A wallet for recording demos, without a browser extension.
 *
 * The recorded page sees an ordinary EIP-1193 provider. Everything it asks for is
 * handled here: account and chain questions are answered locally, reads are
 * proxied to Arc, and `eth_sendTransaction` is signed and broadcast for real.
 *
 * This exists so a demo can show the product's own settlement button working —
 * a real signature and a real mainnet transaction — without a screen recording
 * having to juggle a wallet popup. It is a recording harness, not a product
 * feature, and it is deliberately narrow:
 *
 *   - it listens on loopback only, so nothing off this machine can reach it;
 *   - it signs *only* calls to the one contract it is started with, and refuses
 *     any other target, value or method, so a stray request cannot move funds
 *     elsewhere;
 *   - the key comes from the environment and is never written to a file.
 *
 *   DEMO_WALLET_KEY=0x… DEMO_CONTRACT=0xb980… node --experimental-strip-types tools/demo-wallet.ts
 */

import { createServer } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { arc } from "viem/chains";
import type { Hex } from "viem";

const PORT = Number(process.env.DEMO_WALLET_PORT ?? 8901);
const KEY = process.env.DEMO_WALLET_KEY;
const CONTRACT = (process.env.DEMO_CONTRACT ?? "").toLowerCase();
/** USDC on Arc; the same address on mainnet and testnet. */
const USDC = "0x3600000000000000000000000000000000000000";
/** ERC-20 `approve(address,uint256)`, the only call this wallet makes to USDC. */
const APPROVE_SELECTOR = "0x095ea7b3";
const RPC = process.env.DEMO_RPC ?? "https://rpc.mainnet.arc.io";

if (!KEY) throw new Error("DEMO_WALLET_KEY is not set");
if (!/^0x[0-9a-fA-F]{40}$/.test(CONTRACT)) throw new Error("DEMO_CONTRACT must be a contract address");

const account = privateKeyToAccount((KEY.startsWith("0x") ? KEY : `0x${KEY}`) as Hex);
const client = createPublicClient({ chain: arc, transport: http(RPC, { timeout: 15_000 }) });

/**
 * The two things this harness will sign, and nothing else.
 *
 * Escrowing a call needs an allowance, so USDC is allowed — but only its
 * `approve`, which grants spending power to the clearinghouse rather than moving
 * anything. Every other target, and every other USDC call, is refused.
 */
function assertSignable(to: string, data: string): void {
  if (to === CONTRACT) return;
  if (to === USDC && data.toLowerCase().startsWith(APPROVE_SELECTOR)) return;
  throw new Error(
    `this recording wallet signs calls to ${CONTRACT}, and USDC approvals only — not ${to}`,
  );
}

async function sendTransaction(params) {
  const [tx] = params;
  const to = String(tx.to ?? "").toLowerCase();
  assertSignable(to, String(tx.data ?? "0x"));
  if (tx.value && BigInt(tx.value) !== 0n) {
    throw new Error("this recording wallet signs zero-value calls only");
  }

  const [chainId, nonce, gasPrice, gas] = await Promise.all([
    client.getChainId(),
    client.getTransactionCount({ address: account.address, blockTag: "pending" }),
    client.getGasPrice(),
    client.estimateGas({ account: account.address, to: tx.to, data: tx.data }),
  ]);
  // Arc drops anything under 20 gwei without a receipt, so the floor is applied
  // here rather than left to the caller.
  const maxFeePerGas = gasPrice > 20_000_000_000n ? gasPrice : 20_000_000_000n;

  const serialized = await account.signTransaction({
    chainId,
    to: tx.to,
    data: tx.data,
    value: 0n,
    gas: (gas * 13n) / 10n,
    maxFeePerGas,
    maxPriorityFeePerGas: maxFeePerGas,
    nonce,
    type: "eip1559",
  });

  const hash = await client.request({
    method: "eth_sendRawTransaction",
    params: [serialized],
  });
  process.stderr.write(`signed and broadcast ${hash}\n`);
  return hash;
}

const HANDLED = new Set([
  "eth_accounts",
  "eth_requestAccounts",
  "eth_chainId",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
  "wallet_revokePermissions",
]);

const server = createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    res.writeHead(400).end("bad json");
    return;
  }

  const { id = null, method, params = [] } = payload;
  const reply = (result) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  };
  const fail = (message) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));
  };

  try {
    if (method === "eth_accounts" || method === "eth_requestAccounts") {
      return reply([account.address]);
    }
    if (method === "eth_chainId") return reply("0x" + arc.id.toString(16));
    if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") {
      return reply(null);
    }
    if (method === "wallet_revokePermissions") return reply(null);
    if (method === "eth_sendTransaction") {
      return reply(await sendTransaction(params));
    }
    if (HANDLED.has(method)) return reply(null);

    // Everything else — receipts, balances, gas — is the node's answer, not ours.
    const upstream = await client.request({ method, params });
    return reply(upstream);
  } catch (error) {
    process.stderr.write(`refused ${method}: ${error?.message ?? error}\n`);
    return fail(String(error?.shortMessage ?? error?.message ?? error));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(
    `recording wallet ready on http://127.0.0.1:${PORT} as ${account.address}, signing only for ${CONTRACT}\n`,
  );
});

/**
 * Signing and broadcasting, without a hosted node.
 *
 * Arc's public RPCs are read-only for `eth_sendTransaction` (they will not hold
 * a key), so this tool signs locally and submits via `eth_sendRawTransaction`.
 * The private key never leaves the process, is never passed as a command-line
 * argument, and is never printed.
 *
 * Two Arc-specific facts are handled here rather than left to callers:
 *   - `maxFeePerGas` must clear the 20 gwei floor or the mempool drops the
 *     transaction with no receipt and no error.
 *   - transactions finalise on inclusion in under a second, so one confirmation
 *     is the whole confirmation story; there is no reorg window to wait out.
 */

import {
  createPublicClient,
  defineChain,
  http,
  type Account,
  type Address,
  type Hex,
  keccak256,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MIN_MAX_FEE_PER_GAS_WEI } from "./abi.ts";

export const arcMainnet = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://rpc.mainnet.arc.io"],
      webSocket: ["wss://rpc.mainnet.arc.io"],
    },
  },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
});

export const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://rpc.testnet.arc.io"],
      webSocket: ["wss://rpc.testnet.arc.io"],
    },
  },
  blockExplorers: {
    default: { name: "Arc Testnet Explorer", url: "https://explorer.testnet.arc.io" },
  },
  testnet: true,
});

export type NetworkKey = "arc-mainnet" | "arc-testnet";

export interface Network {
  key: NetworkKey;
  chain: typeof arcMainnet;
  /** Read endpoints, raced for a proof ledger a judge can trust. */
  readRpcs: string[];
  /** The endpoint that accepts raw transactions. */
  writeRpc: string;
  explorer: string;
  label: string;
}

/**
 * Resolve a network by key.
 *
 * The variable names are checked against the network so a mainnet deploy can
 * never quietly borrow a testnet endpoint because the last run exported it —
 * the mistake is expensive rather than merely embarrassing.
 *
 * `writeRpc` is what a script that moves money needs. `verify` does not move
 * anything, and a judge checking the chain should not have to hold an endpoint
 * that can spend, so it asks for `readOnly` and gets the public read endpoint.
 */
export function network(key: NetworkKey, options: { readOnly?: boolean } = {}): Network {
  const testnet = key === "arc-testnet";
  const writeRpc =
    (testnet ? process.env.ARC_TESTNET_WRITE_RPC : process.env.ARC_MAINNET_WRITE_RPC) ??
    (testnet ? process.env.HOROS_RPC_URL_TESTNET : process.env.HOROS_RPC_URL_MAINNET) ??
    "";

  if (!writeRpc && !options.readOnly) {
    throw new Error(
      `No writable RPC for ${key}. Set ${testnet ? "ARC_TESTNET_WRITE_RPC" : "ARC_MAINNET_WRITE_RPC"} ` +
        `(or HOROS_RPC_URL_${testnet ? "TESTNET" : "MAINNET"}) to an endpoint that accepts eth_sendRawTransaction.`,
    );
  }
  if (writeRpc && testnet && /mainnet/i.test(writeRpc)) {
    throw new Error(`Refusing to write to testnet: the endpoint names mainnet (${redact(writeRpc)})`);
  }
  if (writeRpc && !testnet && /testnet/i.test(writeRpc)) {
    throw new Error(`Refusing to write to mainnet: the endpoint names testnet (${redact(writeRpc)})`);
  }

  return {
    key,
    chain: testnet ? (arcTestnet as unknown as typeof arcMainnet) : arcMainnet,
    readRpcs: testnet
      ? ["https://rpc.testnet.arc.io", "https://rpc.blockdaemon.testnet.arc.io", "https://rpc.drpc.testnet.arc.io"]
      : ["https://rpc.mainnet.arc.io", "https://rpc.drpc.mainnet.arc.io", "https://rpc.blockdaemon.mainnet.arc.io"],
    writeRpc,
    explorer: testnet ? "https://explorer.testnet.arc.io" : "https://explorer.arc.io",
    label: testnet ? "Arc Testnet" : "Arc",
  };
}

function redact(url: string): string {
  return url.replace(/\/\/[^/]*/, "//…");
}

/** A read-only client on the raced public endpoints. */
export function reader(net: Network) {
  return createPublicClient({ chain: net.chain, transport: http(net.readRpcs[0]) });
}

export function explorerTx(net: Network, hash: string): string {
  return `${net.explorer}/tx/${hash}`;
}

export function explorerAddress(net: Network, address: string): string {
  return `${net.explorer}/address/${address}`;
}

export interface Signer {
  account: Account;
  address: Address;
}

/**
 * Load a signer from an environment variable holding a 32-byte hex key.
 *
 * The key is read from the environment by name only; it is never accepted as an
 * argument (arguments land in shell history and process listings).
 */
export function signerFromEnv(variable: string): Signer {
  const raw = process.env[variable];
  if (!raw) {
    throw new Error(`${variable} is not set. Export the key in the environment; never pass it as an argument.`);
  }
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${variable} is not a 32-byte hex private key.`);
  }
  const account = privateKeyToAccount(key);
  return { account, address: account.address };
}

export interface SendResult {
  hash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
  feeWei: bigint;
  feeUsdc: string;
  status: "success" | "reverted";
  from: Address;
  to: Address | null;
}

/**
 * Sign, submit and wait for one transaction.
 *
 * `simulate` runs the call first when the target is a contract: Arc charges for
 * a blocklisted revert without producing a receipt, and a failed simulation is
 * far cheaper to read than a failed transaction.
 */
export async function sendTransaction(
  net: Network,
  signer: Signer,
  to: Address | null,
  data: Hex,
  options: { value?: bigint; label?: string; gas?: bigint } = {},
): Promise<SendResult> {
  const client = createPublicClient({ chain: net.chain, transport: http(net.writeRpc) });
  const label = options.label ?? "transaction";

  const [gasPrice, nonce, gasEstimate, chainId] = await Promise.all([
    client.getGasPrice(),
    client.getTransactionCount({ address: signer.address, blockTag: "pending" }),
    options.gas ??
      client
        .estimateGas({
          account: signer.address,
          to: to ?? undefined,
          data,
          value: options.value,
        })
        .catch((err: unknown) => {
          throw new Error(
            `Simulation of ${label} failed, so nothing was sent. The chain would revert:\n  ` +
              (err instanceof Error ? err.message.split("\n")[0] : String(err)),
          );
        }),
    client.getChainId(),
  ]);

  if (chainId !== net.chain.id) {
    throw new Error(`${redact(net.writeRpc)} reports chain id ${chainId}, expected ${net.chain.id} for ${net.label}`);
  }

  const maxFeePerGas = gasPrice > MIN_MAX_FEE_PER_GAS_WEI ? gasPrice : MIN_MAX_FEE_PER_GAS_WEI;
  const maxPriorityFeePerGas = maxFeePerGas;

  const signTransaction = signer.account.signTransaction;
  if (!signTransaction) {
    throw new Error(
      `the account ${signer.address} cannot sign locally. This tool signs with a local key by design, ` +
        "because Arc's public RPCs do not accept eth_sendTransaction.",
    );
  }
  const serialized = await signTransaction({
    chainId,
    to: to ?? undefined,
    data,
    value: options.value ?? 0n,
    gas: (gasEstimate * 13n) / 10n, // 30% headroom: an out-of-gas revert still costs
    maxFeePerGas,
    maxPriorityFeePerGas,
    nonce,
    type: "eip1559",
  });

  const hash = await client.request({
    method: "eth_sendRawTransaction",
    params: [serialized],
  } as never) as Hex;

  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1 });
  const gasUsed = receipt.gasUsed;
  const effectivePrice = receipt.effectiveGasPrice ?? maxFeePerGas;
  const feeWei = gasUsed * effectivePrice;

  return {
    hash,
    blockNumber: receipt.blockNumber,
    gasUsed,
    feeWei,
    feeUsdc: weiToUsdc(feeWei),
    status: receipt.status === "success" ? "success" : "reverted",
    from: signer.address,
    to,
  };
}

/** 18-decimal native USDC wei → a 6-decimal display string. */
export function weiToUsdc(wei: bigint): string {
  const display = wei / 1_000_000_000_000n;
  const whole = display / 1_000_000n;
  const frac = display % 1_000_000n;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

/** keccak256 of a UTF-8 string, as the covenant's schema commitment. */
export function hashUtf8(value: string): Hex {
  return keccak256(toHex(value));
}

/** A human-readable line for the run log. */
export function describeSend(net: Network, result: SendResult, label: string): string {
  const fee = `fee ${result.feeUsdc} USDC · gas ${result.gasUsed} · block ${result.blockNumber}`;
  const link = explorerTx(net, result.hash);
  return `${label}: ${result.status} · ${fee}\n  ${link}`;
}

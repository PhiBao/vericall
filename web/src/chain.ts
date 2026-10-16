/**
 * The Arc mainnet chain definition, wallet connection and settlement sending.
 *
 * Two decisions worth stating up front, because both are easy to get wrong:
 *
 * 1. Arc's native gas token is USDC with **18** decimals, while the USDC ERC-20
 *    interface at 0x3600…0000 carries **6**. They are different assets in the
 *    same currency: one pays for gas, the other is what the clearinghouse moves.
 *    This file only ever touches the native side (fees, value), which is why the
 *    18 is written once, in the chain definition, and the 6 never appears.
 *
 * 2. Reads go through the wallet's own JSON-RPC endpoint, not a hard-coded one.
 *    A settlement is only valid if the wallet and the contract agree on the
 *    chain, so the chain we verify against is the chain the wallet reports.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  isAddress,
  isHex,
  type Address,
  type Chain,
  type Hash,
} from "viem";
import type { PublicConfig } from "./types";

/* --------------------------------------------------------------- provider -- */

export interface Eip1193RequestArguments {
  method: string;
  params?: readonly unknown[];
}

/** The slice of EIP-1193 this app uses. */
export interface Eip1193Provider {
  request(args: Eip1193RequestArguments): Promise<unknown>;
  on?(event: string, handler: (payload: unknown) => void): void;
  removeListener?(event: string, handler: (payload: unknown) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export const walletAvailable = (): boolean =>
  typeof window !== "undefined" && window.ethereum !== undefined;

/* ------------------------------------------------------------------ chain -- */

/** Native gas on Arc is 18-decimal USDC. Not the ERC-20's 6. */
const ARC_NATIVE_CURRENCY = { name: "USDC", symbol: "USDC", decimals: 18 } as const;

export const ARC_MAINNET: Chain = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: ARC_NATIVE_CURRENCY,
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
});

/** The deployment facts a chain definition needs. `PublicConfig` satisfies it. */
export interface ChainFacts {
  chain_id: number;
  network: string;
  explorer: string;
  rpcs: string[];
}

/**
 * The chain a settlement must be sent on. When the verifier is pointed at Arc
 * mainnet (the normal case) this is exactly the definition above; when it is
 * pointed elsewhere, the chain is built from the verifier's own facts rather
 * than guessed.
 */
export function chainFor(config: ChainFacts | null): Chain {
  if (!config || config.chain_id === ARC_MAINNET.id) return ARC_MAINNET;
  const rpc = config.rpcs[0] ?? ARC_MAINNET.rpcUrls.default.http[0];
  return defineChain({
    id: config.chain_id,
    name: config.network,
    nativeCurrency: ARC_NATIVE_CURRENCY,
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: { default: { name: "Arc Explorer", url: config.explorer } },
  });
}

/** Arc's mempool silently drops transactions below this tip. Mirrors the
 *  verifier's `chain::MIN_MAX_FEE_PER_GAS_WEI`. */
export const ARC_MIN_MAX_FEE_PER_GAS_WEI = 20_000_000_000n;

export function toHexChainId(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}

/** A validated, checksummed address — or `null` when it is not an address. */
export function asAddress(value: string | null | undefined): Address | null {
  if (!value || !isAddress(value)) return null;
  return getAddress(value);
}

/**
 * Validated calldata. An empty blob is `null`, not "0 bytes of calldata": the
 * difference is the difference between a settlement that can be sent and one
 * that cannot, so it is decided here rather than by a length check at each use.
 */
export function asCalldata(value: string | null | undefined): Hash | null {
  if (!value || value.length <= 2) return null;
  return isHex(value, { strict: true }) ? value : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/* ----------------------------------------------------------------- errors -- */

function errorCode(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const raw = error.code;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function rawMessage(error: unknown): string | null {
  if (typeof error === "string") return error;
  if (!isRecord(error)) return null;
  for (const key of ["shortMessage", "message", "reason"]) {
    const value = error[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const data = error.data;
  if (isRecord(data) && typeof data.message === "string" && data.message.length > 0) {
    return data.message;
  }
  return null;
}

/** Wallet rejections are routine, not bugs: name them like a person would. */
export function walletErrorMessage(error: unknown): string {
  const code = errorCode(error);
  switch (code) {
    case 4001:
      return "the wallet rejected the request";
    case 4100:
      return "the wallet has not authorised this site yet";
    case 4200:
      return "this wallet does not implement the method the app needs";
    case 4900:
    case 4901:
      return "the wallet is not connected to a chain";
    case 4902:
      return "the wallet does not know Arc yet";
    case -32002:
      return "the wallet already has a pending request — open it and confirm";
    default:
      return rawMessage(error) ?? "the wallet request failed";
  }
}

/* -------------------------------------------------------------- switching -- */

function chainParams(chain: Chain): Record<string, unknown> {
  const explorer = chain.blockExplorers?.default.url;
  return {
    chainId: toHexChainId(chain.id),
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: chain.rpcUrls.default.http,
    blockExplorerUrls: explorer ? [explorer] : [],
  };
}

/** Ask the wallet to move to `chain`, adding it when the wallet has never seen it. */
export async function requestChainSwitch(provider: Eip1193Provider, chain: Chain): Promise<void> {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: toHexChainId(chain.id) }],
    });
  } catch (error) {
    const unknownChain =
      errorCode(error) === 4902 || /unrecognized|unknown chain/i.test(rawMessage(error) ?? "");
    if (!unknownChain) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [chainParams(chain)],
    });
  }
}

/* ---------------------------------------------------------------- receipts -- */

export interface ArcReceipt {
  transactionHash: Hash;
  status: "success" | "reverted";
  blockNumber: number | null;
  gasUsed: bigint | null;
  /** What the sender actually paid per unit of gas, in wei. */
  effectiveGasPriceWei: bigint | null;
}

function hexToBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function hexToNumber(value: unknown): number | null {
  const big = hexToBigInt(value);
  if (big === null) return null;
  return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : null;
}

function receiptFrom(json: unknown, hash: Hash): ArcReceipt | null {
  if (!isRecord(json)) return null;
  const status = json.status;
  if (status !== "0x1" && status !== "0x0") {
    // Mined but with no status field: report what is known rather than a guess.
    return { transactionHash: hash, status: "success", blockNumber: hexToNumber(json.blockNumber), gasUsed: hexToBigInt(json.gasUsed), effectiveGasPriceWei: hexToBigInt(json.effectiveGasPrice) };
  }
  return {
    transactionHash: hash,
    status: status === "0x1" ? "success" : "reverted",
    blockNumber: hexToNumber(json.blockNumber),
    gasUsed: hexToBigInt(json.gasUsed),
    effectiveGasPriceWei: hexToBigInt(json.effectiveGasPrice),
  };
}

/**
 * Poll the wallet's node until the settlement is mined.
 *
 * Returns `null` when the wait window closes with the transaction still pending:
 * a settlement that has been broadcast but not yet mined is not a failure, and
 * saying "confirmed" before a receipt exists would be a lie about money.
 */
export async function waitForReceipt(
  provider: Eip1193Provider,
  hash: Hash,
  timeoutMs = 90_000,
): Promise<ArcReceipt | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const json = await provider.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    });
    const receipt = receiptFrom(json, hash);
    if (receipt) return receipt;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => window.setTimeout(resolve, 1_500));
  }
}

/* --------------------------------------------------------------- useWallet -- */

export type WalletStatus =
  | "checking"
  | "unavailable"
  | "disconnected"
  | "connecting"
  | "connected";

export interface WalletController {
  status: WalletStatus;
  address: Address | null;
  chainId: number | null;
  /** True when the wallet is on the chain settlements must be sent on. */
  onSettlementChain: boolean;
  error: string | null;
  chain: Chain;
  connect: () => Promise<void>;
  switchToChain: () => Promise<void>;
  sendSettlement: (to: Address, data: Hash) => Promise<Hash>;
  waitForSettlement: (hash: Hash) => Promise<ArcReceipt | null>;
  clearError: () => void;
}

function parseChainId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) {
    const parsed = Number.parseInt(value, 16);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseAccount(value: unknown): Address | null {
  if (typeof value !== "string" || !isAddress(value)) return null;
  return getAddress(value);
}

export function useWallet(chain: Chain): WalletController {
  const [provider, setProvider] = useState<Eip1193Provider | null>(null);
  const [status, setStatus] = useState<WalletStatus>("checking");
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // EIP-1193 state changes arrive as events, so the UI never has to poll.
  useEffect(() => {
    if (typeof window === "undefined") {
      setStatus("unavailable");
      return;
    }
    const injected = window.ethereum ?? null;
    setProvider(injected);
    if (!injected) {
      setStatus("unavailable");
      return;
    }

    let cancelled = false;
    const read = async (): Promise<void> => {
      try {
        const [accounts, walletChainId] = await Promise.all([
          injected.request({ method: "eth_accounts" }),
          injected.request({ method: "eth_chainId" }),
        ]);
        if (cancelled) return;
        const list = Array.isArray(accounts) ? accounts : [];
        const first = parseAccount(list[0]);
        setAddress(first);
        setChainId(parseChainId(walletChainId));
        setStatus(first ? "connected" : "disconnected");
      } catch (cause) {
        if (cancelled) return;
        setStatus("disconnected");
        setError(walletErrorMessage(cause));
      }
    };
    void read();

    const onAccounts = (payload: unknown): void => {
      const list = Array.isArray(payload) ? payload : [];
      const first = parseAccount(list[0]);
      setAddress(first);
      setStatus(first ? "connected" : "disconnected");
    };
    const onChain = (payload: unknown): void => {
      setChainId(parseChainId(payload));
    };

    injected.on?.("accountsChanged", onAccounts);
    injected.on?.("chainChanged", onChain);
    return () => {
      cancelled = true;
      injected.removeListener?.("accountsChanged", onAccounts);
      injected.removeListener?.("chainChanged", onChain);
    };
  }, []);

  const connect = useCallback(async (): Promise<void> => {
    const injected = provider;
    if (!injected) {
      setError("no EIP-1193 wallet was found in this browser");
      setStatus("unavailable");
      return;
    }
    setError(null);
    setStatus("connecting");
    try {
      const accounts = await injected.request({ method: "eth_requestAccounts" });
      const list = Array.isArray(accounts) ? accounts : [];
      const first = parseAccount(list[0]);
      if (!first) throw new Error("the wallet returned no account");
      setAddress(first);
      setStatus("connected");
      setChainId(parseChainId(await injected.request({ method: "eth_chainId" })));
    } catch (cause) {
      setStatus("disconnected");
      setError(walletErrorMessage(cause));
    }
  }, [provider]);

  const switchToChain = useCallback(async (): Promise<void> => {
    const injected = provider;
    if (!injected) return;
    setError(null);
    try {
      await requestChainSwitch(injected, chain);
      setChainId(parseChainId(await injected.request({ method: "eth_chainId" })));
    } catch (cause) {
      setError(walletErrorMessage(cause));
    }
  }, [provider, chain]);

  const sendSettlement = useCallback(
    async (to: Address, data: Hash): Promise<Hash> => {
      const injected = provider;
      if (!injected) throw new Error("no wallet provider is available in this browser");
      if (!address) throw new Error("connect a wallet before settling");
      if (chainId !== chain.id) {
        throw new Error(
          `the wallet is on chain ${chainId ?? "unknown"}; a settlement is only valid on ${chain.name} (${chain.id})`,
        );
      }
      const client = createWalletClient({ chain, transport: custom(injected) });
      return client.sendTransaction({
        account: address,
        chain,
        to,
        data,
        // settleOrder moves USDC the contract already holds; it must not
        // require, and does not accept, a value transfer.
        value: 0n,
        // An under-priced transaction is not a cheap settlement, it is no
        // settlement: Arc drops anything below the 20 gwei tip floor. Doubling
        // the floor for the cap leaves room for a base-fee bump between
        // estimation and inclusion.
        maxFeePerGas: ARC_MIN_MAX_FEE_PER_GAS_WEI * 2n,
        maxPriorityFeePerGas: ARC_MIN_MAX_FEE_PER_GAS_WEI,
      });
    },
    [provider, address, chainId, chain],
  );

  const waitForSettlement = useCallback(
    async (hash: Hash): Promise<ArcReceipt | null> => {
      const injected = provider;
      if (!injected) throw new Error("no wallet provider is available in this browser");
      return waitForReceipt(injected, hash);
    },
    [provider],
  );

  const clearError = useCallback((): void => setError(null), []);

  const onSettlementChain = chainId === chain.id;

  return useMemo(
    () => ({
      status,
      address,
      chainId,
      onSettlementChain,
      error,
      chain,
      connect,
      switchToChain,
      sendSettlement,
      waitForSettlement,
      clearError,
    }),
    [
      status,
      address,
      chainId,
      onSettlementChain,
      error,
      chain,
      connect,
      switchToChain,
      sendSettlement,
      waitForSettlement,
      clearError,
    ],
  );
}

/**
 * A chain object with a stable identity for as long as the deployment does not
 * change, so wallet callbacks are not rebuilt on every render.
 */
export function useChain(config: PublicConfig | null): Chain {
  const chainId = config?.chain_id ?? ARC_MAINNET.id;
  const network = config?.network ?? ARC_MAINNET.name;
  const explorer = config?.explorer ?? ARC_MAINNET.blockExplorers?.default.url ?? "";
  const rpcs = config?.rpcs ?? [];
  return useMemo(
    () => chainFor({ chain_id: chainId, network, explorer, rpcs }),
    // The tuple is the whole identifying surface of a chain deployment.
    [chainId, network, explorer, rpcs],
  );
}

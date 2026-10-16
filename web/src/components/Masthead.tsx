import { Mark } from "./Mark";
import type { WalletController } from "../chain";
import { shortAddress } from "../types";
import { groupInt } from "../format";

/** What the masthead needs to know about the chain, normalised by `App`. */
export interface ChainFacts {
  network: string | null;
  chainId: number | null;
  blockNumber: number | null;
  latencyMs: number | null;
  /** Which Arc RPC endpoint answered. Shown, because it is part of the claim. */
  endpoint: string | null;
  error: string | null;
}

interface MastheadProps {
  chain: ChainFacts;
  loading: boolean;
  wallet: WalletController;
}

/** Live chain status: network, id, head, RPC latency, and which node answered. */
function ChainStatusChip({ chain, loading }: { chain: ChainFacts; loading: boolean }) {
  if (chain.error) {
    return (
      <div className="chain-status">
        <span className="tag tag--muted" title={chain.error}>
          chain unreachable
        </span>
        <span className="tiny muted mono">the verifier could not read Arc</span>
      </div>
    );
  }

  if (loading && chain.blockNumber === null) {
    return (
      <div className="chain-status">
        <span className="tag tag--muted">
          <span className="spinner" aria-hidden="true" /> reading Arc
        </span>
      </div>
    );
  }

  if (chain.blockNumber === null) {
    return (
      <div className="chain-status">
        <span className="tag tag--muted">no chain status</span>
      </div>
    );
  }

  return (
    <div className="chain-status">
      <div className="row">
        <span className="tag tag--verified">
          <span className="dot dot--live" aria-hidden="true" />
          {chain.network ?? "Arc"} · {chain.chainId ?? 5042}
        </span>
        <span className="mono small">block {groupInt(chain.blockNumber)}</span>
        {chain.latencyMs !== null ? (
          <span className="mono small muted">{groupInt(chain.latencyMs)} ms rpc</span>
        ) : null}
      </div>
      {chain.endpoint ? <span className="tiny mono muted wrap-anywhere">via {chain.endpoint}</span> : null}
    </div>
  );
}

/** Connect, or show who is connected and on which chain. */
function WalletControl({ wallet }: { wallet: WalletController }) {
  const { status, address, chainId, onSettlementChain, chain } = wallet;

  if (status === "unavailable") {
    return (
      <button
        type="button"
        className="button"
        disabled
        title="No EIP-1193 wallet was found in this browser. Open the page in a wallet browser, or install one, to settle onchain."
      >
        No wallet detected
      </button>
    );
  }

  if (status === "connected" && address) {
    return (
      <div className="row">
        <span className="mono small" title={address}>
          {shortAddress(address)}
        </span>
        {onSettlementChain ? (
          <span className="tag tag--verified" title={`the wallet is on ${chain.name} (${chain.id})`}>
            on {chain.name}
          </span>
        ) : (
          <>
            <span className="tag tag--degraded" title={`the wallet is on chain ${chainId ?? "unknown"}`}>
              chain {chainId ?? "?"}
            </span>
            <button type="button" className="button" onClick={() => void wallet.switchToChain()}>
              Switch to {chain.name}
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="button"
      onClick={() => void wallet.connect()}
      disabled={status === "connecting"}
    >
      {status === "connecting" ? (
        <>
          <span className="spinner" aria-hidden="true" /> Connecting
        </>
      ) : (
        "Connect wallet"
      )}
    </button>
  );
}

export function Masthead({ chain, loading, wallet }: MastheadProps) {
  return (
    <header className="masthead">
      <div className="brand">
        <Mark decorative />
        <div>
          <span className="brand__name">VeriCall</span>
          <span className="brand__promise">
            USDC in escrow for a software call, released against the promise that call published.
          </span>
        </div>
      </div>
      <div className="toolbar">
        <ChainStatusChip chain={chain} loading={loading} />
        <WalletControl wallet={wallet} />
      </div>
      {wallet.error ? (
        <div className="banner banner--warn banner--action" role="alert">
          <span>{wallet.error}</span>
          <button
            type="button"
            className="button button--quiet button--mono"
            onClick={() => wallet.clearError()}
          >
            dismiss
          </button>
        </div>
      ) : null}
    </header>
  );
}

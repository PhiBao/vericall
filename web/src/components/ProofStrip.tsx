import type { LedgerView } from "../types";
import { groupInt, sumUnits, unitsToFixed } from "../format";
import { verdictOfStatus } from "../types";

/**
 * The first thing a reader should see: what this contract has actually done.
 *
 * The numbers are computed from the clearinghouse's own order storage, not from
 * anything this page remembers, and each one links to the transaction that
 * proves it. A product whose argument is "look at the chain" should open with
 * the chain's own tally rather than a paragraph about it.
 *
 * Deliberately not shown: "0 escrow in flight". It is the invariant passing, but
 * as a headline it reads like nothing has happened.
 */
export interface Proof {
  settlements: number;
  outcomes: number;
  volume: string;
  staked: string;
  invariantOk: boolean;
  contract: string | null;
  explorer: string | null;
  lastTx: string | null;
}

export function proofFrom(ledger: LedgerView | null): Proof | null {
  if (!ledger) return null;
  const settled = ledger.orders.filter((order) => order.settled);
  const outcomes = new Set(settled.map((order) => verdictOfStatus(order.status)));
  const volume = sumUnits(ledger.orders.map((order) => order.escrowed_usdc));
  const lastWithTx = [...settled]
    .reverse()
    .find((order) => order.txs?.settled ?? order.txs?.reclaimed ?? null);

  return {
    settlements: settled.length,
    outcomes: outcomes.size,
    volume: volume === null ? "0" : unitsToFixed(volume),
    staked: ledger.total_bond_usdc,
    invariantOk: ledger.invariant_ok,
    contract: ledger.contract,
    explorer: ledger.explorer,
    lastTx: lastWithTx?.txs?.settled ?? lastWithTx?.txs?.reclaimed ?? null,
  };
}

function Cell({
  label,
  value,
  detail,
  href,
}: {
  label: string;
  value: string;
  detail?: string;
  href?: string | null;
}) {
  const body = (
    <>
      <span className="proof__label">{label}</span>
      <span className="proof__value mono">{value}</span>
      {detail ? <span className="proof__detail">{detail}</span> : null}
    </>
  );
  return href ? (
    <a className="proof__cell proof__cell--link" href={href} target="_blank" rel="noreferrer noopener">
      {body}
    </a>
  ) : (
    <div className="proof__cell">{body}</div>
  );
}

export function ProofStrip({ proof }: { proof: Proof | null }) {
  if (!proof) {
    return (
      <section className="proof" aria-label="What the contract has done">
        <div className="proof__cell">
          <span className="proof__label">reading the chain</span>
          <span className="proof__value mono">
            <span className="spinner" aria-hidden="true" /> —
          </span>
        </div>
      </section>
    );
  }

  const contractLink = proof.contract
    ? `${proof.explorer ?? "https://explorer.arc.io"}/address/${proof.contract}`
    : null;
  const txHref = proof.lastTx
    ? `${proof.explorer ?? "https://explorer.arc.io"}/tx/${proof.lastTx}`
    : null;

  return (
    <section className="proof" aria-label="What the contract has done">
      <Cell
        label="settled calls"
        value={groupInt(proof.settlements)}
        detail={`${proof.outcomes} of 4 outcomes exercised`}
        href={txHref}
      />
      <Cell
        label="USDC through the contract"
        value={proof.volume}
        detail="escrowed, paid, rebated and refunded"
      />
      <Cell label="staked against promises" value={proof.staked} detail="provider bonds, slashable" />
      <Cell
        label="invariant"
        value={proof.invariantOk ? "holds" : "broken"}
        detail="sum(funded escrow) = totalEscrowed()"
      />
      <Cell
        label="clearinghouse"
        value={proof.contract ? `${proof.contract.slice(0, 8)}…${proof.contract.slice(-6)}` : "not deployed"}
        detail="bytecode on Arc mainnet"
        href={contractLink}
      />
    </section>
  );
}

import type { LedgerView } from "../types";
import { proofFrom, ProofStrip } from "./ProofStrip";

/**
 * The first screen.
 *
 * One claim, one sentence of mechanism, then the chain's own tally. The long
 * explanation of how settlement works lives further down: a reader who is going
 * to bounce should bounce having seen what the contract has actually done, not
 * having read a definition of an SLA.
 */
export function Hero({ ledger, onRun }: { ledger: LedgerView | null; onRun: () => void }) {
  const proof = proofFrom(ledger);
  return (
    <section className="hero" aria-labelledby="hero-heading">
      <p className="hero__kicker">Software pays software · Arc mainnet · USDC</p>
      <h1 className="hero__headline" id="hero-heading">
        Pay for a software call only if it arrives on time and in the right shape.
      </h1>
      <p className="hero__lede">
        The money sits in escrow while the call runs. The contract then pays the provider and its
        upstream dependencies, rebates you for the overrun, or refunds you and takes the penalty out
        of the provider&rsquo;s stake — measured, not negotiated.
      </p>
      <div className="hero__actions">
        <button type="button" className="button button--primary" onClick={onRun}>
          Run a live call
        </button>
        <span className="hero__hint">
          one real HTTP request, measured, validated and quoted — about a second
        </span>
      </div>
      <ProofStrip proof={proof} />
    </section>
  );
}

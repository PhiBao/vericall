import type { LedgerView } from "../types";
import { Balances } from "./Balances";
import { addressLink, groupInt, usdcFixed } from "../format";

interface ProofLedgerProps {
  ledger: LedgerView | null;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}

/**
 * The clearing record: the invariant, the chain it was read from, and the
 * balances.
 *
 * What lives here is what reads well in a column — a verdict, the facts of a
 * read, and three addresses with their two USDC balances. The tables that want
 * width and comparison (the covenants and the settled orders) live in their own
 * full-width bands below. Every figure is a view call on the deployed contract;
 * when a read fails the panel says so and stays empty rather than showing a
 * plausible number.
 */
export function ProofLedger({ ledger, error, refreshing, onRefresh }: ProofLedgerProps) {
  const contractLink = ledger ? addressLink(ledger.explorer, ledger.contract) : null;
  return (
    <section className="panel" aria-labelledby="ledger-heading">
      <div className="panel__head">
        <h2 className="panel__title" id="ledger-heading">
          What the chain did
        </h2>
        <div className="row">
          {ledger ? (
            <span className="panel__note mono">
              {ledger.chain.network} · block {groupInt(ledger.chain.block_number)}
            </span>
          ) : (
            <span className="panel__note">live Arc state</span>
          )}
          <button type="button" className="button button--quiet" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? (
              <>
                <span className="spinner" aria-hidden="true" /> reading
              </>
            ) : (
              "Refresh"
            )}
          </button>
        </div>
      </div>

      <div className="panel__body stack">
        {error ? (
          <div className="stack--tight">
            <p className="banner banner--error" role="alert">
              The ledger could not be read from Arc: {error}
            </p>
            <p className="small muted">
              Nothing here is cached or defaulted, so a failed read leaves the ledger empty rather
              than showing a plausible number.
            </p>
          </div>
        ) : null}

        {!ledger && !error ? (
          <p className="small muted">
            <span className="spinner" aria-hidden="true" /> Reading the clearinghouse from Arc…
          </p>
        ) : null}

        {ledger ? (
          <>
            <div className="stack--tight">
              <div className="row">
                <span className={ledger.invariant_ok ? "tag tag--pass" : "tag tag--breach"}>
                  {ledger.invariant_ok ? "invariant holds" : "invariant broken"}
                </span>
                <span className="mono tiny">sum(funded escrow) = totalEscrowed()</span>
              </div>
              <p className="small">{ledger.invariant_note}</p>
            </div>

            <div className="facts">
              <div>
                <div className="fact__label">RPC endpoint</div>
                <div className="hash wrap-anywhere">{ledger.chain.endpoint}</div>
              </div>
              <div>
                <div className="fact__label">Chain</div>
                <div className="fact__value">
                  {ledger.chain.network} · {ledger.chain.chain_id}
                </div>
              </div>
              <div>
                <div className="fact__label">Block</div>
                <div className="fact__value">{groupInt(ledger.chain.block_number)}</div>
              </div>
              <div>
                <div className="fact__label">RPC latency</div>
                <div className="fact__value">{groupInt(ledger.chain.latency_ms)} ms</div>
              </div>
              <div>
                <div className="fact__label">Clearinghouse</div>
                {ledger.contract ? (
                  contractLink ? (
                    <a
                      className="fact__value fact__value--small fact__value--wrap"
                      href={contractLink}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {ledger.contract}
                    </a>
                  ) : (
                    <div className="fact__value fact__value--small fact__value--wrap">
                      {ledger.contract}
                    </div>
                  )
                ) : (
                  <div className="fact__value fact__value--small muted">not deployed</div>
                )}
              </div>
              <div>
                <div className="fact__label">Escrow in flight</div>
                <div className="fact__value">{usdcFixed(ledger.total_escrowed_usdc)}</div>
              </div>
              <div>
                <div className="fact__label">Total bond</div>
                <div className="fact__value">{usdcFixed(ledger.total_bond_usdc)}</div>
              </div>
              <div>
                <div className="fact__label">Open orders</div>
                <div className="fact__value">{ledger.open_orders}</div>
              </div>
            </div>

            <hr className="hairline" />
            <h3 className="fact__label">Watched balances</h3>
            <Balances balances={ledger.balances} explorer={ledger.explorer} />

            <p className="tiny muted">
              USDC ERC-20 at <code>{ledger.usdc}</code> (6 decimals). Native gas is 18-decimal USDC
              on the same chain; the two are never added together.
            </p>
          </>
        ) : null}
      </div>
    </section>
  );
}

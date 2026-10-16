import type { BalanceView } from "../types";
import { shortAddress } from "../types";
import { addressLink } from "../format";

interface BalancesProps {
  balances: BalanceView[];
  explorer: string | null;
}

const ROLE_LABEL: Partial<Record<BalanceView["role"], string>> = {
  caller: "caller",
  provider: "provider",
  dependency: "dependency",
  watched: "watched",
};

/**
 * The watched-address strip.
 *
 * `native_usdc` and `usdc` are both USDC, but they are read from different
 * places: the native balance is the 18-decimal gas token (the verifier scales it
 * down to display units before sending it), and `usdc` is the 6-decimal ERC-20 at
 * 0x3600…0000 that the clearinghouse actually moves. They are never summed here,
 * because they are not the same asset.
 */
export function Balances({ balances, explorer }: BalancesProps) {
  if (balances.length === 0) {
    return (
      <p className="small muted">
        No addresses are being watched, so there are no balances to show. The watch list is set on
        the verifier at startup, not in this page.
      </p>
    );
  }

  return (
    <div className="stack--tight">
      <div className="facts">
        {balances.map((balance) => {
          const link = addressLink(explorer, balance.address);
          const role = ROLE_LABEL[balance.role] ?? String(balance.role);
          return (
            <div key={balance.address}>
              <div className="fact__label">{role}</div>
              {link ? (
                <a
                  className="mono small"
                  href={link}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={`${balance.address} — open on the explorer`}
                >
                  {shortAddress(balance.address)}
                </a>
              ) : (
                <span className="mono small" title={balance.address}>
                  {shortAddress(balance.address)}
                </span>
              )}
              <div className="row">
                <span className="mono">{balance.native_usdc}</span>
                <span className="tiny muted">native gas · 18 dp</span>
              </div>
              <div className="row">
                <span className="mono">{balance.usdc}</span>
                <span className="tiny muted">usdc · 6 dp</span>
              </div>
            </div>
          );
        })}
      </div>
      <p className="tiny muted">
        Two balances per address because Arc carries two forms of USDC: the 18-decimal native gas
        token, and the 6-decimal ERC-20 at 0x3600…0000 that the clearinghouse escrows. Neither is a
        converted copy of the other.
      </p>
    </div>
  );
}

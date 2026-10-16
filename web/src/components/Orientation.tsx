import { addressLink } from "../format";

interface OrientationProps {
  contract: string | null;
  explorer: string | null;
}

/**
 * Two sentences and a link. This is the part a judge reads first, so it is
 * prose rather than a feature grid — and it says what the thing is for.
 */
export function Orientation({ contract, explorer }: OrientationProps) {
  const link = addressLink(explorer, contract);
  return (
    <section aria-labelledby="orientation-heading">
      <hr className="hairline" />
      <div className="row--between">
        <p className="lede" id="orientation-heading">
          VeriCall escrows USDC for one API call and settles it against the promise that API
          published: a grace latency, a hard timeout, a maximum rebate and a response schema. Inside
          the grace window the provider and its upstream dependencies are paid; an overrun rebates
          the caller linearly; a timeout or a schema violation refunds the caller and slashes the
          provider&rsquo;s staked bond.
        </p>
        <div className="stack--tight">
          <span className="fact__label">Settlement contract</span>
          {contract ? (
            <>
              <code className="hash">{contract}</code>
              {link ? (
                <a href={link} target="_blank" rel="noreferrer noopener">
                  Arc explorer ↗
                </a>
              ) : (
                <span className="tiny muted">no explorer URL is configured</span>
              )}
            </>
          ) : (
            <span className="small muted">
              No clearinghouse address is configured on the verifier, so there is nothing to settle
              against yet — the workbench still quotes and measures.
            </span>
          )}
        </div>
      </div>
      <hr className="hairline" />
    </section>
  );
}

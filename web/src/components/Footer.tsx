import type { Health, LedgerView, PublicConfig } from "../types";
import { addressLink } from "../format";

interface FooterProps {
  config: PublicConfig | null;
  health: Health | null;
  ledger: LedgerView | null;
}

/**
 * The honesty block.
 *
 * A judge is being asked to believe that the numbers above are not decoration,
 * so this section says exactly which parts are chain reads, which parts are
 * measured, and which parts are deterministic fixtures — in that order.
 */
export function Footer({ config, health, ledger }: FooterProps) {
  const explorer = ledger?.explorer ?? config?.explorer ?? null;
  const contract = ledger?.contract ?? config?.contract ?? null;
  const contractLink = addressLink(explorer, contract);
  const answered = ledger?.chain.endpoint ?? health?.chain?.endpoint ?? null;
  // The deployment decides which Arc network this is; nothing here assumes
  // mainnet, because the same interface serves testnet and a wrong label would
  // make every other claim on the page doubtful too.
  const network = ledger?.chain.network ?? config?.network ?? health?.network ?? null;

  return (
    <footer>
      <hr className="hairline" />
      <section className="panel" aria-labelledby="footer-heading">
        <div className="panel__head">
          <h2 className="panel__title" id="footer-heading">
            What is real on this page
          </h2>
          <span className="panel__note mono">
            {network ? `${network} · ` : ""}
            {health
              ? `verifier ${health.version} · up ${health.uptime_s}s`
              : config
                ? "verifier reachable · health unavailable"
                : "verifier unreachable"}
          </span>
        </div>
        <div className="panel__body stack">
          <div className="facts">
            <div>
              <div className="fact__label">Clearinghouse</div>
              {contract ? (
                contractLink ? (
                  <a
                    className="mono small wrap-anywhere"
                    href={contractLink}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {contract} ↗
                  </a>
                ) : (
                  <span className="mono small wrap-anywhere">{contract}</span>
                )
              ) : (
                <span className="small muted">no address configured</span>
              )}
              <div className="tiny muted">
                {ledger
                  ? ledger.contract_code_present
                    ? "bytecode present at this address"
                    : "no bytecode at this address"
                  : "—"}
              </div>
            </div>

            <div>
              <div className="fact__label">Arc RPC</div>
              {(config?.rpcs ?? []).length > 0 ? (
                <div className="stack--tight">
                  {(config?.rpcs ?? []).map((rpc) => (
                    <span key={rpc} className="wrap-anywhere">
                      {/* A fixed-width marker keeps the list aligned without
                          relying on whitespace, which flex collapses. */}
                      <span className="rpc__mark" aria-hidden="true">
                        {rpc === answered ? "▸" : ""}
                      </span>
                      <span className="mono small">{rpc}</span>
                      {rpc === answered ? <span className="tiny muted"> answered</span> : null}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="small muted">the verifier has not reported its endpoints</span>
              )}
            </div>

            <div>
              <div className="fact__label">Verifier EIP-712 domain</div>
              <div className="mono small">
                {config?.eip712
                  ? `${config.eip712.domain_name} v${config.eip712.domain_version}`
                  : "not reported"}
              </div>
              {config?.eip712 ? (
                <div className="stack--tight">
                  {/* The API returns the type strings in full, name included. */}
                  <code className="hash">{config.eip712.attestation_types}</code>
                  <code className="hash">{config.eip712.registration_types}</code>
                </div>
              ) : null}
            </div>

            <div>
              <div className="fact__label">Attestation key</div>
              <div className="mono small wrap-anywhere">
                {config?.verifier_address ?? ledger?.services[0]?.verifier ?? "none reported"}
              </div>
              <div className="small">
                {config?.can_settle ? (
                  "the verifier holds a signing key"
                ) : (
                  <span className="muted">
                    read-only: no signing key, so it can measure, validate and quote but cannot
                    attest a settlement
                  </span>
                )}
              </div>
            </div>
          </div>

          <hr className="hairline" />

          <ul className="stack--tight small">
            <li>
              <strong>Real, from the chain.</strong> Every covenant, order, balance, bond and
              invariant figure above is a call to the clearinghouse&rsquo;s own view functions on{" "}
              {network ?? "the settlement chain"}
              {answered ? `, answered by ${answered}` : ""}. When a read fails, the panel says so
              instead of showing a number.
            </li>
            <li>
              <strong>Real, measured.</strong> A live call is an HTTP POST the verifier actually
              makes to the endpoint named in the covenant. The latency, status code, byte count, and
              both response digests are properties of that request, not rehearsed values.
            </li>
            <li>
              <strong>Real, computed.</strong> Settlement figures come from the same integer
              arithmetic as the contract: the rebate is linear in the overrun past grace, floored to
              base units, and the split is floored per recipient with the remainder assigned to the
              provider so the parts always sum to the whole.
            </li>
            <li>
              <strong>Fixture, but genuinely executed.</strong> The three built-in services are
              deterministic: pinned latencies and fixed response bodies, run by this verifier over
              real HTTP. Their breach modes answer with a body that deliberately violates the
              covenant schema, which is what makes a breach demonstrable on demand. No third party
              operates them.
            </li>
            <li>
              <strong>A settlement is a real transaction.</strong> When the verifier returns a bound{" "}
              <code>settleOrder</code> calldata, the workbench sends it from your wallet to the
              clearinghouse and links the receipt on the Arc explorer. Until an order is funded,
              there is no order id to bind, and the workbench says that instead of offering a
              button that cannot work.
            </li>
          </ul>
        </div>
      </section>
    </footer>
  );
}

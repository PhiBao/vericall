import type { ServiceView } from "../types";
import { formatBps, formatDuration, shortAddress } from "../types";
import { addressLink, hostOf, usdcFixed } from "../format";

interface ServicesTableProps {
  services: ServiceView[];
  explorer: string | null;
}

/**
 * Every covenant the clearinghouse knows, as read from its own view functions.
 * The interesting column is the bond: a provider whose stake does not cover one
 * order at the current price cannot open one, so the shortfall is surfaced
 * rather than left for the reader to work out from two numbers.
 */
export function ServicesTable({ services, explorer }: ServicesTableProps) {
  if (services.length === 0) {
    return (
      <p className="small muted">
        No covenants are registered on this clearinghouse yet. A covenant is registered onchain
        before any call can be escrowed, so this table fills in after the first registration.
      </p>
    );
  }

  return (
    <div className="table-wrap">
      <table className="table table--stack table--services">
        <caption>Covenants registered on the clearinghouse — what each service published</caption>
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Provider</th>
            <th scope="col">Verifier</th>
            <th scope="col" className="num">
              Price
            </th>
            <th scope="col" className="num">
              Grace / hard
            </th>
            <th scope="col" className="num">
              Max rebate
            </th>
            <th scope="col" className="num">
              Bond
            </th>
            <th scope="col">Splits</th>
          </tr>
        </thead>
        <tbody>
          {services.map((service) => {
            const providerLink = addressLink(explorer, service.provider);
            const verifierLink = addressLink(explorer, service.verifier);
            return (
              <tr key={service.id}>
                <td data-label="Service">
                  <div className="row">
                    <span className="mono">#{service.id}</span>
                    <strong>{service.name}</strong>
                    {service.backed_by === "jev" ? (
                      <span className="tag tag--verified tag--inline" title={service.backing ?? undefined}>
                        model-backed
                      </span>
                    ) : null}
                    {service.active ? null : <span className="tag tag--muted tag--inline">inactive</span>}
                  </div>
                  <div className="tiny muted mono" title={service.endpoint_uri}>
                    {hostOf(service.endpoint_uri)}
                  </div>
                </td>
                <td data-label="Provider" className="mono">
                  {providerLink ? (
                    <a href={providerLink} target="_blank" rel="noreferrer noopener">
                      {shortAddress(service.provider, 4)}
                    </a>
                  ) : (
                    <span title={service.provider}>{shortAddress(service.provider, 4)}</span>
                  )}
                </td>
                <td data-label="Verifier" className="mono">
                  {verifierLink ? (
                    <a href={verifierLink} target="_blank" rel="noreferrer noopener">
                      {shortAddress(service.verifier, 4)}
                    </a>
                  ) : (
                    <span title={service.verifier}>{shortAddress(service.verifier, 4)}</span>
                  )}
                </td>
                <td data-label="Price" className="num">
                  {usdcFixed(service.call_price_usdc)}
                </td>
                <td data-label="Grace / hard" className="num">
                  {formatDuration(service.grace_latency_ms)} / {formatDuration(service.hard_timeout_ms)}
                </td>
                <td data-label="Max rebate" className="num">
                  {formatBps(service.max_rebate_bps)}
                  <div className="tiny muted">slash {formatBps(service.slash_penalty_bps)}</div>
                </td>
                <td data-label="Bond" className="num">
                  {usdcFixed(service.provider_bond_usdc)}
                  <div className="tiny muted">needs {usdcFixed(service.required_bond_usdc)}</div>
                  {service.bond_covers_one_order ? null : (
                    <div>
                      <span
                        className="tag tag--breach"
                        title="the staked bond is below the penalty for one order at this price"
                      >
                        bond short
                      </span>
                    </div>
                  )}
                </td>
                <td data-label="Splits">
                  <div className="stack--tight">
                    {service.splits.map((split) => (
                      <div key={`${split.recipient}-${split.bps}`} className="row">
                        <span className="mono" title={split.recipient}>
                          {shortAddress(split.recipient, 4)}
                        </span>
                        <span className="mono">{formatBps(split.bps)}</span>
                        <span className="tiny muted">{split.role}</span>
                      </div>
                    ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

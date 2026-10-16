import { Fragment, useState } from "react";
import type { OrderView, ServiceView } from "../types";
import { formatDuration, shortHash, statusLabel, verdictClass, verdictOfStatus } from "../types";
import { timestamp, txLink, usdcFixed } from "../format";

interface OrdersTableProps {
  orders: OrderView[];
  services: ServiceView[];
  explorer: string | null;
}

/**
 * The order ledger.
 *
 * Amounts are shown for settled orders only: a funded order has not been
 * measured yet, and a row of zeroes would read as "the provider was paid
 * nothing" rather than "this has not happened yet".
 */
export function OrdersTable({ orders, services, explorer }: OrdersTableProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set<string>());

  const toggle = (id: string): void => {
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const serviceName = (serviceId: string): string =>
    services.find((service) => service.id === serviceId)?.name ?? `service ${serviceId}`;

  if (orders.length === 0) {
    return (
      <p className="small muted">
        No orders yet. A live call below produces a measured result, a quote and a signed
        attestation; an order appears here once one is funded onchain, because this table is the
        clearinghouse&rsquo;s own order storage.
      </p>
    );
  }

  return (
    <div className="table-wrap">
      <table className="table table--stack table--orders">
        <caption>Orders — amounts in USDC, read from the clearinghouse</caption>
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Service</th>
            <th scope="col">Verdict</th>
            <th scope="col" className="num">
              Latency
            </th>
            <th scope="col" className="num">
              Escrowed
            </th>
            <th scope="col" className="num">
              Rebated
            </th>
            <th scope="col" className="num">
              To provider
            </th>
            <th scope="col" className="num">
              To deps
            </th>
            <th scope="col" className="num">
              Bond slashed
            </th>
            <th scope="col">Tx</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const verdict = verdictOfStatus(order.status);
            const expanded = open.has(order.id);
            // The chain is the source of truth for where a transaction is: the
            // settlement event names the hash, so a row links to the block that
            // moved the money rather than to a hash remembered on this machine.
            const hash = order.txs?.settled ?? order.txs?.reclaimed ?? order.txs?.created ?? null;
            const link = txLink(explorer, hash);
            const dash = <span className="muted">—</span>;
            return (
              <Fragment key={order.id}>
                <tr>
                  <td data-label="Order">
                    <button
                      type="button"
                      className="button button--quiet button--mono"
                      aria-expanded={expanded}
                      onClick={() => toggle(order.id)}
                    >
                      <span aria-hidden="true">{expanded ? "−" : "+"}</span> {order.id}
                      <span className="sr-only">
                        {expanded ? "hide" : "show"} the request and response hashes for this order
                      </span>
                    </button>
                  </td>
                  <td data-label="Service">{serviceName(order.service_id)}</td>
                  <td data-label="Verdict">
                    <span className={verdictClass(verdict)} title={order.status_name}>
                      {statusLabel(order.status_name)}
                    </span>
                  </td>
                  <td data-label="Latency" className="num">
                    {order.settled ? formatDuration(order.measured_latency_ms) : dash}
                  </td>
                  <td data-label="Escrowed" className="num">
                    {usdcFixed(order.escrowed_usdc)}
                  </td>
                  <td data-label="Rebated" className="num">
                    {order.settled ? usdcFixed(order.refunded_to_caller_usdc) : dash}
                  </td>
                  <td data-label="To provider" className="num">
                    {order.settled ? usdcFixed(order.paid_to_provider_usdc) : dash}
                  </td>
                  <td data-label="To deps" className="num">
                    {order.settled ? usdcFixed(order.paid_to_dependencies_usdc) : dash}
                  </td>
                  <td data-label="Bond slashed" className="num">
                    {order.settled ? usdcFixed(order.bond_slashed_usdc) : dash}
                  </td>
                  <td data-label="Tx">
                    {link ? (
                      <a href={link} target="_blank" rel="noreferrer noopener" className="mono">
                        {shortHash(hash ?? "", 6)} ↗
                      </a>
                    ) : order.settled ? (
                      <span className="muted tiny" title="the event scan did not reach this order">
                        not indexed
                      </span>
                    ) : (
                      <span className="muted tiny">in escrow</span>
                    )}
                  </td>
                </tr>
                {expanded ? (
                  <tr className="table__detail">
                    <td colSpan={10}>
                      <dl className="kv">
                        <dt>Status</dt>
                        <dd className="mono">
                          {order.status_name} ({order.status})
                        </dd>
                        <dt>Caller</dt>
                        <dd className="hash">{order.caller}</dd>
                        <dt>Request hash</dt>
                        <dd className="hash">{order.request_hash}</dd>
                        <dt>Response hash</dt>
                        <dd className="hash">{order.response_hash}</dd>
                        <dt>Schema valid</dt>
                        <dd className="mono">
                          {order.settled ? (order.schema_valid ? "yes" : "no") : "not measured yet"}
                        </dd>
                        <dt>Escrowed units</dt>
                        <dd className="mono" title="6-decimal USDC base units, as the contract stores them">
                          {order.escrowed_units}
                        </dd>
                        <dt>Settlement total</dt>
                        <dd className="mono" title="provider + dependencies + caller rebate + bond penalty">
                          {order.settled ? usdcFixed(order.settlement_total_usdc) : "—"}
                        </dd>
                        <dt>Created</dt>
                        <dd className="mono">{timestamp(order.created_at)}</dd>
                        <dt>Expires</dt>
                        <dd className="mono">{timestamp(order.expiry_at)}</dd>
                      </dl>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

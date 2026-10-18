import { useCallback, useEffect, useMemo, useState } from "react";
import { describeError, getConfig, getHealth, getLedger } from "./api";
import { useChain, useWallet } from "./chain";
import type { Health, LedgerView, PublicConfig } from "./types";
import type { ChainFacts } from "./components/Masthead";
import { Masthead } from "./components/Masthead";
import { Hero } from "./components/Hero";
import { SlaWorkbench } from "./components/SlaWorkbench";
import { ProofLedger } from "./components/ProofLedger";
import { OrdersTable } from "./components/OrdersTable";
import { ServicesTable } from "./components/ServicesTable";
import { Footer } from "./components/Footer";

/** How often the ledger is re-read while the tab is visible. */
const LEDGER_INTERVAL_MS = 30_000;

/**
 * Composition and data fetching.
 *
 * The three reads the page needs — config, health, ledger — are independent, so
 * they fail independently: a dead chain read does not blank the workbench, and a
 * missing covenant list does not pretend the ledger is empty.
 */
export function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [ledger, setLedger] = useState<LedgerView | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadConfig = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      setConfig(await getConfig(signal));
      setConfigError(null);
    } catch (cause) {
      if (signal?.aborted) return;
      setConfigError(describeError(cause));
    }
  }, []);

  const loadHealth = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      setHealth(await getHealth(signal));
      setHealthError(null);
    } catch (cause) {
      if (signal?.aborted) return;
      setHealthError(describeError(cause));
    }
  }, []);

  const loadLedger = useCallback(async (signal?: AbortSignal, fresh = false): Promise<void> => {
    try {
      setLedger(await getLedger(signal, fresh));
      setLedgerError(null);
    } catch (cause) {
      if (signal?.aborted) return;
      setLedger(null);
      setLedgerError(describeError(cause));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([
      loadConfig(controller.signal),
      loadHealth(controller.signal),
      loadLedger(controller.signal),
    ]);
    return () => controller.abort();
  }, [loadConfig, loadHealth, loadLedger]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void loadHealth();
      void loadLedger();
    }, LEDGER_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadHealth, loadLedger]);

  /**
   * Re-read the chain, uncached.
   *
   * Everyone who calls this has just done something to the chain — escrowed a
   * call, settled one, reclaimed one — which is exactly when the cached view is
   * the wrong one.
   */
  const refreshLedger = useCallback((): void => {
    setRefreshing(true);
    void loadLedger(undefined, true).finally(() => setRefreshing(false));
  }, [loadLedger]);

  const chain = useChain(config);
  const wallet = useWallet(chain);

  /**
   * A request to run a call, raised by the hero.
   *
   * A counter rather than a boolean: pressing the hero button twice should run
   * twice, and a boolean would need resetting from three components away.
   */
  const [runSignal, setRunSignal] = useState(0);
  const requestRun = useCallback((): void => {
    setRunSignal((n) => n + 1);
    document.getElementById("run")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const chainFacts = useMemo<ChainFacts>(() => {
    const status = ledger?.chain ?? health?.chain ?? null;
    return {
      network: status?.network ?? config?.network ?? health?.network ?? null,
      chainId: status?.chain_id ?? config?.chain_id ?? health?.chain_id ?? null,
      blockNumber: status?.block_number ?? null,
      latencyMs: status?.latency_ms ?? null,
      endpoint: status?.endpoint ?? null,
      // Only an error when nothing answered. A stale-but-present status is not an
      // error, and a chain read that failed is reported by the ledger panel too.
      error: status === null ? (ledgerError ?? healthError ?? null) : null,
    };
  }, [ledger, health, config, ledgerError, healthError]);

  return (
    <div className="shell">
      <Masthead chain={chainFacts} loading={ledger === null && ledgerError === null} wallet={wallet} />
      <Hero ledger={ledger} onRun={requestRun} />
      <main className="grid grid--workbench">
        <SlaWorkbench
          config={config}
          configError={configError}
          ledger={ledger}
          wallet={wallet}
          onSettled={refreshLedger}
          runSignal={runSignal}
        />
        <ProofLedger
          ledger={ledger}
          error={ledgerError}
          refreshing={refreshing}
          onRefresh={refreshLedger}
        />
        {/*
          The order ledger gets the full width. Every column is money or time —
          latency, escrow, rebate, provider, dependencies, penalty — and those
          are meant to be compared down a column, which a side panel cannot do.
        */}
        <section className="panel panel--ledger" aria-labelledby="covenants-heading">
          <div className="panel__head">
            <h2 className="panel__title" id="covenants-heading">
              Published covenants
            </h2>
            <span className="panel__note">
              what each service promised: price, grace and hard latency, the rebate it will pay, and
              who shares the proceeds — read from the contract
            </span>
          </div>
          <div className="panel__body">
            {ledgerError ? (
              <p className="banner banner--error" role="alert">
                The ledger could not be read from Arc: {ledgerError}
              </p>
            ) : ledger ? (
              <ServicesTable services={ledger.services} explorer={ledger.explorer} />
            ) : (
              <p className="small muted">
                <span className="spinner" aria-hidden="true" /> Reading the clearinghouse from Arc…
              </p>
            )}
          </div>
        </section>

        <section className="panel panel--ledger" aria-labelledby="orders-heading">
          <div className="panel__head">
            <h2 className="panel__title" id="orders-heading">
              Settled orders
            </h2>
            <span className="panel__note">
              every amount read from the clearinghouse, not from this page&rsquo;s state
            </span>
          </div>
          <div className="panel__body">
            {ledgerError ? (
              <p className="banner banner--error" role="alert">
                The ledger could not be read from Arc: {ledgerError}
              </p>
            ) : ledger ? (
              <OrdersTable
                orders={ledger.orders}
                services={ledger.services}
                explorer={ledger.explorer}
              />
            ) : (
              <p className="small muted">
                <span className="spinner" aria-hidden="true" /> Reading the clearinghouse from Arc…
              </p>
            )}
          </div>
        </section>
      </main>
      <Footer config={config} health={health} ledger={ledger} />
    </div>
  );
}

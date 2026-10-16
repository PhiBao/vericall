import { useCallback, useEffect, useMemo, useState } from "react";
import { describeError, getConfig, getHealth, getLedger } from "./api";
import { useChain, useWallet } from "./chain";
import type { Health, LedgerView, PublicConfig } from "./types";
import type { ChainFacts } from "./components/Masthead";
import { Masthead } from "./components/Masthead";
import { Orientation } from "./components/Orientation";
import { SlaWorkbench } from "./components/SlaWorkbench";
import { ProofLedger } from "./components/ProofLedger";
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

  const loadLedger = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      setLedger(await getLedger(signal));
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

  const refreshLedger = useCallback((): void => {
    setRefreshing(true);
    void loadLedger().finally(() => setRefreshing(false));
  }, [loadLedger]);

  const chain = useChain(config);
  const wallet = useWallet(chain);

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
      <Orientation
        contract={ledger?.contract ?? config?.contract ?? null}
        explorer={ledger?.explorer ?? config?.explorer ?? null}
      />
      <main className="grid grid--workbench">
        <SlaWorkbench
          config={config}
          configError={configError}
          ledger={ledger}
          wallet={wallet}
          onSettled={refreshLedger}
        />
        <ProofLedger
          ledger={ledger}
          error={ledgerError}
          refreshing={refreshing}
          onRefresh={refreshLedger}
        />
      </main>
      <Footer config={config} health={health} ledger={ledger} />
    </div>
  );
}

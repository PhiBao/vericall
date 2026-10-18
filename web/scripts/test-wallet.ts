#!/usr/bin/env node
/**
 * Wallet behaviour, exercised against a stubbed EIP-1193 provider.
 *
 * Two things the product promises that a screenshot cannot show: connecting lands
 * the wallet on the settlement chain in one action, and disconnecting actually
 * clears the session and asks the wallet to drop the permission. A real wallet is
 * not required to check either — what matters is the sequence of RPC calls the
 * page makes and what it renders afterwards.
 *
 *   pnpm exec node --experimental-strip-types --no-warnings scripts/test-wallet.ts
 */

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

type Chromium = typeof import("playwright").chromium;

/**
 * Playwright is a heavy dependency for one behavioural check, so it is not a
 * package dependency: this prefers a local install and otherwise borrows the
 * global one, which is how it is usually present on a development machine. The
 * global path is loaded through CommonJS because the package's ESM entry is the
 * CLI rather than the library.
 */
async function loadChromium(): Promise<Chromium> {
  try {
    const local = await import("playwright");
    return local.chromium;
  } catch {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    const require = createRequire(join(root, "noop.js"));
    return (require("playwright") as typeof import("playwright")).chromium;
  }
}

const STUB_ACCOUNT = "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe";

const BASE = process.env.VERICALL_BASE ?? "http://localhost:8787";
const CHAIN_ID = Number(process.env.VERICALL_CHAIN_ID ?? 5042);

let failures = 0;
function check(condition: boolean, what: string, detail = ""): void {
  if (condition) {
    console.log(`  PASS  ${what}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const chromium = await loadChromium();
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN ?? process.env.CHROME_PATH,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  // Every request the page makes through the provider is recorded, so the
  // assertions are about what the page did, not about what it looks like.
  await page.addInitScript(
    ({ chainId, stubAccount }) => {
      const STUB_ACCOUNT = stubAccount;
      const calls: { method: string; params: unknown }[] = [];
      let accounts: string[] = [];
      let current = "0x1"; // start on Ethereum, so a switch is required
      const listeners: Record<string, ((payload: unknown) => void)[]> = {};
      const w = window as unknown as { __walletCalls: typeof calls; ethereum: unknown };
      w.__walletCalls = calls;
      w.ethereum = {
        isStub: true,
        request: async ({ method, params }: { method: string; params?: unknown }) => {
          calls.push({ method, params });
          switch (method) {
            case "eth_accounts":
              return accounts;
            case "eth_requestAccounts":
              accounts = [STUB_ACCOUNT];
              return accounts;
            case "eth_chainId":
              return `0x${current.slice(2)}`;
            case "wallet_switchEthereumChain": {
              const wanted = (params as { chainId: string }[])[0]?.chainId;
              if (!wanted) throw new Error("no chain requested");
              current = wanted;
              listeners.chainChanged?.forEach((fn) => fn(wanted));
              return null;
            }
            case "wallet_addEthereumChain":
              current = (params as { chainId: string }[])[0].chainId;
              listeners.chainChanged?.forEach((fn) => fn(current));
              return null;
            case "wallet_revokePermissions":
              accounts = [];
              listeners.accountsChanged?.forEach((fn) => fn([]));
              return null;
            case "eth_sendTransaction":
              return "0x" + "ab".repeat(32);
            default:
              throw new Error(`stub provider has no method ${method}`);
          }
        },
        on: (event: string, fn: (payload: unknown) => void) => {
          (listeners[event] ??= []).push(fn);
        },
        removeListener: (event: string, fn: (payload: unknown) => void) => {
          listeners[event] = (listeners[event] ?? []).filter((other) => other !== fn);
        },
      };
      void chainId;
    },
    { chainId: CHAIN_ID, stubAccount: STUB_ACCOUNT },
  );

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  console.log("\nConnecting\n──────────");
  check(await page.getByRole("button", { name: "Connect wallet" }).isVisible(), "the page offers Connect");

  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.waitForTimeout(1200);

  const calls = (await page.evaluate(() => (window as unknown as { __walletCalls: { method: string; params: unknown }[] }).__walletCalls)) ?? [];
  const methods = calls.map((c) => c.method);
  check(methods.includes("eth_requestAccounts"), "connecting asks for accounts");
  check(
    methods.includes("wallet_switchEthereumChain") || methods.includes("wallet_addEthereumChain"),
    "connecting switches the wallet to the settlement chain without a second click",
    `methods seen: ${methods.join(", ")}`,
  );
  const switchParams = calls.find((c) => c.method === "wallet_switchEthereumChain")?.params as
    | { chainId: string }[]
    | undefined;
  if (switchParams) {
    const wanted = Number.parseInt(switchParams[0].chainId, 16);
    check(wanted === CHAIN_ID, `the switch names chain ${CHAIN_ID}`, `asked for ${wanted}`);
  }

  const bodyText = await page.locator("body").innerText();
  check(/5AFE/i.test(bodyText), "the address is shown once connected");
  check(/on Arc|Arc/i.test(bodyText), "the chain chip reports the settlement chain");

  console.log("\nDisconnecting\n─────────────");
  const disconnect = page.getByRole("button", { name: "Disconnect" });
  check(await disconnect.isVisible(), "a Disconnect control is offered once connected");
  await disconnect.click();
  await page.waitForTimeout(1000);

  const after = (await page.evaluate(() => (window as unknown as { __walletCalls: { method: string }[] }).__walletCalls)) ?? [];
  check(
    after.some((c) => c.method === "wallet_revokePermissions"),
    "disconnecting asks the wallet to drop the page's account permission",
  );
  check(
    await page.getByRole("button", { name: "Connect wallet" }).isVisible(),
    "the page returns to its disconnected state",
  );
  check(
    // The wallet chip is the only place this address can appear: the stub holds
    // an address that is not one of the ledger's watched wallets.
    !/5AFE/i.test(await page.locator("body").innerText()),
    "the address is no longer displayed",
  );

  console.log("\nReconnecting\n────────────");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.waitForTimeout(1200);
  check(
    /5AFE/i.test(await page.locator("body").innerText()),
    "connecting again works after a disconnect",
  );

  await browser.close();
  console.log(failures === 0 ? "\nAll wallet checks passed\n" : `\n${failures} wallet check(s) FAILED\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

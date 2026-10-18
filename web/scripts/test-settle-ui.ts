#!/usr/bin/env node
/**
 * The whole loop through the product's own interface.
 *
 * Every other test settles from the command line. This one does what a person
 * does: connect a wallet, write a request, escrow it, run the call, press Settle,
 * and wait for the receipt. It exists because that path is the product — and
 * because the demo video records the same flow.
 *
 * The wallet is `tools/demo-wallet.ts`: a loopback EIP-1193 provider backed by a
 * local key that signs only for the clearinghouse. Start it first, funded.
 *
 *   node --experimental-strip-types --no-warnings scripts/test-settle-ui.ts
 */

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

type Chromium = typeof import("playwright").chromium;

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

const BASE = process.env.VERICALL_BASE ?? "http://localhost:8787";
const WALLET = process.env.DEMO_WALLET_ENDPOINT ?? "http://127.0.0.1:8901";

let failures = 0;
const check = (ok: boolean, what: string, detail = ""): void => {
  if (ok) {
    console.log(`  PASS  ${what}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

async function main(): Promise<void> {
  const chromium = await loadChromium();
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  // The provider the recording uses: a wallet the page finds already installed.
  await page.addInitScript(({ endpoint }) => {
    const listeners: Record<string, ((payload: unknown) => void)[]> = {};
    let accounts: string[] = [];
    const emit = (event: string, payload: unknown): void =>
      (listeners[event] ?? []).forEach((fn) => fn(payload));
    const rpc = async (method: string, params?: unknown): Promise<unknown> => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params ?? [] }),
      });
      const body = await response.json();
      if (body.error) throw new Error(body.error.message);
      return body.result;
    };
    (window as unknown as { ethereum: unknown }).ethereum = {
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        // Not authorised yet, which is how a wallet behaves for a new site.
        if (method === "eth_accounts") return accounts;
        if (method === "eth_requestAccounts") {
          accounts = (await rpc(method, params)) as string[];
          emit("accountsChanged", accounts);
          return accounts;
        }
        if (method === "wallet_revokePermissions") {
          accounts = [];
          emit("accountsChanged", []);
          return null;
        }
        return rpc(method, params);
      },
      on: (event: string, fn: (payload: unknown) => void) => {
        (listeners[event] ??= []).push(fn);
      },
      removeListener: (event: string, fn: (payload: unknown) => void) => {
        listeners[event] = (listeners[event] ?? []).filter((other) => other !== fn);
      },
    };
  }, { endpoint: WALLET });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  console.log("\nConnecting\n──────────");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.waitForTimeout(2000);
  check(!/No wallet detected/i.test(await page.locator("body").innerText()), "a wallet is connected");

  console.log("\nEscrowing from the wallet\n─────────────────────────");
  const escrow = page.getByRole("button", { name: /^Escrow / });
  check(await escrow.isVisible(), "the interface offers to escrow the call");
  await escrow.click();
  // Signing plus a mainnet inclusion plus the ledger refresh behind it.
  await page.waitForTimeout(20000);
  const escrowNow = page.getByRole("button", { name: /^Escrowed$/ });
  const created = await escrowNow.isVisible();
  check(created, "the order was created from the connected wallet");
  if (created) {
    const body = await page.locator("body").innerText();
    check(/Escrowed\. Run the call below/.test(body), "the interface says what to do next");
  }

  console.log("\nRunning and settling\n────────────────────");
  await page.getByRole("button", { name: "Run a live call" }).click();
  await page.waitForTimeout(12000);
  const trace = await page.locator(".trace").innerText();
  check(/HTTP \d{3}/.test(trace), "a real call was measured");

  const settle = page.getByRole("button", { name: /Settle onchain/i });
  const offered = await settle.isVisible();
  check(offered, "the settlement control appears once the call is measured");
  if (offered) {
    await settle.click();
    // A settlement is not a hash: it is a hash that came back with a receipt, and
    // the interface only links it once the receipt arrives. Waiting for a fixed
    // interval would pass or fail on how busy Arc is, so poll for the link.
    const link = page.locator('a[href*="explorer.arc.io/tx/0x"]').first();
    let linked = false;
    for (let attempt = 0; attempt < 30 && !linked; attempt += 1) {
      linked = await link.isVisible().catch(() => false);
      if (!linked) await page.waitForTimeout(2000);
    }
    check(linked, "the settlement came back with a link to its mainnet transaction");
  }

  check(errors.length === 0, "no page errors", errors.slice(0, 2).join(" | "));
  await page.screenshot({ path: "/tmp/opencode/settle-ui.png" });
  await browser.close();
  console.log(failures === 0 ? "\nAll interface checks passed\n" : `\n${failures} check(s) FAILED\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

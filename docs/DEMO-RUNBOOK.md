# Demo runbook

A shot list for the walkthrough video. The required content is: **the build in Arc Studio** and
**the mainnet transaction**. Everything else exists to make those two credible.

Total: about 4 minutes. Record at 1600×900 or larger; the tables need the width.

---

## Before you record

```bash
# 1. Everything is deployed; nothing to set up. Confirm it is still live:
curl -s https://vericall.fly.dev/api/health | head -c 200

# 2. Have these two links open in tabs, in this order:
#    https://vericall.fly.dev
#    https://studio.arc.io/app/b3658244-c47e-4bb9-b1c5-3b34acc595cc

# 3. Have one mainnet transaction open, ready to be shown:
#    https://explorer.arc.io/tx/0x83f9b9f51c03316415b99533a4967940471d13cdc98db177406712eba647028f
```

If the demo machine has a wallet with Arc USDC, have it connected as a second act. If it does not,
the page is fully useful without one — say so, because that is a design decision, not a gap.

---

## 0:00–0:20 — the problem, in the words of someone who pays for API calls

> "Software pays software now. An agent buys inference, or a parse, or an audit, from another
> endpoint — usually in USDC, usually up front. And it is pay-and-pray: if the endpoint answers
> 1.4 seconds later than my pipeline can wait, or returns JSON my code cannot read, I have already
> paid. The provider has the same problem mirrored: it cannot pay the data source behind it per
> successful call, so that work goes uncompensated."

No slides. Say it over the live page.

## 0:20–1:10 — the ledger is not a mock

On **vericall.fly.dev**, without connecting anything:

- Point at the masthead: `ARC · 5042`, the block number, `via https://rpc.blockdaemon.mainnet.arc.io`
  — "that is the endpoint that answered this read, and there are two more if it does not."
- Point at the **invariant** line: `sum(funded escrow) = totalEscrowed()`.
- Point at the **settled orders** table and read one row aloud:
  "Order 2 measured **1250 milliseconds**. The covenant's grace is 500 and its hard timeout is 2000,
  so it ran half-way into the rebate band and the caller got **0.035097 USDC** back — that is not
  approximately 3.5 cents, it is the consequence of that one millisecond."
- Click the transaction link on row 2. On the explorer: show the USDC transfers — one out to the
  provider, one to the dependency, one back to the caller. "Three transfers, one transaction."
- Scroll to **Published covenants** and point at the **bond** column: `needs 0.040000`.
  "A covenant cannot sell an order it cannot cover; the contract refuses at the point of sale."

## 1:10–2:00 — run a real call

Scroll to **Live call**:

- Mode **degraded**, press **Run call**.
- Narrate the telemetry trace as it fills: the request hash, the measured latency, the schema
  verdict, the quote, and the `settleOrder` payload.
- Then switch to **breach** and run it again: "the schema check fails here, and you can read all
  four violations — this is a validator over the bytes that came back, not a model's opinion."
- Point at the line that says the request matched the order's onchain commitment. "The verifier
  refuses to sign unless the bytes it is about to send hash to what the caller wrote down onchain.
  Without that, you could point an order at a request you knew would fail and harvest the bond."

## 2:00–3:00 — the build in Arc Studio

Switch to the **Arc Studio** tab:

- Show the session: the prompt that specified the settlement semantics, the generated
  `VeriCallClearinghouse.sol`, the compile and test runs inside the workspace, and the workspace
  preview.
- Say the honest part: "Studio wrote and tested this on testnet. Everything a mainnet product needs
  was built around that artefact — the deployment, the verifier, the app — and I wrote a second,
  independent test suite against the contract Studio produced. It found a real bug: a covenant
  whose grace latency equals its hard timeout divided by zero and reverted. That is fixed, with a
  fuzz test over it."

## 3:00–3:40 — the parts that make it more than a demo

- Terminal: `node web/scripts/verify.ts --network arc-mainnet` → **23 checks, all passed**, no key.
  "That is a judge's check, not mine: bytecode, every covenant term against the chain, every settled
  order's payouts reproducible from the covenant's own rates, and the money whole."
- Point at the **dependency wallet**: `0.004 → 0.195 USDC`. "It started with dust. That is 48×, earned
  entirely as per-call royalty splits on seven API calls — no invoice, no reconciliation, no
  custodian. Paying someone 3 cents out of a 15-cent call is impossible on card rails."

## 3:40–4:00 — why this is worth continuing

> "The primitive is general: metered SaaS, agent-to-agent task settlement, dependency royalties are
> the same instrument with different terms. What it needs next is not more code — it is one provider
> and one caller who are not me, paying for one real call. That is what the grant buys."

---

## If something goes wrong on camera

The live page is deliberately useful when a read fails: it says which endpoint failed and stays
empty rather than inventing numbers. If the verifier is unreachable, the ledger still renders —
that is a fallback worth showing rather than hiding.

The transactions are permanent. If anything live is unavailable, the proof still stands at the
explorer links in `README.md`, which is the point of putting the money onchain in the first place.

# VeriCall

**Escrow a USDC payment for a software-to-software API call. Settle it against the promise the API published — latency and response schema — and split the money across the provider and its upstream dependencies in the same transaction.**

Live on Arc mainnet · [**vericall.fly.dev**](https://vericall.fly.dev) · contract [`0xb980fa2a21b09a7304da285187f67daf55600619`](https://explorer.arc.io/address/0xb980fa2a21b09a7304da285187f67daf55600619)

---

## The problem in one paragraph

Software pays software now. Agents buy inference, enrichment, parsing and audits from other endpoints, usually in USDC, usually prepaid — `x402` settles on the request, prepaid API credits settle on the invoice. Both are *pay-and-pray*: if the endpoint answers 1.4 seconds later than the pipeline can wait, or returns JSON that does not match the shape the caller's code needs, the caller has already paid and has no recourse. The failures are not adversarial, they are ordinary — an upstream feed is slow, a model returns a string where a number was promised. Meanwhile the provider of a composable service has no way to pay the data source or model it depends on per successful call, so upstream work goes uncompensated or is invoiced monthly at a loss. **VeriCall makes the payment conditional on the delivery, and distributes it in the same transaction.**

## What it does

A provider publishes a **covenant** on Arc: a price in USDC, a grace latency, a hard timeout, a maximum rebate, a breach penalty, a JSON schema the response must satisfy, and a table of who gets paid what by basis points.

A caller escrows the price. A verifier executes the call for real, measures it, validates the response against the covenant's schema, and signs an EIP-712 attestation of what happened. The contract then decides, from that measurement alone:

| Verdict | Condition | Money movement |
| --- | --- | --- |
| **Pass** | latency ≤ grace, schema satisfied | Full price splits across the covenant's recipients — provider and its upstream dependencies — in one transaction |
| **Degraded** | latency between grace and hard timeout, schema satisfied | A rebate accrues **linearly in the overrun**, up to the covenant's maximum, and returns to the caller; the remainder splits |
| **Breach** | latency over the hard timeout, or a response outside the schema | The caller is refunded the full escrow **and** a penalty is slashed from the provider's staked bond |
| **Expired** | nobody settled before the window closed | Anyone may send the escrow back to the caller |

The rebate is not a policy decision made by a human after the fact. It is arithmetic in the contract, and `quoteSettlement` will tell you the exact outcome for a latency *before* you agree to it.

## The walkthrough

[`docs/assets/vericall-demo.mp4`](docs/assets/vericall-demo.mp4) — two and a half minutes, no slides:

| Beat | What it shows |
| --- | --- |
| 0:00 | The problem: software pays software in advance and has no recourse |
| 0:16 | The live app on Arc mainnet. A real call to `api.frankfurter.dev` — the ECB's reference rate, a publisher this project does not run — measured at 196 ms and checked against the covenant's schema |
| 0:35 | The settlement curve: what a given overrun costs, with the covenant's own settled calls plotted on it |
| 0:52 | The ledger: every order, its verdict, its three-way split, and a link to the transaction |
| 1:10 | **The loop from the browser**: the request written, escrowed from a wallet, run, attested, and settled onchain — ending on the receipt and the hash |
| 1:40 | **The transaction on Arc's explorer**: one settlement, three transfers inside it, confirmed in half a second |
| 2:01 | **The build and the chain from a terminal**: the contract suite, the independent check against mainnet, and `cast chain-id` answering 5042 |

The narration is what the interface is doing, not what it might do: every figure on screen is read from the contract or measured during the take. It was recorded against a local instance of the deployed build — the same binary and the same front-end bundle, reading Arc mainnet — because the recorder drives the page itself.

## Proof: real USDC on Arc mainnet

Every row below is a real Arc mainnet transaction against the deployed contract. The caller, the provider and the upstream dependency are three distinct wallets; the money really moved. Two covenants are exercised, with different prices, different rates and different splits — **80/20** and **70/30**.

### Counterparty Risk Scorer — 0.20 USDC, grace 500 ms, hard timeout 2000 ms, max rebate 40%, penalty 20%

| # | Verdict | Measured | What the chain did | Transaction |
| --- | --- | --- | --- | --- |
| 1 | **Pass** | 126 ms, schema valid | **0.16 USDC** → provider, **0.04 USDC** → upstream dependency | [`0x8a2e8f07…`](https://explorer.arc.io/tx/0x8a2e8f07a0c1e0bf28dae3c4b0a23c853ffc4f7d4f591f02f689e10af0833cc1) |
| 2 | **Degraded** | 1250 ms, schema valid | **0.035097 USDC** rebated to the caller, **0.128** → provider, **0.032** → dependency | [`0x83f9b9f5…`](https://explorer.arc.io/tx/0x83f9b9f51c03316415b99533a4967940471d13cdc98db177406712eba647028f) |
| 3 | **Breach** | 2251 ms, schema violated | **0.236713 USDC** to the caller: the full 0.2 escrow refunded plus a 0.04 penalty slashed from the provider's bond | [`0x11d372cf…`](https://explorer.arc.io/tx/0x11d372cfc5db58a1d3af74f9f960ba80a43b7e9462434329c49708ae9cf7bb31) |
| 4 | **Pass, attested by the live public verifier** | 129 ms, schema valid | **0.16 USDC** → provider, **0.04 USDC** → dependency | [`0xf648f251…`](https://explorer.arc.io/tx/0xf648f251650a7315d8c6f6a87126ceebbc0e3dbd03d0171eb548be816778ef7f) |

### Invoice Field Extractor — 0.15 USDC, grace 400 ms, hard timeout 1500 ms, max rebate 50%, penalty 25%

| # | Verdict | Measured | What the chain did | Transaction |
| --- | --- | --- | --- | --- |
| 5 | **Pass** | 104 ms, schema valid | **0.105 USDC** → provider, **0.045 USDC** → dependency | [`0x2605bebd…`](https://explorer.arc.io/tx/0x2605bebdb1598ec64150c052f92024de86a947f16a71bb248e75b5b55bd44b0e) |
| 6 | **Degraded** | 953 ms, schema valid | **0.037704 USDC** rebated to the caller, **0.078608** → provider, **0.033688** → dependency | [`0xd330264a…`](https://explorer.arc.io/tx/0xd330264a95619e88bf8a7f4dd4c653e2edb569797b78f03d2b595940c7ca6d4c) |
| 7 | **Breach** | 1753 ms, schema violated | **0.1875 USDC** to the caller: 0.15 refunded plus a 0.0375 bond penalty | [`0x4533793e…`](https://explorer.arc.io/tx/0x4533793edb45704ceaba12584d45da13a8c975324e1f19a9f7bd47ae9b872126) |

Order 2 is worth reading closely: the call ran for **1250 ms**, one millisecond past the half-way point between the 500 ms grace and the 2000 ms hard timeout, so the rebate is **0.035097 USDC** — not "about 3.5 cents", but the exact consequence of that one millisecond. The same arithmetic runs for order 6: 953 ms against a 400 ms grace and a 1500 ms hard timeout produced a rebate of 0.037704, and `quoteSettlement` on the contract returns the identical number.

Order 4 is the one to check first if you are reviewing: its attestation was produced by the **live deployment** at `vericall.fly.dev`, which dialled its own public endpoint over HTTPS, measured the 129 ms itself, validated the schema, and signed. Nothing about that settlement came from a developer's laptop.

### Model calls under the same covenant

| # | Service | Verdict | Measured | What the chain did | Transaction |
| --- | --- | --- | --- | --- | --- |
| 8 | `intent-router` (**Jev**) | **Pass** | 251 ms, schema valid | 0.04 USDC → provider, 0.01 → dependency | [`0x6370fb2f…`](https://explorer.arc.io/tx/0x6370fb2f945fcda6cd6a36770bcc9c449d3d6ba8564ec2b51ba8936190cc4fa1) |
| 11 | `payment-guard` (**Jev**, refusing) | **Breach** | HTTP 429, schema violated | **0.096697 USDC** to the caller: the 0.08 escrow refunded plus 0.02 slashed from the stake | [`0x586230ca…`](https://explorer.arc.io/tx/0x586230cac965d342ff09679ab5e1873098c133b231911ae82a0616e59d434c48) |

Order 8 is a model call settled by measurement: the verifier ran the Jev request,
validated the returned probabilities against the covenant's schema, and the
contract paid out in the same second.

Order 11 is the one worth reading. `scripts/demo-outage.ts` spends the service's
own per-minute model budget with real requests until it starts refusing them —
the 429 is the service's, not an injected failure — then settles the order while
it is refusing. The verifier measures the refusal, the schema check fails with it,
and the covenant pays the caller back out of the provider's stake. **A model
outage is priced the same way a slow endpoint is**, which is the claim that makes
this more than a demo. The script says in its own output what was orchestrated
(the outage) and what was the contract's own arithmetic (everything after it).

### A third party's API, settled onchain

| # | Service | Verdict | Measured | What the chain did | Transaction |
| --- | --- | --- | --- | --- | --- |
| 13 | `fx-rate` (**ECB via Frankfurter**) | **Pass** | **61 ms**, schema valid | 0.021 USDC → provider, 0.009 → dependency | [`0x5cccd30b…`](https://explorer.arc.io/tx/0x5cccd30b9bb91ded0d6d6cd462e7ecf9933c40be40a229855003c291b53d6388) |

Order 13 is the one to open if the question is "is any of this real". The call went
to `api.frankfurter.dev` — a publisher this project does not run, serving the
European Central Bank's reference rate — and the settlement is the contract's
response to what that publisher returned in 61 milliseconds. The endpoint, the
schema and the price are in the covenant; the rate itself is whatever the ECB
published that day.

### The whole loop from the browser, with a wallet the build never used

| # | Service | Verdict | Measured | What the chain did | Transaction |
| --- | --- | --- | --- | --- | --- |
| 23 | `fx-rate` | **Pass** | 166 ms, schema valid | 0.021 USDC → provider, 0.009 → dependency | [`0xd0815a54…`](https://explorer.arc.io/tx/0xd0815a54949866cc584f97c28281c2bc2e873d8fb5f6f63591d67582ccf36c95) |
| 24 | `fx-rate` | **Pass** | 156 ms, schema valid | 0.021 USDC → provider, 0.009 → dependency | [`0xb118721f…`](https://explorer.arc.io/tx/0xb118721f76f11c553b042a349566ded9e686b9c18322d1fb9217126746ddd615) |
| 25 | `fx-rate` | **Pass** | 146 ms, schema valid | 0.021 USDC → provider, 0.009 → dependency | [`0x718bef04…`](https://explorer.arc.io/tx/0x718bef04f9f35d6145c546d67ddb8ecce8c48ad046e92012e320221017acf7e8) |

These three were not settled by a script. Each was created, executed and settled
from [vericall.fly.dev](https://vericall.fly.dev) by `0xDbFe…e349` — a fourth
wallet that appears nowhere else in the build, funded for the purpose. The app
writes the request, reads the covenant's own price from the chain, approves
**exactly that much USDC** — never an unlimited allowance — sends `createOrder`
from the connected wallet, waits for Arc to show the order, runs the call through
the verifier, and sends the settlement the verifier signed. Because the approval
is for one call, each new call asks for it again: two signatures per call, and
nothing standing once it is spent.
Order 25 is the settlement on camera in the walkthrough video.

What this proves, and what it does not: the wallet is ours and so is the money,
so it is not evidence of outside demand — no stranger has bought a call yet. It
does show the product's own path working for an address with no history against
the contract: no allowance, no state, no scripts, one browser.

### What the calls did to four wallets

| Wallet | Role | Started with | Holds now | What moved |
| --- | --- | --- | --- | --- |
| [`0x4AB5…e555`](https://explorer.arc.io/address/0x4AB5e7F2b5464B9494b49EFE41C2f00e7bcfE555) | caller | 1.300 USDC | 0.074 USDC | Paid for every order it opened and their gas; received two rebates and three breach refunds in full; moved 0.150 to the fourth wallet used in the video, so this column is not a profit and loss |
| [`0x15AB…ac4b`](https://explorer.arc.io/address/0x15AB8109378736FA1C1C401175d375DB9b1dAC4B) | provider | 0.300 USDC | 0.649 USDC | Revenue from eighteen settled calls, less the 0.4075 it has staked behind six covenants and the penalties three breaches cost it |
| [`0x0382…1e67`](https://explorer.arc.io/address/0x0382bca3Fc934169a43c7ebe1Ee4B4d6A69C1e67) | upstream dependency | 0.004 USDC | 0.286 USDC | **71×**, earned entirely as per-call royalty splits — it has no other source of income |
| [`0xDbFe…e349`](https://explorer.arc.io/address/0xDbFe5c4d0256D2459bB216caB905999Ca41bE349) | the interface's own wallet | 0.350 USDC | 0.012 USDC | Funded once by the operator. Bought eight calls entirely through the browser and paid their gas; four orders left mid-test were reclaimed after their windows closed. It is nearly empty, which is the honest state of a demo wallet that has been used |

The dependency's row is the product thesis in one line. It started with dust and
holds 0.286 USDC now, because every successful call that used it paid it 20%, 25%
or 30% of the price in the same transaction that paid the provider — no invoice,
no monthly reconciliation, no custodian. Paying a contributor a 0.03 USDC share of
a 0.15 USDC call is impossible on card rails and uneconomic on most chains; here it
cost about 0.0001 USDC to include.

### The transactions are found from the chain, not remembered

The order ledger does not get its transaction hashes from the scripts that ran them. The verifier scans the contract's own `OrderCreated`, `OrderSettled` and `OrderReclaimed` events, chunked under Arc's 10,000-block `eth_getLogs` cap, starting from the deploy block recorded in `deployments/`. So the links a reader clicks are derived from the chain, and a settlement that happened without this project's involvement would appear too.

### The caller's escape hatch, also on mainnet

Two orders were left funded during testing when the deliberately-interrupted runs
stopped before settling — which is exactly the situation the reclaim path exists
for. Once their windows closed, anyone could send the escrow home; it can only ever
go to the original caller, and it needs nobody's cooperation:

| Order | What happened | Transaction |
| --- | --- | --- |
| 9 | 0.08 USDC returned to the caller after its window closed | [`0x97518d7b…`](https://explorer.arc.io/tx/0x97518d7bc59c5272a1e230ffad18fe2e3768f95191476764274ece10397ef99a) |
| 10 | 0.08 USDC returned to the caller after its window closed | [`0xd64aa0d7…`](https://explorer.arc.io/tx/0xd64aa0d75f80afdb846f883bae88e93d3a223bf875d6daec326a3ecdaed45d6d) |

So the contract has been exercised on all four of its terminal outcomes — paid out,
rebated, refunded with a penalty, and reclaimed — with real money, and the final
state holds no floating escrow at all: `totalEscrowed()` is zero and the only USDC
inside the contract is the 0.4075 staked across the six active covenants.

### Verified independently, without a key

```
node scripts/verify.ts --network arc-mainnet
```

43 checks, no wallet, no key, no spending — and no endpoint that could spend: the
checker asks for the public read endpoint and never for a write one. It verifies
that the bytecode exists at the recorded address, that each covenant matches the
chain term-for-term including the split table and the schema commitment, that each
settled order's recorded payouts are reproducible from the covenant's own rates,
and that the contract's balance is never less than the escrow and bonds it owes.
The count grows with the chain — every settled order adds a check — so it reads as a lower bound rather than a fact about the script. The same script passes
on Arc testnet.

The project also carries a live check the app performs on every read: `totalEscrowed()` must equal the sum of funded orders' escrow. When a settlement is in flight the two disagree for as long as it takes Arc to include the next block — under a second.

## Why this needs Arc specifically

VeriCall is not a generic escrow that happens to run on an EVM chain. Three properties of Arc are load-bearing:

1. **USDC is the native asset and the gas token.** Every settlement is denominated and paid in the same 6-decimal currency, and the calling software never has to hold a second, volatile token to release a payment. A rebate of 0.035097 USDC costs about 0.0001 USDC in gas.
2. **Deterministic sub-second finality.** An SLA measured in hundreds of milliseconds is only meaningful if settlement is not the slowest step. Arc finalises on inclusion, so the settlement of a 126 ms call is not waiting on confirmations.
3. **A protocol-level USDC blocklist that reverts at runtime.** This one changes the contract's shape. On Arc, a transfer to or from a blocked address reverts — so a settlement that pays four recipients could be bricked by *one* of them being sanctioned, freezing the others' money. VeriCall therefore never pushes blindly: every payout is a low-level call whose failure becomes a claimable credit for that recipient, so one restricted address can never stop everyone else from being paid.

## How it works

![End-to-end architecture: the caller escrows USDC in the clearinghouse on Arc, the Rust verifier executes the registered endpoint and measures it, and the contract splits the settlement across the provider and its upstream dependency or rebates the caller](docs/assets/architecture.svg)

![The settlement curve: full payout until the grace latency, a rebate rising linearly to the covenant's maximum at the hard timeout, and a full refund plus a bond penalty beyond it](docs/assets/sla-curve.svg)

### Six covenants, three kinds of service

| Service | Price | Grace / hard | What answers |
| --- | --- | --- | --- |
| `fx-rate` | 0.03 USDC | 0.8 s / 2.5 s | **A third party's real API.** The ECB reference rate published by Frankfurter. The verifier calls `api.frankfurter.dev`, measures it, and validates the shape of what came back. |
| `intent-router` | 0.05 USDC | 2.5 s / 10 s | One batched **TypeSafe Jev** request: a Choice over five payment intents, presence Nouls, a Score for urgency, a Noul for whether a person must authorise. Returns the whole distribution, the model's confidence, and what is missing. |
| `payment-guard` | 0.08 USDC | 3 s / 12 s | One batched **Jev** request: five hazard Nouls (amount, counterparty, duplication, urgency pressure, restricted party) plus a severity Score. The verdict is computed in code from published thresholds. |
| `risk-scorer`, `invoice-parser`, `ast-auditor` | 0.15–0.5 USDC | 0.4–1 s | **Reference services this project publishes**, so the settlement arithmetic can be inspected without depending on anyone. |

The FX covenant is the one that answers "is this a simulation?" most directly: the
call goes to a publisher this project does not control, and the settlement is the
contract's response to whatever that publisher actually returned that second.

Putting a model under an SLA is only honest if the promise is one a model can
keep, so two design choices matter:

* **The answer is typed, not prose.** A System One model returns calibrated
  probabilities, which means a covenant can *require* `intentProbability` and
  `confidence` in its schema and mean it. A schema over generated text would be a
  hope that the model happened to return valid JSON — which is exactly the failure
  mode VeriCall exists to price, not a property it should rely on.
* **Policy is code, not a prompt.** Jev supplies probabilities; the verdict comes
  from thresholds in `verifier/src/llm.rs` that a reader can find and change
  without another inference. The response carries the thresholds it used, so a
  caller with a different risk appetite can apply its own to the same evidence.

Every call spends real credits, and the live endpoint is public, so the client is
bounded three ways — two concurrent calls, twelve a minute, three hundred a day —
and `GET /api/health` reports what is left. A refused call is a *failed* call:
the verifier measures the refusal, the schema check fails, and the covenant
refunds the caller out of the provider's stake. That is demonstrated, not
asserted — see below.

### The moving parts

| Part | Where | What it is |
| --- | --- | --- |
| **Clearinghouse** | `contracts/` | `VeriCallClearinghouse.sol` — covenants, escrowed orders, the settlement arithmetic, bond accounting, the blocklist-safe payout path, and the EIP-712 verification of attestations. Authored and tested in Arc Studio. |
| **Verifier** | `verifier/` | A Rust service that executes real HTTP calls, measures latency against a monotonic clock, validates responses against the covenant's JSON schema, quotes the settlement, and signs EIP-712 attestations. It holds no funds and — in the live deployment — a key whose only power is to attest. |
| **App** | `web/src/` | A React front end that reads the chain directly, escrows a call from a connected wallet, runs live calls through the verifier, draws the settlement curve, and settles from the browser. Useful with no wallet at all: the proof ledger is read-only. |
| **Operator scripts** | `web/scripts/` | `deploy`, `plan-covenants`, `register`, `order`, `settle`, `bond`, `reclaim`, `verify` — every step of the lifecycle, each printing the explorer link and the fee it spent. |
| **Records** | `deployments/` | What actually exists onchain: contract addresses, transaction hashes, block numbers, and the covenant terms as registered, so any step can be reproduced and any claim checked. |
| **Service definitions** | `fixtures/services.json` | One source of truth for every published service. The Rust verifier embeds it and the tooling reads it, so the terms a covenant is registered with are the terms the verifier prices against, and the schema it validates against is the schema that was committed onchain. |

### The order lifecycle

```
provider                    caller                     verifier                 contract
   │                          │                            │                       │
   ├─ register covenant ──────┼────────────────────────────┼──────────────────────►│ terms + schema hash onchain
   ├─ stake bond ─────────────┼────────────────────────────┼──────────────────────►│ a breach must be funded
   │                          │                            │                       │
   │                          ├─ createOrder (escrow) ─────┼──────────────────────►│ bond must cover the penalty
   │                          │                            ├─ real HTTP call ──────┤
   │                          │                            ├─ measure latency ─────┤
   │                          │                            ├─ validate schema ─────┤
   │                          │◄── quoteSettlement ────────┤                       │ exact outcome, before signing
   │                          │                            ├─ sign EIP-712 ────────┤
   │                          ├─ settleOrder(attestation) ─┼──────────────────────►│ verifies signature
   │                          │                            │                       ├─ pay provider + dependencies
   │                          │◄── rebate if degraded ─────┼───────────────────────┤
   │                          │◄── refund + slash if breach┼───────────────────────┤
   │                          │                            │                       │
   │                          └─ or, after expiry: reclaimExpiredOrder (permissionless)
```

### What the contract trusts, and what it does not

The provider's price, SLA terms and split table are **immutable** once registered. The verifier's attestation is a **bounded** claim: it can only name an order that already exists, a latency, a schema verdict and a response hash, and it can only be redeemed inside that order's window. The contract computes every amount itself — the verifier supplies a measurement, never an amount. If a verifier lies about a latency, the provider is overpaid by at most one order's rebate and the bond covers the penalty; if it stays silent, the caller reclaims the escrow once the window closes and needs nobody's cooperation to do it.

## Innovation

**Nothing here calls a model.** That is the point. An SLA is only enforceable if "did the service deliver" has a deterministic answer, so the verifier answers it with a stopwatch, an HTTP status code and a JSON schema — not with a judgement. The novel parts are:

- **Continuous latency rebates as contract arithmetic.** Binary escrow ("delivered / not delivered") cannot price a 400 ms overrun. VeriCall's rebate is linear in the overrun and capped by the covenant, so the settlement is a function of the measurement rather than a negotiation.
- **Settlement and revenue distribution as one atomic action.** A successful call pays the provider and its upstream dependencies in the same transaction, by basis points, with the integer-division remainder assigned to the provider so the parts always sum exactly to the net amount. Paying five contributors out of a 3-cent API call is impossible on card rails and uneconomic on most chains; here it costs about a tenth of a cent.
- **A blocklist-safe payout path.** Enforced by Arc's runtime value-transfer rules, so the contract credits a failed payee instead of reverting everyone's settlement, and the credit stays claimable.
- **Term-first verification.** The verifier re-reads the covenant from the chain and refuses to sign if its configuration disagrees — a defence against stale config, which is the realistic failure, rather than assuming malice.
- **Schema commitments, canonical.** The schema hash is taken over a canonical serialisation, so reformatting a schema does not change what was agreed, while changing a constraint does. Both the Rust verifier and the TypeScript tooling implement the same canonicalisation, and the fixture hashes are asserted equal across the two languages in tests.

## Hackathon relevance

Built for **Arc Microgrants: Built with Arc Studio** (Circle, October 2026).

| Criterion | Weight | How this submission answers it |
| --- | --- | --- |
| Real USDC moving on Arc mainnet | 30% | **Eighteen settlements and nine permissionless reclaims**, across four wallets and six covenants, covering every outcome the contract can reach — thirteen passes, two linear rebates, three breaches refunded with a bond penalty, and nine expired orders returned to their callers. Each has a transaction hash and its exact amounts above. |
| Use of Arc Studio across the build | 25% | The contract, its Foundry test suite and its README were written, iterated and tested inside Arc Studio — workspace [`studio.arc.io/app/b3658244-c47e-4bb9-b1c5-3b34acc595cc`](https://studio.arc.io/app/b3658244-c47e-4bb9-b1c5-3b34acc595cc). Mainnet deployment, the verifier and the app were then built around that artefact; a second Studio turn built the in-workspace frontend. |
| A working product | 25% | [vericall.fly.dev](https://vericall.fly.dev) — the app and the verifier in one process, serving a proof ledger that reads Arc mainnet over three independent RPC endpoints and a workbench that runs real calls, draws the settlement curve and lets a wallet escrow, run and settle a call without leaving the page. Useful with no wallet at all; orders 23–25 above were each produced by that loop. |
| Potential to go further | 20% | The covenant is a general instrument: metered SaaS billing, agent-to-agent task settlement, and dependency royalties are the same primitive with different terms. A path into the Circle Grant Program is sketched under *Roadmap*. |

All three of the microgrant's suggested directions are one product here: **software-to-software payments**, **escrow and conditional payouts**, and **payment splitting with shared treasuries**.

## Running it

### Prerequisites

| Tool | Version used | Why |
| --- | --- | --- |
| Node | 22.14 | The operator scripts run TypeScript directly via `--experimental-strip-types` |
| pnpm | 11 | Front end and scripts |
| Rust | 1.97 (nightly is fine) | The verifier |
| Foundry | `forge 1.7.1` | Contract build and tests |

### Contract

```bash
cd contracts
forge install foundry-rs/forge-std@v1.9.7 --no-git
forge build
forge test -vv            # 52 tests
forge test --gas-report   # settleOrder ≈ 150k gas
```

`contracts/abi-lock.json` holds the compiled selectors. `verifier/src/abi.rs` asserts the Rust bindings against them, and the cross-language EIP-712 fixture is pinned in both languages, so a change to the type strings, the field order or the canonical JSON encoding fails a test rather than a settlement.

### Verifier

```bash
cd verifier
cargo test                # 69 tests
cargo build --release     # produces ../target/release/vericall
```

Environment (all optional except the chain choice; see `verifier/src/config.rs`):

```bash
VERICALL_NETWORK=mainnet                       # or testnet
VERICALL_CONTRACT=0xb980…0619                  # the deployed clearinghouse
VERICALL_COVENANTS=../deployments/covenants-arc-mainnet.json
VERICALL_WATCH_ADDRESSES=0x…,0x…,0x…           # the balance strip in the UI
VERICALL_VERIFIER_KEY=0x…                      # omit to run read-only: it will quote but not sign
VERICALL_PUBLIC_BASE_URL=https://vericall.fly.dev
VERICALL_STATIC_DIR=../web/dist                # serve the built app from the same origin
VERICALL_PORT=8787
```

```bash
../target/release/vericall
curl localhost:8787/api/health
```

With no key configured the verifier still executes calls, validates schemas and quotes settlements — it simply cannot produce the signature that settles. That is a useful review mode.

### App

```bash
cd web
pnpm install
pnpm dev                  # proxies /api to the verifier on :8787
pnpm build                # dist/, which the verifier can serve with VERICALL_STATIC_DIR
pnpm typecheck
```

### Wallet behaviour, checked rather than assumed

```bash
cd web
pnpm test:wallet     # 11 checks against a stubbed EIP-1193 provider
```

Connecting lands the wallet on the settlement chain in one action — the switch is
attempted immediately after the connection is granted, and a refusal leaves the
connection intact with the reason kept so the masthead can offer the switch again
rather than silently signing on the wrong chain.

Disconnecting clears the page's session and asks the wallet to drop the account
permission it granted. There is no standard "disconnect" in EIP-1193: a page cannot
un-authorise itself, and wallets that do not implement `wallet_revokePermissions`
return an error rather than honouring it. The button says so in its tooltip, the
local session clears either way, and the test asserts both.

### The whole loop, through the interface

```bash
cd web
pnpm wallet           # a loopback EIP-1193 provider, signing for one contract only
pnpm test:settle-ui   # connect → write a request → escrow → run → settle → receipt
```

Every other test settles from the command line. This one is the product's own
path: the browser connects a wallet, writes the request, takes the USDC allowance
the escrow needs, sends `createOrder`, waits for Arc to show the order, runs the
call, sends the signed settlement, and waits for the receipt to come back before
claiming anything.

`tools/demo-wallet.ts` is what makes that possible without a wallet extension in
the way: a loopback EIP-1193 provider that answers account and chain questions
itself, proxies reads to Arc, and signs `eth_sendTransaction` for two things only
— calls to the clearinghouse, and USDC `approve` for the exact escrow. It refuses every other target
and every other USDC call, so a stray request cannot move funds elsewhere, and it
listens on loopback only. It is a recording and testing harness, not part of the
product.

### Pricing an outage

```bash
cd web
node scripts/demo-outage.ts --network arc-mainnet --confirm-mainnet
```

Escrows one call, spends the service's own model budget until it refuses, settles
while it is refusing, and prints what the covenant did about it. The refusal is the
service's; the arithmetic afterwards is the contract's.

### The lifecycle, by hand

```bash
cd web
export ARC_MAINNET_WRITE_RPC=…        # an endpoint that accepts eth_sendRawTransaction
export DEPLOYER_KEY=… PROVIDER_KEY=… VERICALL_VERIFIER_KEY=…

node scripts/deploy.ts            --network arc-testnet
node scripts/plan-covenants.ts    --network arc-testnet --bonds "risk-scorer=0.05,invoice-parser=0.05,ast-auditor=0.08"
node scripts/register.ts          --network arc-testnet --bonds "risk-scorer=0.05,invoice-parser=0.05,ast-auditor=0.08"
node scripts/order.ts             --network arc-testnet --service risk-scorer
node scripts/settle.ts            --network arc-testnet --service risk-scorer --mode degraded
node scripts/verify.ts            --network arc-testnet
```

Every script prints the explorer link, the gas used and the fee in USDC. `--dry-run` is supported where a step would spend.

### Reading the chain without making a judge wait

The ledger is a read-mostly view: twenty-five orders with their transactions, six
active covenants, four balances and an event scan, which is several hundred RPC
calls. Serially that took the better part of a minute on Arc's public endpoints, so
three things changed:

* reads go out concurrently, bounded to eight at a time so the burst stays polite;
* the covenant's split table comes from `getService` rather than a second
  `getSplits` call, halving the per-covenant cost;
* the settlement-transaction index is incremental and built in the background, and
  the whole ledger is served from a 15-second cache with stale-while-revalidate.

A warm read is now ~0.2 s from the deployed region, and a cold start warms itself
at boot. A judge never waits on a log scan, and a row whose transaction has not
been indexed yet says so rather than pretending the transaction does not exist.

One case is deliberately not cached: `GET /api/ledger?fresh=1` does the read
before it answers. The cache is right for a browser that is watching, and wrong
for a caller that has just changed the chain — after escrowing an order, the
interface polls for its own commitment until it appears, because a caller should
never have to reload a page to see money they just committed.

### The live deployment

The app and the verifier are one process, so there is one origin, no CORS, and no way for the page
to drift from the service it is reading. `Dockerfile` copies an already-built binary rather than
compiling inside the image, because a Rust release build in a thin image recompiles dependencies
that are already compiled here and produces the same artefact.

```bash
cargo build --release                # produces target/release/vericall
cd web && pnpm install && pnpm build # produces web/dist
cd ..

flyctl apps create vericall
flyctl volumes ...                   # not needed: the deployment is stateless

# The verifier's key is a secret; it is never an argument, and never in the image.
flyctl secrets set VERICALL_VERIFIER_KEY=… --app vericall

flyctl deploy --ha=false --app vericall
```

Environment for the deployment lives in `fly.toml` and is only facts that are already public: the
network, the contract address, the three watched addresses, the covenant record path, and the public
base URL. The one secret is the verifier key, and the README says what it can and cannot do.

## Mocked versus real

Being precise about this matters more than the claim it protects.

| Real | Detail |
| --- | --- |
| The contract, its tests, the settlements | Deployed at [`0xb980…0619`](https://explorer.arc.io/address/0xb980fa2a21b09a7304da285187f67daf55600619) on Arc mainnet and Arc testnet. Every order in the table above moved real USDC. |
| The latency measurements | Measured by the verifier with a monotonic clock around a real HTTP request. |
| The schema verdicts | Computed by the verifier's own validator over the response bytes it actually received, and hashed. |
| The EIP-712 signatures | Signed by the verifier's key, recovered on-chain by the contract. |
| The chain reads in the app | `eth_call` against Arc mainnet, raced across three independent RPC providers, with the answering endpoint shown. |
| The split arithmetic | Integer arithmetic in the contract; the quote and the settlement are asserted equal in tests. |

| Simulated, and labelled as such | Detail |
| --- | --- |
| The three published services | `risk-scorer`, `invoice-parser` and `ast-auditor` are deterministic HTTP services hosted by the verifier so the whole path can be demonstrated without depending on someone else's API and network. They are real endpoints over real HTTP with real, *deliberate* latency; they are not third-party APIs. Their responses are fixed, and their `mode` parameter injects a latency or a schema violation so each verdict can be produced on demand. |
| The latency values in the demo | Injected by those services on request (`normal`, `degraded`, `breach`), because a demo that depends on a real network's jitter is not a demo. The measurement of them is entirely real. |
| The wallet in the walkthrough video | A loopback provider (`web/tools/demo-wallet.ts`) signs in place of a browser extension, so the recording does not fight a wallet popup. The transactions it signs are ordinary mainnet transactions, signed by one key for one contract; orders 23–25 are its work. |
| Third-party demand | No external customer has used VeriCall. All four wallets are funded by the operator, and the fourth is the interface's own. |

Nothing in the product's claims depends on a simulated component behaving like a real one: pointing a covenant at any HTTP endpoint is a one-line change to its `endpointUri`, and the verifier's executor refuses to call anything other than the registered URI.

## Security and reliability

**Permission model.** The registration authority may publish covenants on a provider's behalf, but a bond is always pulled from the provider's own wallet, so the operator never holds anyone's stake. Only the provider can withdraw stake, and only once its service is delisted with no open order — an open order is a promise a caller paid for. Only the provider or the authority may change the verifier or delist a service, and delisting does not cancel funded orders: they still settle or expire.

**Attestation surface.** An attestation is bound to one order, one service, a latency, a schema verdict, a response hash and a deadline, under a domain separator that includes the chain id and the contract address. Signatures are checked for the low-`s` malleability bound; a replay on another order, another provider or after the deadline is rejected. The tests exercise each of those rejections explicitly.

**The request the verdict is about is the request the caller wrote down.** An order stores `keccak256(endpoint ‖ "\n" ‖ body)`, and the verifier refuses to sign unless the bytes it is about to send hash to that value. This closes a real economic attack: without it, a caller could create an order and then point the verifier at *any* request — including one chosen to be slow or malformed — collect the breach refund, and take the provider's bond. The verifier's refusal names both hashes, so a mismatch is diagnosable rather than mysterious. `scripts/settle.ts` sends the bytes recorded at order time, and that record is checked against the chain when it is written.

**Denial of service.** The blocklist-safe payout path means a restricted recipient cannot freeze a settlement. A verifier that never settles cannot trap funds: `reclaimExpiredOrder` is permissionless after the deadline and pays only the original caller. `createOrder` requires the provider's bond to cover one order's penalty, so an unfunded promise is refused at the point of sale rather than discovered at breach.

**Economic bounds.** A wrong attestation is worth at most one order: the escrow plus the bond penalty the covenant already staked. The verifier's key in the live deployment can mis-attest but cannot move funds, and the caller pays the gas — a compromised verifier costs a caller at most the difference between the verdict it attested and the truth, capped by `maxRebateBps` and `slashPenaltyBps`.

**Key handling.** Private keys are read from environment variables by name, never accepted as command-line arguments (which land in shell history and process listings) and never printed. The deployment record contains addresses and hashes only. The live deployment holds the verifier key as a platform secret; it is a demo key whose only power is to attest, and it is documented here because pretending otherwise would be worse.

**Known risks.** Stated plainly, because a reviewer will find them anyway:

1. **The verifier is a single measurement point.** A caller who does not trust it should run its own; the code is one binary with no privileged state, and the covenant's `verifier` address is the only thing to change. Latency measured at the caller's edge is evidence of the caller's experience, which is what an SLA promises — not of the provider's internal performance.
2. **A caller chooses the request, so a caller can choose a bad one.** The contract pays a penalty for a breach, and a caller who deliberately sends a pathological request can provoke one. The request-binding check stops a caller from claiming a breach *it never asked for*, but it does not stop a caller from asking. This is the intended economics of an SLA credit — the provider's exposure per order is exactly the penalty rate it published, and it can price that in — but it is worth naming rather than implying that all breaches are the provider's fault. It matters less in practice for real services, which react to a bad request by rejecting it rather than breaching; it matters more for the built-in demo services below, because they take a `mode` parameter that can *request* a slow answer, and a covenant pointed at one of those has a genuinely extractable bond. The live deployment's three stakes total 0.18 USDC.
3. **The live verifier holds a signing key.** Its authority is bounded to attesting for the covenants it has been told about, and it cannot move funds — the caller pays and the contract holds the money — but it can mis-attest within one order's rebate. That is why the key is a demo key and why the amount at risk is stated above.

Guards against the first two are in *Roadmap*; the third is bounded by design and disclosed here.

## Limitations

- **Latency is measured by the party that wants a rebate.** The out-of-the-box fix is a counter-signed receipt from the provider or an independent attester; the covenant already carries a verifier address that can be set to either.
- **No dispute window.** A verdict is final on settlement. A covenant that wants a challenge period can set its verifier to a contract implementing one; the interface is a single address.
- **Three services, one chain.** The primitive is chain-agnostic in principle, but only Arc is implemented, because Arc's USDC-as-gas and blocklist semantics are what make the design what it is.
- **The bond is small.** Stakes here are 0.05–0.08 USDC, sized to the demo wallets. The mechanism is indifferent to size; the numbers are not a claim about real underwriting.
- **No partial deliveries.** A response is adjudicated whole: schema satisfied or not. Weighting a partially-correct response would need a covenant-supplied scoring function.
- **`eth_getLogs` on Arc's public RPCs caps ranges**, so the ledger reads state through contract view functions rather than reconstructing it from events. That is enough for the UI; an indexer would be needed for history at scale.

## Roadmap

1. **Counter-signed receipts** so a provider and a caller can settle without either party being the sole measurer, with the verifier address left empty for the caller to fill.
2. **Liability that survives the call**: an optional `attempts` parameter so one escrow can price a retry, and a rolling bond sized to a provider's outstanding volume rather than one order.
3. **A pool, not a bond**: underwrite a provider's aggregate breach risk instead of escrowing per order, which is the point at which this becomes a credit product.
4. **Payable dependencies**: let a dependency register itself as an upstream of a service and receive splits without the provider listing it, which needs one signature rather than a policy.
5. **Metered covenants**: batch an epoch of calls into one settlement, so a per-request price can be smaller than a transaction's worth of gas.

## Documentation

| Document | What it is for |
| --- | --- |
| [`docs/assets/vericall-demo.mp4`](docs/assets/vericall-demo.mp4) | The two-minute walkthrough: the live app, a real third-party call, the settlement curve, the ledger, a call escrowed and settled from the browser, and the independent check |
| [`docs/SUBMISSION.md`](docs/SUBMISSION.md) | The links, the transactions and the honest real-versus-simulated split, in submission order |
| [`docs/OUTREACH.md`](docs/OUTREACH.md) | What it would take to get the first user who is not us — the one number this submission cannot claim |
| [`docs/DEMO-RUNBOOK.md`](docs/DEMO-RUNBOOK.md) | The shot list and narration behind the video, so it can be re-recorded after a change |
| `docs/assets/` | The two diagrams above, as SVG |

## Repository map

```
contracts/            VeriCallClearinghouse.sol, Foundry suite, abi-lock.json
verifier/             Rust: SLA math, EIP-712, executor, schema validator, HTTP API
web/src/              React app: payoff curve, live execution, proof ledger
web/scripts/          deploy · plan-covenants · register · order · settle · bond · reclaim · verify
web/tools/            A loopback EIP-1193 wallet, for testing and recording the interface
deployments/          The onchain record: addresses, hashes, blocks, registered terms
docs/assets/          Diagrams, and the walkthrough video
Dockerfile, fly.toml  The live deployment
```

## Acknowledgements

The contract was written and tested inside **Arc Studio**, the onchain coding agent for Arc. The settlement semantics were specified first — a written SLA, a piecewise rebate, a bond that must cover the promise, a payout path that survives a blocklist — and the tests exist to hold the implementation to that specification. The Rust verifier re-implements the settlement arithmetic deliberately, and a cross-language test pins the two to the same numbers, because a verifier that disagrees with the contract about what a latency costs is worse than no verifier at all.

USDC is Circle's. Arc is Circle's. The escrow, the arithmetic and the mistakes are ours.

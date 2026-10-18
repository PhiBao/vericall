# Submission notes

Everything a reviewer needs, in the order they will want it. The same material, with more
reasoning, is in [`README.md`](README.md).

---

## One line

**VeriCall escrows a USDC payment for a software-to-software API call and settles it against the
promise the API published — latency and response schema — splitting the money across the provider
and its upstream dependencies in the same transaction, or rebating and refunding the caller when
the promise is missed.**

## The links a submission needs

| What | Where |
| --- | --- |
| **Arc Studio project** | https://studio.arc.io/app/b3658244-c47e-4bb9-b1c5-3b34acc595cc |
| **Live app** | https://vericall.fly.dev |
| **Walkthrough video** | [`docs/assets/vericall-demo.mp4`](assets/vericall-demo.mp4) — two and a half minutes, recorded against a local instance of the deployed build, settling a real order on mainnet and showing that transaction on Arc's explorer |
| **Public repository** | https://github.com/PhiBao/vericall |
| **Builder profile** | https://github.com/PhiBao |
| **Contract (Arc mainnet)** | [`0xb980fa2a21b09a7304da285187f67daf55600619`](https://explorer.arc.io/address/0xb980fa2a21b09a7304da285187f67daf55600619) |
| **Deploy transaction** | [`0xe251f33d…`](https://explorer.arc.io/tx/0xe251f33dab9eb1b21e526d235233ecb7fa12a59f6453e587ab274609d04fa437) |
| **Contract (Arc testnet)** | same address, [`0xb980fa2a…`](https://explorer.testnet.arc.io/address/0xb980fa2a21b09a7304da285187f67daf55600619) — the two chains share a deployer and a nonce |

## One covenant buys a third party's API; two are real model calls

`fx-rate` is a real call to the European Central Bank reference rate published by
Frankfurter — a publisher this project does not control. The verifier calls it,
measures it, and validates the shape of the response; the contract settles on what
came back. That is the plainest answer to "is this a simulation?".

`intent-router` and `payment-guard` are served by a live **TypeSafe Jev** request,
not by fixed logic. One batched question set each: a Choice over a closed set of
intents, five hazard Nouls, presence Nouls, and Score questions for urgency and
severity. The response is typed probabilities, which is what makes a covenant over
it meaningful — the schema requires `confidence` and a probability per option, and
a model returning prose could not satisfy it. The verdict the guard returns is
computed in code from published thresholds, so policy stays visible and changeable
without another inference.

Because every call spends real credits on a public endpoint, the client is bounded
to two concurrent calls, twelve a minute and three hundred a day, and `/api/health`
reports what is left. A refused call is a *failed* call: the verifier measures the
refusal and the covenant refunds the caller out of the provider's stake.

## Example mainnet transactions, one per verdict

| Verdict | What moved | Transaction |
| --- | --- | --- |
| **Pass** — 0.20 USDC, grace 500 ms | 0.16 USDC to the provider, 0.04 to its upstream dependency | [`0x8a2e8f07…`](https://explorer.arc.io/tx/0x8a2e8f07a0c1e0bf28dae3c4b0a23c853ffc4f7d4f591f02f689e10af0833cc1) |
| **Degraded** — 1250 ms measured | 0.035097 rebated to the caller, 0.128 to the provider, 0.032 to the dependency | [`0x83f9b9f5…`](https://explorer.arc.io/tx/0x83f9b9f51c03316415b99533a4967940471d13cdc98db177406712eba647028f) |
| **Breach** — 2251 ms, schema violated | 0.2 escrow refunded plus 0.04 slashed from the provider's bond | [`0x11d372cf…`](https://explorer.arc.io/tx/0x11d372cfc5db58a1d3af74f9f960ba80a43b7e9462434329c49708ae9cf7bb31) |
| **Pass, attested by the live deployment** | 0.16 + 0.04, signed by the service at vericall.fly.dev | [`0xf648f251…`](https://explorer.arc.io/tx/0xf648f251650a7315d8c6f6a87126ceebbc0e3dbd03d0171eb548be816778ef7f) |
| **Pass on a model call** (`intent-router`, Jev) | 0.04 to the provider, 0.01 to its dependency, 251 ms | [`0x6370fb2f…`](https://explorer.arc.io/tx/0x6370fb2f945fcda6cd6a36770bcc9c449d3d6ba8564ec2b51ba8936190cc4fa1) |
| **Breach from a real model outage** (`payment-guard`, Jev) | the service hit its own rate limit and refused; 0.096697 refunded to the caller, 0.02 slashed from the stake | [`0x586230ca…`](https://explorer.arc.io/tx/0x586230cac965d342ff09679ab5e1873098c133b231911ae82a0616e59d434c48) |
| **Pass on a third party's API** (`fx-rate`, ECB via Frankfurter) | 61 ms measured, 0.021 to the provider, 0.009 to its dependency — a call to a publisher this project does not control | [`0x5cccd30b…`](https://explorer.arc.io/tx/0x5cccd30b9bb91ded0d6d6cd462e7ecf9933c40be40a229855003c291b53d6388) |
| **Pass, escrowed and settled from the app itself** (`fx-rate`) | 146 ms measured, 0.021 to the provider, 0.009 to its dependency — the whole loop in the browser, from a wallet that had never touched the contract. Orders 23 and 24 are two more of the same, at 166 ms and 156 ms | [`0x718bef04…`](https://explorer.arc.io/tx/0x718bef04f9f35d6145c546d67ddb8ecce8c48ad046e92012e320221017acf7e8) |

Eighteen settlements and nine permissionless reclaims in total, across four wallets
and six covenants — three deterministic services, two model-backed ones and one
that belongs to somebody else — with different prices, rates and splits.
`README.md` lists them with the exact amounts.

The outage settlement is worth reading closely: `scripts/demo-outage.ts` spends the
service's own per-minute model budget until it starts refusing calls, then settles
an order while it is refusing. The refusal is the service's, not an injected
failure, and the arithmetic that follows is the contract's. A model outage is priced
the same way a slow endpoint is.

## How Arc Studio was used

The contract, its Foundry test suite and its README were written, iterated and tested inside Arc
Studio, at the project link above. The session shows the prompts, the generated Solidity, the
compiler and test runs, and the workspace app. Studio's own build was then verified again from
outside: a second, independent test suite (`contracts/test/VeriCallClearinghouse.t.sol`, 52 tests)
exercises the same artefact against the settlement arithmetic the product promises, and it found
one real defect in the generated code — a covenant whose grace latency equals its hard timeout
divided by zero and reverted every such call, which is now guarded and covered by a fuzz test.

Beyond Arc Studio's testnet-only scope, this repository adds the parts a mainnet product needs: the
deployment tooling, the Rust verifier, the app, the operator scripts, and an external verification
pass that a reviewer can run without a wallet.

## What is real, and what is not

**Real:** the contract on Arc mainnet; every settlement in the tables above; the latency
measurements (monotonic clock around a real HTTP request); the schema verdicts (a validator over the
response bytes actually received); the EIP-712 signatures (recovered onchain by the contract); the
chain reads in the app (raced across three independent RPC endpoints, with the answering endpoint
shown); and the transaction hashes in the ledger (scanned from the contract's own events).

**Not real, and labelled as such in the UI and the README:** three of the six published covenants
name deterministic HTTP endpoints hosted by the verifier, so the settlement arithmetic can be
exercised without depending on a third party's API and network. They are real endpoints over real
HTTP with real, deliberately injected latency. Two are real model calls, and one is a real third
party's API. No external customer has used VeriCall; all four wallets are funded by the operator,
and the fourth exists to exercise the interface. The walkthrough video signs through a loopback
provider instead of a wallet extension, so the recording does not fight a popup; the transactions it
signs are ordinary mainnet transactions, signed by one key, for one contract.

## What a reviewer should try first

1. Open **https://vericall.fly.dev** — no wallet needed. The proof ledger reads Arc mainnet live:
   the invariant check, every settled order with its transaction link, the balances of the four
   wallets, and each covenant's published terms including the bond it has staked.
2. Scroll to **Live call**, choose a mode, and press **Run call**. The verifier executes the
   registered endpoint, measures it, validates the response, and the telemetry trace shows each
   step — request hash, measured latency, schema result, the exact quote, and the `settleOrder`
   payload it would sign. Nothing is simulated; the call really happens.
3. Drag the **payoff curve** slider to see what any latency would cost.
4. With a wallet and a few cents of USDC: **Start a call** writes a request, approves exactly that
   escrow, escrows it onchain, runs it and settles it from the same page. That is the loop orders 23–25 came from, and the
   loop the video ends on.
5. Run the independent checks:
   ```
   node web/scripts/verify.ts --network arc-mainnet     # 43 checks today, no key, no spending
   cd web && pnpm test:wallet                           # 11 checks against a stubbed wallet
   cd web && pnpm wallet & pnpm test:settle-ui          # the whole loop, in a real browser
   ```
6. Read the contract's rules in `contracts/src/VeriCallClearinghouse.sol` and the arithmetic that
   prices a millisecond in `verifier/src/sla.rs`, which is asserted equal to the Solidity in tests.
7. Connect a wallet: it lands on Arc in one action, and Disconnect clears the session and asks the
   wallet to drop the page's account permission where its API allows that.

## Tracks

All three of the microgrant's suggested directions are one product here:

- **Software-to-software payments** — a service pays another service for a call, and the payment is
  conditional on the delivery.
- **Escrow and conditional payouts** — the escrow releases, rebates or refunds according to the
  covenant's own terms, with a bond funding the refundable part.
- **Payment splitting and shared treasuries** — every settlement splits across the provider and its
  upstream dependencies by basis points, in the same transaction, remainder included.

## What the grant would fund

1. **Counter-signed receipts**, so a provider and a caller can settle without either being the sole
   measurer — the covenant already carries a verifier address that can be set to either party.
2. **A liability that survives the call**: rolling bonds sized to a provider's outstanding volume
   rather than one order, and an optional retry budget so one escrow can price an attempt.
3. **Two or three real callers.** The honest next step is not more code: it is one provider and one
   caller who are not us, paying for one real call, and reporting what broke. The machinery for a
   pilot is in place; a single third-party service pointed at a covenant would be the first
   evidence that the demand is real.
4. **Metered covenants**, batching an epoch of calls into one settlement so a per-request price can
   be smaller than a transaction's worth of gas.

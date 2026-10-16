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
| **Public repository** | https://github.com/PhiBao/vericall |
| **Builder profile** | https://github.com/PhiBao |
| **Contract (Arc mainnet)** | [`0xb980fa2a21b09a7304da285187f67daf55600619`](https://explorer.arc.io/address/0xb980fa2a21b09a7304da285187f67daf55600619) |
| **Deploy transaction** | [`0xe251f33d…`](https://explorer.arc.io/tx/0xe251f33dab9eb1b21e526d235233ecb7fa12a59f6453e587ab274609d04fa437) |
| **Contract (Arc testnet)** | same address, [`0xb980fa2a…`](https://explorer.testnet.arc.io/address/0xb980fa2a21b09a7304da285187f67daf55600619) — the two chains share a deployer and a nonce |

## Example mainnet transactions, one per verdict

| Verdict | What moved | Transaction |
| --- | --- | --- |
| **Pass** — 0.20 USDC, grace 500 ms | 0.16 USDC to the provider, 0.04 to its upstream dependency | [`0x8a2e8f07…`](https://explorer.arc.io/tx/0x8a2e8f07a0c1e0bf28dae3c4b0a23c853ffc4f7d4f591f02f689e10af0833cc1) |
| **Degraded** — 1250 ms measured | 0.035097 rebated to the caller, 0.128 to the provider, 0.032 to the dependency | [`0x83f9b9f5…`](https://explorer.arc.io/tx/0x83f9b9f51c03316415b99533a4967940471d13cdc98db177406712eba647028f) |
| **Breach** — 2251 ms, schema violated | 0.2 escrow refunded plus 0.04 slashed from the provider's bond | [`0x11d372cf…`](https://explorer.arc.io/tx/0x11d372cfc5db58a1d3af74f9f960ba80a43b7e9462434329c49708ae9cf7bb31) |
| **Pass, attested by the live deployment** | 0.16 + 0.04, signed by the service at vericall.fly.dev | [`0xf648f251…`](https://explorer.arc.io/tx/0xf648f251650a7315d8c6f6a87126ceebbc0e3dbd03d0171eb548be816778ef7f) |

Seven mainnet settlements in total, across three wallets and two covenants with different prices,
rates and splits. `README.md` lists all seven with the exact amounts.

## How Arc Studio was used

The contract, its Foundry test suite and its README were written, iterated and tested inside Arc
Studio, at the project link above. The session shows the prompts, the generated Solidity, the
compiler and test runs, and the workspace app. Studio's own build was then verified again from
outside: a second, independent test suite (`contracts/test/VeriCallClearinghouse.t.sol`, 51 tests)
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

**Not real, and labelled as such in the UI and the README:** the three published services are
deterministic HTTP endpoints hosted by the verifier so the path can be demonstrated without
depending on a third party's API and network. They are real endpoints over real HTTP with real,
deliberately injected latency. No external customer has used VeriCall; the three wallets are ours.

## What a reviewer should try first

1. Open **https://vericall.fly.dev** — no wallet needed. The proof ledger reads Arc mainnet live:
   the invariant check, the seven settled orders with their transaction links, the balances of the
   three wallets, and each covenant's published terms including the bond it has staked.
2. Scroll to **Live call**, choose a mode, and press **Run call**. The verifier executes the
   registered endpoint, measures it, validates the response, and the telemetry trace shows each
   step — request hash, measured latency, schema result, the exact quote, and the `settleOrder`
   payload it would sign. Nothing is simulated; the call really happens.
3. Drag the **payoff curve** slider to see what any latency would cost.
4. Run the independent check:
   ```
   node web/scripts/verify.ts --network arc-mainnet     # 23 checks, no key, no spending
   ```
5. Read the contract's rules in `contracts/src/VeriCallClearinghouse.sol` and the arithmetic that
   prices a millisecond in `verifier/src/sla.rs`, which is asserted equal to the Solidity in tests.

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

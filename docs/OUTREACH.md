# Getting to one outside user

The honest gap in this submission is demand: every wallet in the ledger is the
operator's. A fourth wallet settled orders 23–25 through the interface, which
proves the product works for an address with no history against the contract, but
it does not prove that anyone outside this project wants the product.

This is the smallest next step that would change that, and it needs a person, not
more code.

---

## What would count

Pick either side — both are useful, and one of each is ideal:

| Who | What they would do | What it costs them |
| --- | --- | --- |
| **A caller** | Point a script or an agent at `vericall.fly.dev`, escrow one call against an existing covenant, settle it | ~0.03 USDC plus a few cents of gas on Arc |
| **A provider** | Publish a covenant for an endpoint they already run, stake the bond, let someone buy one call | The bond (0.02–0.05 USDC here), refunded when they delist |

A caller needs Arc USDC and a wallet. A provider needs an HTTP endpoint and about
ten minutes with `web/scripts/register.ts`.

## What to say

A three-sentence post, not a pitch. Anywhere the Arc community reads: Arc House,
the Circle developer Discord, a message to someone whose API you already pay for.

> I built VeriCall on Arc mainnet — it escrows USDC for a software-to-software API
> call and settles it against the latency and response shape the provider published,
> so a late or malformed answer is rebated or refunded out of a staked bond instead
> of argued about. It is live at vericall.fly.dev and the whole ledger is public:
> 16 settlements, every verdict the contract can reach, all with transaction links.
> What it does not have yet is a single user who is not me — if anyone wants to be
> the first, I will walk you through pointing your endpoint at a covenant, or buy
> one call from an endpoint you already run. I will cover the gas either way.

If the ask feels too open, make it specific: name one endpoint you would buy, and
offer to fund the first call. The point of the exercise is not the 0.03 USDC, it is
the list of things that break when someone who did not build it tries it.

## What to record when it happens

Add one row, with the transaction:

| # | Service | Caller | Verdict | Measured | Transaction |
| --- | --- | --- | --- | --- | --- |
| — | — | *a wallet that is not ours* | — | — | — |

And be as blunt about the outcome if it fails. "The first outside caller could not
connect because X" is a better submission than a claim that everything worked.

## Why this is the right next step, and the next one after it

The mechanism is finished enough to be tested by someone else: the contract is
immutable and verified, the verifier is one binary with no privileged state, the
wallets hold nothing that matters, and the failure modes are bounded to one order's
rebate. What is unproven is whether a stranger will use it, and no amount of
additional code answers that question.

If the answer is yes, the work that follows is in `README.md` under *Roadmap*:
counter-signed receipts so neither party is the sole measurer, a bond sized to
outstanding volume rather than one order, and metered covenants so a per-request
price can be smaller than a transaction's worth of gas.

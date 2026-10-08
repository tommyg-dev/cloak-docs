# Demo dataset

CLOAK ships a fictional wallet, "Specimen 07", that lets anyone run the full pipeline without a Helius key. This document describes its guarantees, how it is generated, which scripted behaviors exercise which signals, and the report it produces.

## Contents

- [Why it exists](#why-it-exists)
- [Guarantees](#guarantees)
- [How it is generated](#how-it-is-generated)
- [Scripted behaviors](#scripted-behaviors)
- [Fictional balances and label](#fictional-balances-and-label)
- [Second-hop neighbourhoods](#second-hop-neighbourhoods)
- [Determinism test](#determinism-test)
- [Resulting report](#resulting-report)

Implementation reference: `lib/demo/constants.ts`, `lib/demo/dataset.ts`, `lib/demo/secondHop.ts`, `lib/demo/index.ts`.

## Why it exists

- **Evaluation without credentials.** A deployment without `HELIUS_API_KEY` reports `status: "demo-only"` and still lets visitors explore every terminal view.
- **A worked example for reviewers.** Engineers and auditors can see every signal fire on known inputs and trace each one back to the scripted behavior that caused it.
- **No real person as a specimen.** Demonstrating CLOAK on a real wallet would publish an analysis of someone's activity. The demo uses generated data instead.

## Guarantees

| Guarantee | How it is enforced |
|---|---|
| Deterministic | All generated values come from `mulberry32(0x6857)`; no `Math.random()`, no wall-clock time |
| Fixed clock | `DEMO_NOW = Date.UTC(2026, 8, 30, 21, 0, 0) / 1000`, i.e. **2026-09-30T21:00:00Z**; demo reports use it for `generatedAt` and `coverage.fetchedAt` |
| Generated identities | The wallet's counterparties, every transaction signature, two NFT mints, the fictional SPCMN mint, the label and the balances are generated. Addresses are random 32-byte values, base58-encoded, and are not intended to correspond to real mainnet accounts |
| Clearly labeled | The scan emits `Demo mode · fictional dataset · no provider calls` and `Loaded 96 fictional transactions (DEMO DATA)`; the terminal shows `Demo data · fictional`, DEMO badges, and `demo · no record` in place of explorer links; shareable summaries say `DEMO DATA (fictional wallet)`; JSON exports carry `"demo": true` and their filenames get a `-DEMO` suffix |
| Demo mode accepts only the demo address | Every API route returns `400 demo_address_only` for any other address in `mode=demo` (`demoGuard` in `lib/server/http.ts`) |
| No provider calls | Demo scans, summaries, transaction pages and graphs never contact Helius |
| Same code path as live data | Raw results are emitted in the provider's Parsed Events shape and pass through the live normalizer and analysis engine |

The demo address is:

```text
CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11
```

It is a syntactically valid Solana address (32 bytes after base58 decoding; covered by a test) chosen to be readable. Demo mode never queries it on-chain. Live mode does not special-case it: scanning it in Live mode queries Helius like any other address.

**Real identifiers used on purpose.** Program IDs (System Program, SPL Token, Compute Budget, Jupiter Aggregator v6, Magic Eden v2, Marinade Finance) and the USDC, BONK, JUP and wrapped-SOL mints are the real mainnet identifiers, taken from `lib/solana/programs.ts` or hard-coded. This is required so that program recognition, infrastructure filtering and token symbols behave exactly as they do on live data. They do not make the demo wallet's activity real.

## How it is generated

`buildDemoDataset()` (`lib/demo/dataset.ts`) builds the dataset once per server process and caches it:

1. Seed `mulberry32(0x6857)`. Helpers draw addresses (32 random bytes → base58), signatures (64 random bytes → base58) and choices from this single stream, so the output depends only on call order.
2. Generate eight actors (`exchange`, `rent`, `peerA`, `peerB`, `peerC`, `jupVault`, `nftSeller`, `poison`) and 14 one-off counterparties.
3. Emit transactions as raw `TransactionResult` objects, the same shape returned by `POST /v1/parsed-events/transaction-history`:

```ts
// lib/demo/dataset.ts (trimmed)
results.push({
  signature: sig(),
  parserStatus: 'OK',
  parsed: {
    slot,
    blockTime: o.t,
    fee: 5000 + Math.floor(rnd() * 3) * 5000,
    feePayer: W,
    transactionStatus: o.ok === false ? 'ERROR' : 'OK',
    nativeTransfers: o.native ?? [],
    tokenTransfers: o.tokens ?? [],
    summary: o.summary ?? null,
    instructions: [{ programId: CB, programName: 'compute_budget' }, ...programs],
  },
})
```

4. Sort newest first by `blockTime`.

`demoTransactions()` (`lib/demo/index.ts`) runs these results through `normalizeParsedResult`, the live normalizer, and `dedupeTxs`. The scan orchestrator does the same through `normalizeHistory`. See [Normalization model](04-normalization-model.md).

**Window.** Transactions are placed on days 0–73 after `START = DEMO_NOW − 74 × 86,400 s` (2026-07-18T21:00:00Z), giving a 74-day window. The captured report's coverage runs from 2026-07-18 21:41:58 UTC to 2026-09-30 19:47:44 UTC (`spanDays: 73.9`).

**Habitual window.** Each timestamp is produced by `at(day, habitual)`:

```ts
// lib/demo/dataset.ts
const at = (day: number, habitual = 0.72) => {
  const base = START + Math.floor(day) * 86_400
  const hour = rnd() < habitual ? 14 + rnd() * 4 : rnd() * 24
  return Math.floor(base + hour * 3600 + rnd() * 60)
}
```

With probability `habitual`, the transaction falls 14–18 hours after the day's base time; otherwise it is uniform over 24 hours. Because `START` (and every day's base) is at **21:00 UTC**, "14–18 hours after base" lands at **11:00–15:00 UTC** on the following calendar day. The source comment describes the window as "14–18h"; that is the offset from base, not the UTC clock time. The analysis correctly reports a peak window of 11:00–15:00 UTC.

**Synthetic artifacts.** Two simplifications are visible in the raw data and do not affect the analysis:

- `feePayer` is the demo wallet on every transaction, including inbound transfers.
- Slots increase in generation order (starting at 312,000,000, +1,000 to +41,000 per transaction), not in time order. Analysis orders by timestamp and uses slot only as a tiebreak.

## Scripted behaviors

96 transactions are generated. Each behavior targets one or more analysis rules; the right-hand column shows the result in the captured report ([`examples/report.demo.json`](../examples/report.demo.json)).

| Behavior | Generation | Habitual share | Exercises | Outcome |
|---|---|---|---|---|
| Exchange first funding | 1 × 25 SOL `exchange → wallet` on day 0 | 0.3 | Funding source; labeling | `funding-earliest`: "25.0000 SOL arrived from 5XuR…rh9K on 2026-07-18" |
| Exchange top-ups | 4 × 4–13 SOL `exchange → wallet` on days 18, 39, 57, 70 | 0.72 | Repeated counterparty; labeling | Exchange has 7 transactions → `repeated-5XuR…` |
| Exchange deposits | 2 × 6–10 SOL `wallet → exchange` on days 33, 66 | 0.72 | Bidirectional relationship | Exchange edge drawn in both directions |
| Weekly fixed payment | 11 × 1.5 SOL `wallet → rent`, days 3, 10, …, 73 | 0.85 | Recurring payment; repeated counterparty | `recurring-HVqm…-1.500` (11 transfers); `repeated-HVqm…` (11 tx) |
| Peer A | 13 SOL transfers, 55 % outbound, 0.05–2.45 SOL | 0.72 | Repeated counterparty (both directions) | `repeated-7n6s…` (13 tx, 4 in / 9 out) |
| Peer B | 5 × 20–220 USDC `wallet → peerB` (SPL Token) | 0.72 | Token-transfer legs; repeated component | Counted as repeated (5 tx); not among the top 3 listed as signals |
| Peer C | 3 × 0.2–1.2 SOL `peerC → wallet` | 0.72 | Inbound-only relationship; repeated threshold (≥ 3) | Counted as repeated (3 tx) |
| One-off counterparties | 14 × 0.01–0.81 SOL, 60 % outbound, one per counterparty | 0.5 | Concentration and HHI dilution | Top counterparty holds 13 of 56 interactions (23 %), below the 40 % concentration-signal threshold; HHI 0.1263 |
| Jupiter swaps | 29 swaps via a generated `jupVault`, pairs drawn from wSOL→USDC, wSOL→BONK, USDC→wSOL, wSOL→JUP, BONK→wSOL; provider summary `type: swap, protocol: jupiter` | 0.8 | Public trading; venue attribution | `trading-public` (29 swaps, 4 tokens); `jupVault` is **not** a counterparty |
| NFT marketplace | 3 × 0.8–2.8 SOL `wallet → nftSeller` with Magic Eden v2 + System instructions, no summary | 0.72 | Program footprint; repeated threshold | Magic Eden v2 in program list; `nftSeller` counted as repeated (3 tx) |
| Staking program calls | 4 Marinade Finance calls, no transfers | 0.72 | Program footprint | 3 distinct non-infrastructure programs (Jupiter, Marinade, Magic Eden v2) |
| Failed transactions | 3 Jupiter calls with `transactionStatus: 'ERROR'` | 0.72 | Failure handling | `failedCount: 3`; excluded from relationship legs |
| Address-poisoning dust | 4 × 0.000001 SOL (1,000 lamports) `poison → wallet` | 0.2 | Dust filter (`DUST_LAMPORTS = 10,000`) | `poison` is **not** a counterparty and creates no edge |

Every transaction also carries a Compute Budget instruction. Compute Budget, System Program and SPL Token are in `PLUMBING_PROGRAMS` (`lib/solana/programs.ts`) and are excluded from program-footprint metrics.

Counts: 7 exchange + 11 weekly + 13 + 5 + 3 peer + 14 one-off + 29 swaps + 3 NFT + 4 staking + 3 failed + 4 dust = **96**. The normalized kind mix is 57 transfer (including the dust), 29 swap, 7 program, 3 failed.

Behaviors that intentionally do **not** fire:

- **Concentration signal**: the 14 one-offs keep the top counterparty's share below 0.4.
- **Program-habit signal**: Jupiter is the top program at 31 % of successful transactions, below the 0.4 threshold.

## Fictional balances and label

Balances are fixed values, not derived from the transactions (`balances` in `buildDemoDataset`). USD values use fictional prices.

| Asset | Amount | USD value | Kind |
|---|---|---|---|
| SOL | 42.371 (42,371,000,000 lamports) | 6,355.65 (at 150 per SOL) | native |
| USDC | 1,250.4 | 1,250.40 | fungible |
| JUP | 340.2 | 272.16 (at 0.8) | fungible |
| BONK | 18,400,000 | 368.00 (at 0.00002) | fungible |
| SPCMN "Specimen Token (fictional)" | 9,000 | none published | fungible (generated mint) |
| "Fictional Collection #0412" | 1 | none | NFT (generated mint) |
| "Fictional Collection #1187" | 1 | none | NFT (generated mint) |

`truncated: false`; `fetchedAt` is `DEMO_NOW`.

One label is defined, on the exchange actor:

```json
{ "name": "Demo Exchange (fictional)", "category": "Centralized Exchange", "type": "exchange", "source": "demo" }
```

Demo reports carry `labelSupport: "demo"`.

## Second-hop neighbourhoods

When the Trace Map requests depth 2 in demo mode, `buildWalletGraph` calls `demoSecondHopTxs(seed, 50)` for each second-hop seed (up to 5 unlabeled counterparties, most-connected first; see [Trace Map](09-trace-map.md)). For each seed address (`lib/demo/secondHop.ts`):

1. A 32-bit FNV-1a hash of the seed address seeds a generator with the same mulberry32 step function, so each counterparty always gets the same neighbourhood.
2. Six neighbours are drawn: one **shared** neighbour, generated once from the fixed seed `0xbeef` and reused for every seed, plus five seed-specific addresses. Neighbour selection is skewed toward the first entry, the shared neighbour (`rnd() ** 1.6`), so several first-hop counterparties are likely to connect to the same second-hop address, which demonstrates an overlapping neighbourhood in the Trace Map.
3. Between 10 and 23 transfers are generated (capped at the requested limit), each a System Program SOL transfer of 0.02–3.02 SOL in a random direction, timestamped within the same 74-day window, already in `NormalizedTx` form.

The graph builder then applies the normal second-hop caps (6 neighbours per seed, 80 nodes total).

## Determinism test

`tests/provider.test.ts` → `demo pipeline` → "produces a deterministic, fully-labeled report through the live code path":

- builds the report twice with `assembleReport` on `demoTransactions()`, the demo balances and labels, and fixed `generatedAt`/`fetchedAt`, and asserts deep equality;
- asserts `mode === 'demo'`, `score.status === 'scored'` and `coverage.txCount > 80`;
- asserts the `poison` actor is not a counterparty (dust filter) and the `jupVault` actor is not a counterparty (swap legs go to the venue);
- asserts the signal categories include `holdings`, `repeated-counterparty`, `recurring`, `temporal`, `trading`, `labeling` and `funding`.

Because `buildDemoDataset()` caches its result per process, the two runs share the same generated input; the test establishes that the analysis is deterministic over that input. Generation itself is deterministic because the only entropy source is the fixed-seed generator. Another test asserts the demo address is a valid Solana address.

## Resulting report

Captured from production in demo mode ([`examples/report.demo.json`](../examples/report.demo.json), report id `GR-0URAI4F`):

| Metric | Value |
|---|---|
| CLOAK Index | **77**, band `high`, evaluated weight 100 % |
| Coverage | 96 transactions (93 successful, 3 failed) over 73.9 days; 1 page; `requestedLimit` 300 (the server's `CLOAK_MAX_TX`); `limitReached: false` |
| Counterparties | 20 |
| Signals | 9 |
| Graph (depth 1) | 21 nodes (wallet + 20 counterparties) / 22 directed edges |
| Peak window | 11:00–15:00 UTC, 80.2 % of timestamped activity |
| Counterparty HHI | 0.1263 |
| Top-3 counterparty share | 0.5536 |
| Median gap between transactions | 73,228 s (about 20.3 h) |

Index components:

| Component | Weight | Raw | Points | Basis |
|---|---|---|---|---|
| holdings | 15 | 0.6 | 9 | 4 fungible, 2 NFT, SOL present (saturates at 10) |
| repeated | 20 | 1 | 20 | 6 counterparties with ≥ 3 shared transactions (saturates at 6) |
| concentration | 15 | 0.5536 | 8.3 | Top 3 counterparties hold 55 % of 56 transfer interactions |
| temporal | 15 | 0.7625 | 11.44 | 80 % of activity in the busiest 4 h UTC window (uniform ≈ 17 %) |
| programs | 10 | 0.3 | 3 | 3 distinct non-infrastructure programs (saturates at 10) |
| trading | 15 | 1 | 15 | 29 swaps (saturates at 15) |
| labels | 10 | 1 | 10 | 7 transactions with publicly labeled counterparties (saturates at 5) |

Signals, in report order: `repeated-7n6s…` (13 tx), `repeated-HVqm…` (11 tx), `temporal-peak`, `trading-public`, `funding-earliest`, `holdings-visible`, `label-5XuR…` (Demo Exchange), `recurring-HVqm…-1.500`, `repeated-5XuR…` (Demo Exchange, 7 tx). See [CLOAK Index](08-cloak-index.md) for the formulas and [Exposure signals](07-exposure-signals.md) for each signal's thresholds.

See also: [Normalization model](04-normalization-model.md) · [Exposure signals](07-exposure-signals.md) · [CLOAK Index](08-cloak-index.md) · [Example outputs](../examples/README.md)

# Exposure Signals

Exposure Signals are discrete, explainable findings derived from a wallet's normalized public activity. This document specifies every signal CLOAK can emit: when it fires, how its severity and confidence are assigned, what evidence it carries, and what it explicitly cannot tell you.

Implementation reference: `lib/analysis/signals.ts` (`deriveSignals`). Signals are independent of the [CLOAK Index](08-cloak-index.md): the Index aggregates seven numeric components, while signals are human-readable findings with attached evidence. The two share some thresholds (`THRESHOLDS` in `lib/analysis/score.ts`) but neither is computed from the other.

## Contents

- [Data model](#data-model)
- [Inputs](#inputs)
- [General rules](#general-rules)
- [Signal specifications](#signal-specifications)
  - [holdings-visible](#1-holdings-visible)
  - [repeated-{address}](#2-repeated-address)
  - [concentration-top](#3-concentration-top)
  - [recurring-{to}-{amount}](#4-recurring-to-amount)
  - [temporal-peak](#5-temporal-peak)
  - [program-{id}](#6-program-id)
  - [trading-public](#7-trading-public)
  - [label-self](#8-label-self)
  - [label-{address}](#9-label-address)
  - [funding-earliest](#10-funding-earliest)
  - [label-coverage](#11-label-coverage)
- [Ordering](#ordering)
- [Summary table](#summary-table)
- [Evidence references and explorer links](#evidence-references-and-explorer-links)
- [Worked example: the demo report](#worked-example-the-demo-report)
- [Test coverage](#test-coverage)

## Data model

Every signal is an `ExposureSignal` (see [`../reference/types.ts`](../reference/types.ts) and [`../reference/ScanReport.schema.json`](../reference/ScanReport.schema.json)).

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Stable identifier. Either a fixed string (`holdings-visible`) or a pattern with an embedded address/amount (`repeated-{address}`). Unique within a report. |
| `category` | `SignalCategory` | One of `holdings`, `repeated-counterparty`, `concentration`, `temporal`, `program`, `trading`, `labeling`, `funding`, `recurring`. |
| `title` | `string` | One-line headline. |
| `severity` | `'low' \| 'medium' \| 'high'` | How much the finding contributes to linkability, per the rules below. |
| `confidence` | `'low' \| 'medium' \| 'high'` | How reliable the finding is given the data window and its source. |
| `observation` | `string` | The measured fact, with numbers, in plain language. |
| `evidence` | `EvidenceRef[]` | The records the finding was derived from. |
| `limitation` | `string` | What the finding does not establish. Always present. |
| `recommendation` | `string` | Educational guidance (shown under Privacy Mode in the terminal). Not an instruction to transact. |
| `subjects` | `string[]` | Addresses or mints the signal is about (counterparties, mints). May be empty. |

`EvidenceRef`:

| Field | Type | Description |
|---|---|---|
| `kind` | `'tx' \| 'account' \| 'token'` | `tx` = transaction signature, `account` = an address, `token` = a mint. |
| `ref` | `string` | The signature, address or mint. |
| `timestamp` | `number \| null` | Unix seconds for `tx` evidence; `null` for snapshots. |
| `note` | `string` | Why this record is attached. |

## Inputs

`deriveSignals` receives a `SignalInput`:

```ts
export interface SignalInput {
  wallet: string
  txs: NormalizedTx[]          // deduplicated, newest first
  balances: WalletBalances
  counterparties: Counterparty[] // sorted by txCount desc (see 05)
  dna: DnaProfile
  coverage: Coverage
  labelSupport: LabelSupport
  walletLabel: PublicLabel | null
}
```

`counterparties` is the full aggregated list (not the 100-entry slice stored in the report), ordered by `txCount` descending, then total SOL moved descending, then address ([05 — Counterparty analysis](05-counterparty-analysis.md)). `dna` is the Wallet DNA profile ([06 — Wallet DNA](06-wallet-dna.md)).

## General rules

- **Deterministic.** The same input always produces the same signals in the same order.
- **Evidence is bounded.** `MAX_EVIDENCE = 6`. Signals that reuse a counterparty's stored evidence are further bounded by `EVIDENCE_PER_COUNTERPARTY = 5` (`lib/analysis/counterparties.ts`), so they carry at most 5 references.
- **Every signal has a limitation.** The limitation text is fixed per signal (quoted below) except where it embeds the coverage window note.
- **Constants used below.** `DUST_LAMPORTS = 10_000`; `THRESHOLDS.repeatedMinTx = 3`; `THRESHOLDS.concentrationMinInteractions = 5`.
- **Window note.** Some text embeds `windowNote(coverage)`:
  - if `coverage.limitReached`: `Based on the most recent {txCount} transactions only; older history was not analyzed.`
  - otherwise: `Based on the full available history ({txCount} transactions).`
- **Short addresses.** Titles and observations abbreviate addresses with `shortAddress` (first 4 + `…` + last 4 characters), or use the counterparty's public label name when one exists.

## Signal specifications

### 1. holdings-visible

| Property | Value |
|---|---|
| id | `holdings-visible` |
| category | `holdings` |
| Max instances | 1 |
| Trigger | `balances.lamports > 0` **or** `balances.holdings.length > 0` |
| Severity | `high` if `holdings.length ≥ 15` or `pricedUsd ≥ 10,000`; else `medium` if `holdings.length ≥ 5` or `pricedUsd ≥ 1,000`; else `low` |
| Confidence | always `high` |
| Evidence | 1 `account` (the wallet; note `Balance snapshot at {fetchedAt}`) + up to 4 `token` refs (the first 4 holdings; note `{amount} {symbol}`). Max 5. |
| Subjects | Mints of the first 10 holdings |

`holdings.length` counts fungible tokens and NFTs together. `pricedUsd = (solUsd ?? 0) + Σ usdValue` over **fungible** holdings only; NFTs never contribute a USD value. The observation mentions provider-priced value only when `solUsd !== null` or at least one fungible holding has a `usdValue`.

Limitation:

> A snapshot, not a history. USD values come from the provider and are missing for unpriced tokens. Holdings in other wallets controlled by the same person are not visible here.

Recommendation:

> Keep long-term holdings in an address you never use for payments, mints or social activity, so a single payment does not reveal your full balance.

### 2. repeated-{address}

| Property | Value |
|---|---|
| id | `repeated-{counterparty address}` |
| category | `repeated-counterparty` |
| Max instances | 3 |
| Trigger | Counterparty `txCount ≥ 3` (`THRESHOLDS.repeatedMinTx`). Only the first 3 qualifying counterparties in the sorted list are emitted. |
| Severity | `high` if `txCount ≥ 10`; `medium` if `txCount ≥ 5`; else `low` |
| Confidence | always `high` |
| Evidence | The counterparty's stored `tx` evidence, sliced to 6. Because counterparties store at most 5, max is 5 in practice. |
| Subjects | `[address]` |

The observation states the direction: `in both directions` (both `inCount` and `outCount` > 0), `inbound only` or `outbound only`, plus SOL received, SOL sent (4 decimals) and token transfer count.

The Index's "Repeated counterparties" component counts **all** counterparties with `txCount ≥ 3`; this signal reports only the top 3.

Limitation:

> Shows that the two addresses transacted, not who controls either one or why. The counterparty may be a service, a contract-owned account or another wallet of the same person.

Recommendation:

> Recurring transfers make two addresses easy to cluster. Use a fresh receiving address for relationships you do not want linked to this wallet.

### 3. concentration-top

| Property | Value |
|---|---|
| id | `concentration-top` |
| category | `concentration` |
| Max instances | 1 |
| Trigger | `interactions ≥ 5` (`THRESHOLDS.concentrationMinInteractions`) **and** `share ≥ 0.4` |
| Severity | `high` if `share ≥ 0.6`; else `medium` |
| Confidence | `high` if `interactions ≥ 15`; else `medium` |
| Evidence | The top counterparty's stored `tx` evidence, sliced to 6 (max 5 in practice). |
| Subjects | `[top counterparty address]` |

Definitions: `interactions = Σ counterparty.txCount` over all counterparties (a transaction with legs to two counterparties counts once for each). `share = counterparties[0].txCount / interactions`. The observation also states `dna.top3CounterpartyShare` as a percentage.

Limitation (template):

> Computed over transfer interactions only; swaps and program calls are excluded. {windowNote}

Recommendation:

> A dominant counterparty is a strong clustering anchor. Separate routine flows (salary, exchange, savings) into different addresses.

### 4. recurring-{to}-{amount}

| Property | Value |
|---|---|
| id | `recurring-{recipient address}-{amount}`, where `{amount}` is SOL to 3 decimals, e.g. `recurring-HVqm…YwrN-1.500` (full address in the real id) |
| category | `recurring` |
| Max instances | 2 |
| Trigger | A (recipient, amount) group with **≥ 3** transactions |
| Severity | `medium` if the group has `≥ 6` transactions; else `low` |
| Confidence | always `high` |
| Evidence | Up to 6 `tx` refs from the group (note `{amount} SOL sent`). Max 6. |
| Subjects | `[recipient]` |

Grouping procedure:

1. Consider only transactions with `success === true` whose `kind` is not `swap` or `liquidity`.
2. For each native move with `from === wallet`, a non-null `to` that is not the wallet, and `lamports ≥ DUST_LAMPORTS × 100` (1,000,000 lamports = 0.001 SOL):
3. Key the move by `{to}|{(lamports / 1e9).toFixed(3)}` — the recipient plus the amount rounded to 0.001 SOL.
4. A transaction is added to a group at most once.
5. Keep groups with ≥ 3 transactions, sort by group size descending then key ascending, and emit the first 2.

Unlike counterparty aggregation, this grouping does not filter out program-id recipients.

Limitation:

> Amounts are matched to 0.001 SOL. A matching amount does not prove the payments share a purpose.

Recommendation:

> Vary amounts and the sending address for recurring payments you do not want to fingerprint this wallet.

### 5. temporal-peak

| Property | Value |
|---|---|
| id | `temporal-peak` |
| category | `temporal` |
| Max instances | 1 |
| Trigger | `timed ≥ 15` **and** `dna.peakWindowStartHour !== null` **and** `dna.peakWindowShare ≥ 0.5` |
| Severity | `high` if `peakWindowShare ≥ 0.7`; else `medium` |
| Confidence | `high` if `timed ≥ 40`; else `medium` |
| Evidence | Up to 6 `tx` refs whose UTC hour falls inside the peak window (note `Inside peak window`), in input order (newest first). Max 6. |
| Subjects | `[]` |

`timed` is the number of transactions with a non-null timestamp, **including failed transactions** (the Wallet DNA hourly histogram also includes failed transactions). The peak window is the busiest contiguous 4-hour UTC window, wrapping midnight ([06 — Wallet DNA](06-wallet-dna.md)); the observation renders it as `HH:00–HH:00 UTC` and states that evenly spread activity would put about 17% (4/24) in any 4-hour window.

Limitation:

> This does not reveal a location or time zone. Bots, schedulers and shared wallets produce rhythms too. It does make the activity pattern comparable across wallets.

Recommendation:

> Patterns in timing can link wallets that share an owner. Avoid operating several wallets in the same short sessions.

### 6. program-{id}

| Property | Value |
|---|---|
| id | `program-{program id}` |
| category | `program` |
| Max instances | 1 |
| Trigger | `successCount ≥ 10` **and** the top program (`dna.programs[0]`) has `share ≥ 0.4` |
| Severity | `medium` if `share ≥ 0.7`; else `low` |
| Confidence | always `high` |
| Evidence | Up to 6 successful `tx` refs that invoke the program (note `Invokes {name}`). Max 6. |
| Subjects | `[program id]` |

`successCount` counts all successful transactions (timestamped or not). `dna.programs` excludes infrastructure ("plumbing") programs — System, SPL Token, Token-2022, Associated Token Account, Compute Budget and both Memo programs — and is sorted by `txCount` descending, then id. `share = program.txCount / successful transactions`.

Limitation:

> Program usage is public for every user of that program; on its own it identifies a habit, not a person.

Recommendation:

> Habits are a fingerprint. If this wallet should stay unlinked from another, avoid identical app routines across both.

### 7. trading-public

| Property | Value |
|---|---|
| id | `trading-public` |
| category | `trading` |
| Max instances | 1 |
| Trigger | `dna.trading.swapCount ≥ 3` |
| Severity | `high` if `swapCount ≥ 25`; `medium` if `swapCount ≥ 8`; else `low` |
| Confidence | always `high` |
| Evidence | Up to 6 `tx` refs with `kind === 'swap'` (note = the transaction description, or `Swap`). Max 6. |
| Subjects | `[]` |

`swapCount` counts successful swaps (failed transactions are classified `failed`, not `swap`). The observation names `dna.trading.venues[0].protocol` when available; note that the venue list counts both swap and liquidity transactions by protocol.

Limitation:

> Swap amounts are as reported by the venue. Profit and loss cannot be determined from a partial window.

Recommendation:

> Trade from a dedicated address funded through a path that is not tied to your main wallet.

### 8. label-self

| Property | Value |
|---|---|
| id | `label-self` |
| category | `labeling` |
| Max instances | 1 |
| Trigger | `walletLabel !== null` (the analyzed address itself has a public label) |
| Severity | always `high` |
| Confidence | always `medium` |
| Evidence | 1 `account` ref (the wallet; note `Label source: {source}`). |
| Subjects | `[wallet]` |

Limitation:

> Labels are third-party assertions. CLOAK does not verify them and does not infer identities of its own.

Recommendation:

> A labeled address is effectively attributed. Treat everything it touches as linkable to that label.

### 9. label-{address}

| Property | Value |
|---|---|
| id | `label-{counterparty address}` |
| category | `labeling` |
| Max instances | 4 |
| Trigger | Counterparty has a non-null `label`. The first 4 labeled counterparties in sorted order are emitted. |
| Severity | `medium` if the counterparty is an exchange; else `low` |
| Confidence | always `medium` |
| Evidence | The counterparty's stored `tx` evidence, sliced to 6 (max 5 in practice). |
| Subjects | `[address]` |

Exchange detection:

```ts
const isExchange = /exchange|cex/i.test(`${c.label!.category ?? ''} ${c.label!.type ?? ''}`)
```

For exchanges the observation appends: `Exchanges hold off-chain account records that can be matched to deposit and withdrawal transactions.`

In live mode only the wallet and the first 99 counterparties are submitted for label lookup (`lib/server/scan.ts`), so counterparties further down the list can never carry a label.

Limitation:

> The label describes the counterparty, not this wallet. Labels are provider assertions and may be incomplete or out of date.

Recommendation (exchange):

> Withdraw from exchanges to an intermediate address rather than directly to wallets you want kept separate.

Recommendation (other):

> Be deliberate about which wallets interact with publicly known entities.

### 10. funding-earliest

| Property | Value |
|---|---|
| id | `funding-earliest` |
| category | `funding` |
| Max instances | 1 |
| Trigger | `earliestInboundSol(txs, wallet)` returns a result |
| Severity | full window: `medium`; partial window: `low` |
| Confidence | full window: `high`; partial window: `low` |
| Title | full window: `First funding source is visible`; partial window: `Earliest observed funding source` |
| Evidence | 1 `tx` ref (note `Earliest inbound SOL transfer`). |
| Subjects | `[funder address]` |

"Full window" means `coverage.limitReached === false` (the provider returned the start of history before the transaction cap). `earliestInboundSol` sorts successful, timestamped transactions oldest first (tiebreak slot, then signature), skips `swap` and `liquidity`, and returns the first native move into the wallet from another non-program address with `lamports ≥ DUST_LAMPORTS` (10,000).

The observation ends with `, the earliest inbound SOL in the wallet history` (full) or `, the earliest inbound SOL inside the analyzed window` (partial).

Limitation (full window):

> Funding links two addresses but does not show who controls the funder.

Limitation (partial window):

> Older history was not analyzed, so the true first funder may be different.

Recommendation:

> The address that funds a new wallet is often the strongest link back to its owner. Fund new wallets from a source you are comfortable being associated with.

### 11. label-coverage

| Property | Value |
|---|---|
| id | `label-coverage` |
| category | `labeling` |
| Max instances | 1 |
| Trigger | `labelSupport === 'unsupported-plan'` or `labelSupport === 'unavailable'` |
| Severity | always `low` |
| Confidence | always `low` |
| Evidence | 1 `account` ref (the wallet; note `Label lookup skipped`). |
| Subjects | `[]` |

Observation:

- `unsupported-plan`: `Identity labeling requires a paid provider plan, so counterparties were not checked against public labels.`
- `unavailable`: `The label service did not respond, so counterparties were not checked against public labels.`

This signal never fires in demo mode (`labelSupport` is `demo`). It states a gap in coverage rather than an exposure.

Limitation:

> Absence of label findings here means "not checked", not "no labels exist".

Recommendation:

> Treat this report as a lower bound on exposure.

## Ordering

The output array is sorted by severity rank, then by `id`:

```ts
const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
// ...
return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id))
```

All `high` signals come first, then `medium`, then `low`. Within a severity, signals are ordered by `String.prototype.localeCompare` on the id. Confidence does not affect ordering.

## Summary table

| # | id | Category | Trigger | Severity | Confidence | Evidence (max) | Max instances |
|---|---|---|---|---|---|---|---|
| 1 | `holdings-visible` | holdings | lamports > 0 or any holding | high ≥15 holdings or ≥ $10,000; medium ≥5 or ≥ $1,000; else low | high | 1 account + 4 token (5) | 1 |
| 2 | `repeated-{address}` | repeated-counterparty | txCount ≥ 3, top 3 | high ≥10; medium ≥5; else low | high | tx (5) | 3 |
| 3 | `concentration-top` | concentration | interactions ≥ 5 and top share ≥ 0.4 | high ≥0.6; else medium | high if interactions ≥15; else medium | tx (5) | 1 |
| 4 | `recurring-{to}-{amount}` | recurring | ≥3 outbound SOL tx ≥ 0.001 SOL with same recipient + amount (0.001 SOL), top 2 | medium ≥6; else low | high | tx (6) | 2 |
| 5 | `temporal-peak` | temporal | ≥15 timed tx and peak 4h share ≥ 0.5 | high ≥0.7; else medium | high if timed ≥40; else medium | tx (6) | 1 |
| 6 | `program-{id}` | program | ≥10 successful tx and top program share ≥ 0.4 | medium ≥0.7; else low | high | tx (6) | 1 |
| 7 | `trading-public` | trading | ≥3 swaps | high ≥25; medium ≥8; else low | high | tx (6) | 1 |
| 8 | `label-self` | labeling | wallet has a public label | high | medium | 1 account | 1 |
| 9 | `label-{address}` | labeling | labeled counterparty, first 4 | medium if exchange; else low | medium | tx (5) | 4 |
| 10 | `funding-earliest` | funding | earliest inbound SOL found | full: medium; partial: low | full: high; partial: low | 1 tx | 1 |
| 11 | `label-coverage` | labeling | labelSupport unsupported-plan or unavailable | low | low | 1 account | 1 |

The theoretical maximum is 17 signals per report. In practice `label-self` and `label-{address}` require labels, which normally exist only when `labelSupport` is `supported` or `demo`. One edge case exists in live mode: the identity client returns labels already held in its in-process cache before the batch request, so if that request then fails (`unavailable`), cached labels can still produce `label-self` / `label-{address}` alongside `label-coverage` (`lib/server/helius.ts`, `fetchLabels`).

## Evidence references and explorer links

Evidence references are raw identifiers; CLOAK does not store URLs in the report. The terminal (`components/app/ui.tsx`, `EvidenceList`) builds links at render time:

| `kind` | Live mode link | Demo mode |
|---|---|---|
| `tx` | `https://solscan.io/tx/{ref}` | No link; rendered as `demo · no record` |
| `account` | `https://solscan.io/account/{ref}` | No link |
| `token` | `https://solscan.io/token/{ref}` | No link |

Demo references are fictional (see [14 — Demo dataset](14-demo-dataset.md)), so linking them to an explorer would point at records that do not exist. The `EvidenceList` component also renders at most 6 references (`max = 6`), matching `MAX_EVIDENCE`. Every reference can be copied regardless of mode.

To verify a live finding independently, look up each `tx` reference on any Solana explorer or via `getTransaction` on an RPC node.

## Worked example: the demo report

[`../examples/report.demo.json`](../examples/report.demo.json) (fictional wallet `CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11`, 96 transactions, full window, `labelSupport: "demo"`) contains 9 signals, in emitted order:

| # | id | Severity | Confidence | Evidence | Why it fired |
|---|---|---|---|---|---|
| 1 | `repeated-7n6sBYjn3JUm1yoLmgWNGKDXatDDPf814nrWHHZ3Lktp` | high | high | 5 tx | 13 transactions (≥ 10), both directions |
| 2 | `repeated-HVqm5zhFip2XLKaibdbAQD84hRX9SKLm7DvYz577YwrN` | high | high | 5 tx | 11 transactions (≥ 10), outbound only |
| 3 | `temporal-peak` | high | high | 6 tx | 80% (0.802) of activity in 11:00–15:00 UTC (≥ 0.7); 96 timed tx (≥ 40) |
| 4 | `trading-public` | high | high | 6 tx | 29 swaps (≥ 25) across 4 tokens, mostly via jupiter |
| 5 | `funding-earliest` | medium | high | 1 tx | 25.0000 SOL from 5XuR…rh9K on 2026-07-18; full window |
| 6 | `holdings-visible` | medium | high | 1 account + 4 token | 6 holdings (≥ 5); roughly $8,246 priced (< $10,000) |
| 7 | `label-5XuRMmAxmLo64UhyQF4jNc7sNVUCHDSwehBy5Wqvrh9K` | medium | medium | 5 tx | Labeled "Demo Exchange (fictional)", category "Centralized Exchange" matches `/exchange/i` |
| 8 | `recurring-HVqm5zhFip2XLKaibdbAQD84hRX9SKLm7DvYz577YwrN-1.500` | medium | high | 6 tx | 11 outbound transfers of 1.500 SOL (≥ 6) |
| 9 | `repeated-5XuRMmAxmLo64UhyQF4jNc7sNVUCHDSwehBy5Wqvrh9K` | medium | high | 5 tx | 7 transactions (≥ 5), both directions |

Signals that did **not** fire, and why:

- `concentration-top`: the top counterparty holds 13 of 56 interactions (23%), below 0.4.
- `program-{id}`: the top non-infrastructure program (Jupiter Aggregator v6) appears in 29 of 93 successful transactions (31%), below 0.4.
- `label-self`: the demo wallet itself carries no label.
- `label-coverage`: `labelSupport` is `demo`.
- A second `recurring-*` group: no other (recipient, amount) pair reached 3 transactions.
- Only 3 `repeated-*` signals despite 6 counterparties with ≥ 3 transactions: the signal is capped at the top 3.

One signal as serialized:

```json
{
  "id": "funding-earliest",
  "category": "funding",
  "title": "First funding source is visible",
  "severity": "medium",
  "confidence": "high",
  "observation": "25.0000 SOL arrived from 5XuR…rh9K on 2026-07-18, the earliest inbound SOL in the wallet history.",
  "evidence": [
    {
      "kind": "tx",
      "ref": "66ePpi4zQnuv3BvJBPDgz3fKD882u1Cn2UPDhmVhm4Ctys3wUQB5sD24727FNR2X3tBitiLTUe7KyLUce813ZGDu",
      "timestamp": 1784410918,
      "note": "Earliest inbound SOL transfer"
    }
  ],
  "limitation": "Funding links two addresses but does not show who controls the funder.",
  "recommendation": "The address that funds a new wallet is often the strongest link back to its owner. Fund new wallets from a source you are comfortable being associated with.",
  "subjects": [
    "5XuRMmAxmLo64UhyQF4jNc7sNVUCHDSwehBy5Wqvrh9K"
  ]
}
```

## Test coverage

`tests/analysis.test.ts` (`describe('signals')`) asserts that:

- for a fixture with six identical 1.5 SOL outbound transfers, every signal carries at least one evidence reference and a limitation longer than 10 characters, a `recurring` signal is present, and `repeated-{address}` is emitted for the recipient;
- `funding-earliest` has `confidence: 'high'` on a full window and `'low'` when `limitReached` is true;
- `label-coverage` is emitted when `labelSupport` is `unsupported-plan`.

See also: [06 — Wallet DNA](06-wallet-dna.md) · [08 — CLOAK Index](08-cloak-index.md) · [05 — Counterparty analysis](05-counterparty-analysis.md) · [16 — Limitations](16-limitations.md)

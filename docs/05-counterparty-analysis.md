# Counterparty Analysis

A counterparty is an address that appeared on the other side of a SOL or token transfer leg with the analyzed wallet in a successful, non-venue transaction. This document specifies how transfer legs are extracted, which movements are excluded and why, how legs are aggregated into `Counterparty` records, and how the earliest visible funding source is detected.

Implementation reference: `lib/analysis/counterparties.ts`. Tests: `tests/analysis.test.ts` (suite `counterparties`).

## Contents

- [The Counterparty model](#the-counterparty-model)
- [Leg extraction](#leg-extraction)
- [Aggregation](#aggregation)
- [Labels](#labels)
- [Earliest inbound funding](#earliest-inbound-funding)
- [Worked example](#worked-example)
- [Complexity](#complexity)
- [Known gaps](#known-gaps)

## The Counterparty model

| Field | Type | Meaning |
|---|---|---|
| `address` | `string` | Counterparty address |
| `inCount` | `number` | Transactions with at least one leg from the counterparty to the wallet |
| `outCount` | `number` | Transactions with at least one leg from the wallet to the counterparty |
| `txCount` | `number` | Transactions in which the counterparty appeared on any transfer leg (not the number of legs) |
| `solIn` | `number` | Total SOL received from the counterparty, rounded to 9 decimals |
| `solOut` | `number` | Total SOL sent to the counterparty, rounded to 9 decimals |
| `tokenMoves` | `number` | Number of token legs (either direction) |
| `mints` | `string[]` | Distinct mints moved with the counterparty, sorted ascending |
| `firstSeen`, `lastSeen` | `number \| null` | Earliest and latest timestamp of a shared transaction (Unix seconds) |
| `label` | `PublicLabel \| null` | Provider (or demo) label, when one exists |
| `evidence` | `EvidenceRef[]` | Up to 5 transaction references |

Because a transaction can contain legs in both directions, `inCount + outCount` can exceed `txCount`.

## Leg extraction

`legsFor(tx, wallet)` returns the transfer legs between the wallet and other addresses in one normalized transaction.

```ts
// lib/analysis/counterparties.ts (trimmed)
export const DUST_LAMPORTS = 10_000
const VENUE_KINDS = new Set(['swap', 'liquidity'])

export function legsFor(tx: NormalizedTx, wallet: string): Leg[] {
  if (!tx.success || VENUE_KINDS.has(tx.kind)) return []
  const legs: Leg[] = []
  for (const m of tx.nativeMoves) {
    if (m.lamports < DUST_LAMPORTS) continue
    if (m.from === wallet && m.to && m.to !== wallet) legs.push({ counterparty: m.to, direction: 'out', sol: m.lamports / 1e9, mint: null })
    else if (m.to === wallet && m.from && m.from !== wallet) legs.push({ counterparty: m.from, direction: 'in', sol: m.lamports / 1e9, mint: null })
  }
  for (const m of tx.tokenMoves) {
    if (m.amount <= 0) continue
    if (m.from === wallet && m.to && m.to !== wallet) legs.push({ counterparty: m.to, direction: 'out', sol: 0, mint: m.mint })
    else if (m.to === wallet && m.from && m.from !== wallet) legs.push({ counterparty: m.from, direction: 'in', sol: 0, mint: m.mint })
  }
  return legs.filter((l) => !isProgramId(l.counterparty))
}
```

Exclusion rules, applied in this order:

| Rule | Excluded | Rationale |
|---|---|---|
| Failed transaction | All legs of a transaction with `success: false` | A failed transaction moved nothing except the fee; it is not a relationship. |
| Venue kinds | All legs of a transaction whose `kind` is `swap` or `liquidity` | The other side of a swap or liquidity leg is a pool, vault or router account, not someone the wallet chose to transact with. Counting it would make every DEX vault the wallet's top "counterparty". Swap activity is measured separately in Wallet DNA's trading block. |
| Native dust | Native moves below `DUST_LAMPORTS = 10,000` lamports (0.00001 SOL) | Sub-0.00001 SOL transfers are overwhelmingly dust and **address-poisoning** spam: an attacker sends a negligible amount from an address that visually resembles one of the wallet's real counterparties, hoping the victim later copies it from their history. Counting such transfers would invent relationships the owner never chose (and would let an attacker inflate the index). |
| Zero-amount tokens | Token moves with `amount <= 0` | Zero-value token transfers are a common poisoning vector and carry no value. |
| Self and unknown sides | Moves where the other side is the wallet itself, or `null` (mints, burns, unparsed accounts) | No second party is observable. |
| Known program addresses | Legs whose counterparty is one of the 19 known program ids (`isProgramId`, see [04-normalization-model.md](04-normalization-model.md#program-registry)) | Program ids are code, not participants. |

Each surviving leg has a `direction` (`in` when the counterparty sent to the wallet, `out` when the wallet sent to the counterparty), a SOL amount (`lamports / 1e9`, or 0 for token legs) and a `mint` (token legs only).

The demo dataset exercises two of these rules on purpose: a fictional poisoning address sends dust and must not appear as a counterparty, and the Jupiter vault on the other side of 29 swaps must not appear either. `tests/provider.test.ts` asserts both.

## Aggregation

`aggregateCounterparties(txs, wallet, labels)` folds legs into one record per counterparty.

```ts
// per transaction (trimmed)
const legs = legsFor(tx, wallet)
const perTx = new Map<string, Set<'in' | 'out'>>()
for (const leg of legs) {
  // create the record on first sight, label taken from `labels`
  if (leg.direction === 'in') cp.solIn += leg.sol
  else cp.solOut += leg.sol
  if (leg.mint) { cp.tokenMoves += 1; cp._mints.add(leg.mint) }
  const dirs = perTx.get(leg.counterparty) ?? new Set() // directions seen in this tx
  dirs.add(leg.direction)
  perTx.set(leg.counterparty, dirs)
}
for (const [address, dirs] of perTx) {
  cp.txCount += 1
  if (dirs.has('in')) cp.inCount += 1
  if (dirs.has('out')) cp.outCount += 1
  // firstSeen / lastSeen from tx.timestamp (skipped when null)
  if (cp.evidence.length < EVIDENCE_PER_COUNTERPARTY) {
    const dir = dirs.size === 2 ? 'both directions' : dirs.has('in') ? 'received from' : 'sent to'
    cp.evidence.push({ kind: 'tx', ref: tx.signature, timestamp: tx.timestamp, note: `Transfer ${dir} counterparty` })
  }
}
```

### Per-transaction counting

- **SOL sums** and **`tokenMoves`** accumulate **per leg**: two SOL legs to the same counterparty in one transaction add both amounts; three token legs add 3 to `tokenMoves`.
- **`txCount`, `inCount`, `outCount`** accumulate **per transaction**: a transaction contributes at most 1 to each, however many legs it contains. This prevents a single batched transaction from looking like a long relationship. (Test: "counts transactions, not legs, and tracks direction".)
- **`firstSeen` / `lastSeen`** are the min and max `timestamp` of shared transactions; transactions without a timestamp do not affect them.

### Evidence

The first 5 shared transactions in input order become `evidence` (`EVIDENCE_PER_COUNTERPARTY = 5`). Scans supply transactions newest first, so evidence lists the 5 most recent shared transactions. The `note` is one of:

| Directions in that transaction | `note` |
|---|---|
| Wallet sent only | `Transfer sent to counterparty` |
| Wallet received only | `Transfer received from counterparty` |
| Both | `Transfer both directions counterparty` |

### Ordering and rounding

Records are returned sorted by:

1. `txCount` descending,
2. total SOL (`solIn + solOut`) descending,
3. `address` ascending (`localeCompare`).

The final tiebreak makes the order independent of input order (test: "orders deterministically on ties"). `solIn` and `solOut` are rounded to 9 decimal places (`Math.round(n · 10^9) / 10^9`, lamport precision) to remove floating-point accumulation noise; `mints` is sorted ascending.

### Use in the report

- The full list feeds Wallet DNA (HHI, top-3 share), Exposure Signals and the CLOAK Index.
- The report stores the first 100 (`MAX_COUNTERPARTIES_IN_REPORT`) in `counterparties` and the full count in `counterpartyTotal`.
- The first 40 become first-hop Trace Map nodes ([09-trace-map.md](09-trace-map.md)).

## Labels

`aggregateCounterparties` attaches `labels.get(address) ?? null` when it creates each record. A live scan runs it in two steps:

1. Aggregate with an empty label map, to rank counterparties.
2. Look up public labels for the wallet plus the **top 99** ranked counterparties (one Wallet API batch of at most 100 addresses; see [03-data-sources-and-ingestion.md](03-data-sources-and-ingestion.md#wallet-api-public-labels)), then re-attach `label` to every record.

Counterparties ranked below 99 are never label-checked. Labels change neither counting nor ordering. In demo mode the labels come from the fictional dataset (`source: 'demo'`).

## Earliest inbound funding

`earliestInboundSol(txs, wallet)` finds the earliest observed inbound SOL transfer, which is often the strongest public link between a new wallet and whoever funded it. It drives the `funding-earliest` signal ([07-exposure-signals.md](07-exposure-signals.md)).

```ts
// lib/analysis/counterparties.ts
const sorted = txs
  .filter((t) => t.success && t.timestamp !== null)
  .sort((a, b) => a.timestamp! - b.timestamp! || a.slot - b.slot || a.signature.localeCompare(b.signature))
for (const tx of sorted) {
  if (tx.kind === 'swap' || tx.kind === 'liquidity') continue
  const m = tx.nativeMoves.find((n) => n.to === wallet && n.from && n.from !== wallet && n.lamports >= DUST_LAMPORTS && !isProgramId(n.from))
  if (m) return { tx, from: m.from!, sol: m.lamports / 1e9 }
}
return null
```

Rules:

- Only **successful, timestamped** transactions are considered, in **ascending** order (timestamp, then slot, then signature).
- Swap and liquidity transactions are skipped (SOL out of a pool is not funding).
- The first native move **into** the wallet from a non-null, non-self, non-program sender of at least 10,000 lamports wins. Within a transaction, the first qualifying move in provider order is used.
- Only native SOL counts; a wallet funded purely with tokens has no detected funder.
- The result is the earliest funder **inside the analyzed window**. When `coverage.limitReached` is `true`, older history was not fetched and the true first funder may differ; the signal is then emitted with lower severity and `low` confidence (test: "downgrades funding confidence when the window is partial").

## Worked example

Wallet `W`; counterparties `A`, `B`; a swap vault `V`; a poisoning address `C`. Times `t1 < t2 < t3 < t4`. All transactions succeed.

| Tx | Time | `kind` | Native moves | Token moves |
|---|---|---|---|---|
| tx1 | t1 | `transfer` | `W → A` 1,000,000,000 lamports (1.0 SOL) | — |
| tx2 | t2 | `transfer` | `A → W` 500,000,000 (0.5 SOL); `W → A` 200,000,000 (0.2 SOL) | — |
| tx3 | t3 | `swap` | — | `W → V` 25 USDC; `V → W` 0.17 wSOL |
| tx4 | t4 | `transfer` | `W → B` 2,000,000,000 (2.0 SOL); `C → W` 5,000 lamports | `W → B` 10 USDC |

Leg extraction:

- tx1: one `out` leg to `A`, 1.0 SOL.
- tx2: one `in` leg from `A` (0.5 SOL) and one `out` leg to `A` (0.2 SOL).
- tx3: none (venue kind `swap`). `V` never becomes a counterparty.
- tx4: one `out` SOL leg to `B` (2.0 SOL), one `out` token leg to `B` (USDC). The 5,000-lamport move from `C` is below `DUST_LAMPORTS` and is dropped.

Result (transactions supplied newest first, as in a scan):

| `address` | `txCount` | `inCount` | `outCount` | `solIn` | `solOut` | `tokenMoves` | `mints` | `firstSeen` | `lastSeen` | `evidence` |
|---|---|---|---|---|---|---|---|---|---|---|
| `A` | 2 | 1 | 2 | 0.5 | 1.2 | 0 | `[]` | t1 | t2 | tx2 "Transfer both directions counterparty", tx1 "Transfer sent to counterparty" |
| `B` | 1 | 0 | 1 | 0 | 2.0 | 1 | `[USDC mint]` | t4 | t4 | tx4 "Transfer sent to counterparty" |

`A` ranks first on `txCount`. `earliestInboundSol` returns `{ tx: tx2, from: A, sol: 0.5 }`: tx1 has no inbound move, and the dust from `C` in tx4 would not qualify anyway.

In the real demo report ([`examples/report.demo.json`](../examples/report.demo.json)) the top counterparty is `7n6sBYjn3JUm1yoLmgWNGKDXatDDPf814nrWHHZ3Lktp` with `txCount` 13 (`inCount` 4, `outCount` 9), `solIn` 4.965, `solOut` 11.868; 20 counterparties in total, of which one carries a (fictional) label, "Demo Exchange (fictional)".

## Complexity

For `n` transactions with at most `L` moves each and `C` resulting counterparties:

| Step | Time | Space |
|---|---|---|
| Leg extraction | O(n · L) | O(L) per transaction |
| Aggregation | O(n · L) expected (hash map lookups) | O(C + total distinct mints) |
| Sort | O(C log C) | O(C) |
| `earliestInboundSol` | O(n log n) sort + O(n · L) scan | O(n) |

With the server cap of 500 transactions, aggregation is negligible compared with provider latency.

## Known gaps

- **Unlisted program accounts.** Only the 19 known program ids are filtered. A program-owned account (escrow, vault, PDA) on the other side of a transfer in a `program` or `transfer` transaction appears as a counterparty.
- **Token dust.** Zero-amount token moves are dropped, but small non-zero token amounts are not; token-based poisoning with tiny non-zero amounts can create a counterparty.
- **Owner resolution.** Token legs use the provider's owner accounts (`fromUserAccount`/`toUserAccount`). If the provider cannot resolve an owner, the side is `null` and no leg is created.
- **Window.** Only transactions inside the fetched window are counted ([03-data-sources-and-ingestion.md](03-data-sources-and-ingestion.md#window-size)).

A full list: [16-limitations.md](16-limitations.md).

See also: [04-normalization-model.md](04-normalization-model.md) · [06-wallet-dna.md](06-wallet-dna.md) · [07-exposure-signals.md](07-exposure-signals.md) · [09-trace-map.md](09-trace-map.md)

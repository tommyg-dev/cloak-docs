# Wallet DNA

Wallet DNA is the behavioral profile CLOAK derives from an address's normalized transactions and counterparties: when it is active, what kinds of activity it performs, which programs it uses, how concentrated its relationships are, and how it trades. Every metric is a deterministic function of the analyzed window, computed in UTC.

Implementation reference: `lib/analysis/dna.ts` (`buildDna`, `peakWindow`, `hhi`). Type: `DnaProfile` in [`reference/types.ts`](../reference/types.ts). Tests: `tests/analysis.test.ts` (suite `dna`).

## Contents

- [Inputs and scope](#inputs-and-scope)
- [Time in UTC, and no location inference](#time-in-utc-and-no-location-inference)
- [Metric reference](#metric-reference)
- [Temporal distributions](#temporal-distributions)
- [Daily series](#daily-series)
- [Activity and protocol mix](#activity-and-protocol-mix)
- [Program footprint](#program-footprint)
- [Median inter-transaction gap](#median-inter-transaction-gap)
- [Peak 4-hour window](#peak-4-hour-window)
- [Counterparty concentration: HHI and top-3 share](#counterparty-concentration-hhi-and-top-3-share)
- [Trading block](#trading-block)
- [Transfers per week](#transfers-per-week)
- [Worked example: the demo wallet](#worked-example-the-demo-wallet)

## Inputs and scope

```ts
buildDna(txs: NormalizedTx[], counterparties: Counterparty[]): DnaProfile
```

`txs` is the deduplicated, newest-first history ([04-normalization-model.md](04-normalization-model.md)); `counterparties` is the **full** aggregated list ([05-counterparty-analysis.md](05-counterparty-analysis.md)), not the 100 stored in the report.

Each metric uses one of three transaction populations:

| Population | Used by |
|---|---|
| All transactions | `kindMix` |
| All transactions with a non-null `timestamp`, including failed ones | `heatmap`, `hourly`, `weekday`, `daily`, `medianGapSeconds`, `peakWindowShare`, `peakWindowStartHour`, the span used by `transfersPerWeek` |
| Successful transactions only | `programs`, `protocolMix`, `trading`, the transfer count used by `transfersPerWeek` |

Failed transactions are included in timing because a failed attempt still reveals when the owner was active.

## Time in UTC, and no location inference

All timestamps are Solana block times (Unix seconds) and are bucketed with `getUTCDay()` / `getUTCHours()`. Dates are UTC calendar dates (`toISOString().slice(0, 10)`).

CLOAK does not convert to a local time zone and does not infer a time zone, country or city. A concentrated activity window is consistent with many possible locations and schedules (a shift worker, a bot, an automated payout), and presenting a guess as a finding would be fabrication. Signals and the CLOAK Index therefore describe rhythm only in UTC ("80% of activity in the busiest 4h UTC window"). The Terminal also renders these charts in UTC.

## Metric reference

| Field | Type | Definition |
|---|---|---|
| `heatmap` | `number[7][24]` | Count of timestamped transactions per `[dayOfWeek][hourUTC]`, day 0 = Sunday |
| `hourly` | `number[24]` | Count per UTC hour |
| `weekday` | `number[7]` | Count per UTC weekday, 0 = Sunday |
| `daily` | `{ date, count }[]` | Count per UTC date across the window, gap-filled with zeros, at most 366 points (most recent) |
| `kindMix` | `{ kind, count }[]` | Count per `ActivityKind`, all transactions |
| `protocolMix` | `{ protocol, count }[]` | Successful swaps per venue (`"unattributed"` when the venue is unknown) plus successful liquidity transactions with a known protocol |
| `programs` | `ProgramUse[]` | Per non-infrastructure program: successful transactions using it and their share of all successful transactions |
| `medianGapSeconds` | `number \| null` | Median of consecutive timestamp differences |
| `peakWindowShare` | `number` (0..1) | Share of timestamped transactions in the busiest contiguous 4-hour UTC window |
| `peakWindowStartHour` | `number \| null` | Start hour (UTC) of that window |
| `counterpartyHhi` | `number` (0..1) | Herfindahl-Hirschman index over counterparty `txCount`s |
| `top3CounterpartyShare` | `number` (0..1) | Share of counterparty interactions held by the 3 largest counterparties |
| `trading` | object | `swapCount`, `distinctMintsTraded`, `venues`, `topPairs` (≤ 6) |
| `transfersPerWeek` | `number \| null` | Successful `transfer`-kind transactions per 7 days; `null` when the span is under 1 day |

All `{ key, count }` lists are sorted by `count` descending, then key ascending.

## Temporal distributions

```ts
for (const tx of txs) {
  if (tx.timestamp !== null) {
    const d = new Date(tx.timestamp * 1000)
    const day = d.getUTCDay()
    const hour = d.getUTCHours()
    heatmap[day][hour] += 1
    hourly[hour] += 1
    weekday[day] += 1
  }
}
```

`hourly[h] = Σ_d heatmap[d][h]` and `weekday[d] = Σ_h heatmap[d][h]`. Each sums to the number of timestamped transactions. Test: a transaction at Sunday 15:30 UTC lands in `heatmap[0][15]`.

## Daily series

1. Count transactions per UTC date.
2. Walk from 00:00 UTC of the oldest transaction's date to the newest timestamp in 86,400,000 ms steps, emitting `{ date, count }` for every date, with `0` for dates without activity (gap-filling).
3. If the series exceeds `MAX_DAILY_POINTS = 366`, drop points from the front, keeping the most recent 366 days.

The series is empty when no transaction has a timestamp.

## Activity and protocol mix

- **`kindMix`** counts every transaction by `kind` (`transfer`, `swap`, `liquidity`, `account`, `program`, `failed`, `unknown`; see [classification](04-normalization-model.md#activity-classification)). Kinds with zero count are omitted.
- **`protocolMix`** counts, over successful transactions:
  - each `swap` under `tx.protocol ?? "unattributed"`;
  - each `liquidity` transaction under `tx.protocol`, only when the protocol is known.

## Program footprint

For every **successful** transaction, each program in `tx.programs` that is not an infrastructure program ([plumbing set](04-normalization-model.md#infrastructure-plumbing-programs)) adds 1 to that program's count. Since `tx.programs` is already distinct per transaction, the count is the number of successful transactions that invoked the program (top-level or inner).

$$\text{share}_p = \frac{\text{txCount}_p}{\text{number of successful transactions}}$$

Shares do not sum to 1: one transaction can invoke several programs. `name` is resolved with `programName(id, providerName)`. The list is sorted by `txCount` descending, then `id` ascending, and is not truncated. The CLOAK Index uses the number of entries as the "distinct non-infrastructure programs" indicator ([08-cloak-index.md](08-cloak-index.md)).

## Median inter-transaction gap

Sort the timestamps ascending, take consecutive differences $g_i = t_{i+1} - t_i$ (in seconds), and return the median: the middle element for an odd count, the mean of the two middle elements for an even count. With fewer than 2 timestamped transactions the result is `null`.

Bursts (several transactions in the same second) produce zero gaps and pull the median down. The median is used instead of the mean because a single long dormant period would dominate a mean.

## Peak 4-hour window

The busiest contiguous window of `PEAK_WINDOW_HOURS = 4` hours over the 24-slot `hourly` histogram, **wrapping midnight** (22:00–02:00 is a valid window).

```ts
// lib/analysis/dna.ts
export function peakWindow(hourly: number[], width = PEAK_WINDOW_HOURS): { start: number | null; share: number } {
  const total = hourly.reduce((a, b) => a + b, 0)
  if (!total) return { start: null, share: 0 }
  let best = -1
  let bestStart = 0
  for (let start = 0; start < 24; start++) {
    let sum = 0
    for (let k = 0; k < width; k++) sum += hourly[(start + k) % 24]
    if (sum > best) {
      best = sum
      bestStart = start
    }
  }
  return { start: bestStart, share: best / total }
}
```

$$\text{peakWindowShare} = \max_{s \in 0..23} \frac{\sum_{k=0}^{3} \text{hourly}[(s+k) \bmod 24]}{\sum_{h} \text{hourly}[h]}$$

- **Ties** resolve to the smallest start hour, because the comparison is strict (`>`).
- **Bounds.** For any distribution the share is at least 4/24 ≈ 0.167 (the uniform case) and at most 1.
- **Complexity.** 24 × 4 = 96 additions, constant time; building `hourly` is O(n).
- **No activity.** `start: null`, `share: 0`.

The test "finds the busiest 4h window, wrapping midnight" places 5 transactions at 23:00 and 5 at 00:00 (plus 2 at 12:00) and expects a share of 10/12 with a start between 20 and 23.

The CLOAK Index rescales this share so that uniform activity scores 0: `(share − 1/6) / (1 − 1/6)` ([08-cloak-index.md](08-cloak-index.md)).

## Counterparty concentration: HHI and top-3 share

Let $c_i$ be the `txCount` of counterparty $i$ and $T = \sum_i c_i$ the total counterparty interactions.

$$\text{HHI} = \sum_i \left(\frac{c_i}{T}\right)^2$$

```ts
export function hhi(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0)
  if (!total) return 0
  return counts.reduce((acc, c) => acc + (c / total) ** 2, 0)
}
```

Interpretation:

| HHI | Meaning |
|---|---|
| 1 | All interactions with a single counterparty |
| 1/N | Interactions spread evenly over N counterparties (four equal → 0.25) |
| → 0 | Very diffuse relationships |
| 0 | No counterparties (defined, not undefined) |

$1/\text{HHI}$ is the "effective number" of equally weighted counterparties.

**Top-3 share** is the sum of the three largest $c_i$ divided by $T$ (0 when $T = 0$). It is the CLOAK Index's concentration indicator, evaluated only with at least 5 interactions. HHI is reported in Wallet DNA as context and is not a CLOAK Index component.

Because $T$ sums per-counterparty transaction counts, a transaction with legs to two counterparties contributes to both.

## Trading block

Computed over successful transactions with `kind === 'swap'`:

| Field | Definition |
|---|---|
| `swapCount` | Number of successful swaps |
| `distinctMintsTraded` | Distinct mints appearing as `swap.inputMint` or `swap.outputMint` |
| `venues` | Same counts as `protocolMix` (swaps by venue, plus liquidity transactions with a known protocol) |
| `topPairs` | Swaps per directed pair `"{input symbol} → {output symbol}"`, counted only when both mints are known; sorted by count desc, pair asc; at most 6 |

Pair labels use `mintSymbol()` (wSOL, USDC, USDT, JUP, BONK, otherwise a shortened mint). Pairs are directed: `wSOL → USDC` and `USDC → wSOL` are separate entries. For multi-hop routes only the first swap summary's mints are known ([swap extraction](04-normalization-model.md#swap-and-protocol-extraction)).

## Transfers per week

```ts
transfersPerWeek: spanSeconds >= 86_400 ? (transferCount / spanSeconds) * 604_800 : null
```

- `transferCount`: successful transactions with `kind === 'transfer'`.
- `spanSeconds`: newest minus oldest timestamp over all timestamped transactions.
- Returned only when the span is at least one day; shorter windows would extrapolate a weekly rate from hours of data, so the value is `null`.

## Worked example: the demo wallet

Values from [`examples/report.demo.json`](../examples/report.demo.json) (96 transactions, 93 successful, window 2026-07-18T21:41:58Z to 2026-09-30T19:47:44Z).

**Hourly (UTC)**

| Hour | 0–2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | **11** | **12** | **13** | **14** | 15–16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Count | 0 | 2 | 1 | 1 | 1 | 0 | 1 | 1 | 1 | **22** | **26** | **14** | **15** | 0 | 2 | 2 | 1 | 3 | 2 | 1 | 0 |

**Weekday (UTC):** Sun 16, Mon 10, Tue 16, Wed 21, Thu 10, Fri 13, Sat 10.

**Peak window.** Starting at 11:00, the window 11:00–15:00 UTC holds 22 + 26 + 14 + 15 = 77 of 96 timestamped transactions:

$$\text{peakWindowShare} = 77 / 96 = 0.8021, \quad \text{peakWindowStartHour} = 11$$

Rescaled for the CLOAK Index: (0.8021 − 0.1667) / 0.8333 = 0.7625.

**Daily series.** 75 points, 2026-07-18 through 2026-09-30, including zero-activity days.

**Kind mix.** `transfer` 57, `swap` 29, `program` 7, `failed` 3.

**Programs** (share of 93 successful transactions):

| Program | `txCount` | `share` |
|---|---|---|
| Jupiter Aggregator v6 | 29 | 0.3118 |
| Marinade Finance | 4 | 0.0430 |
| Magic Eden v2 | 3 | 0.0323 |

**Median gap.** 73,228 s (about 20.3 hours).

**Concentration.** The 20 counterparties have `txCount`s 13, 11, 7, 5, 3, 3 and fourteen 1s, so $T = 56$.

$$\text{HHI} = \frac{13^2 + 11^2 + 7^2 + 5^2 + 3^2 + 3^2 + 14 \cdot 1^2}{56^2} = \frac{396}{3136} = 0.1263$$

Effective number of counterparties: 1 / 0.1263 ≈ 7.9.

$$\text{top3CounterpartyShare} = \frac{13 + 11 + 7}{56} = \frac{31}{56} = 0.5536$$

**Trading.** `swapCount` 29, `distinctMintsTraded` 4, `venues` = `[{ protocol: "jupiter", count: 29 }]`, `topPairs`: BONK → wSOL 6, USDC → wSOL 6, wSOL → JUP 6, wSOL → USDC 6, wSOL → BONK 5 (only 5 distinct pairs occur).

**Transfers per week.** 57 transfers over 6,386,746 s:

$$57 / 6{,}386{,}746 \times 604{,}800 = 5.398$$

These values feed the `temporal-peak` and `trading-public` signals and the temporal, concentration, programs and trading components of the CLOAK Index (77, `high`).

See also: [05-counterparty-analysis.md](05-counterparty-analysis.md) · [07-exposure-signals.md](07-exposure-signals.md) · [08-cloak-index.md](08-cloak-index.md) · [16-limitations.md](16-limitations.md)

# Normalization Model

Every provider response is converted into a small set of stable domain types before any analysis runs. The analysis engine sees only these types, never Helius field names, which is what lets the live provider and the fictional demo dataset share one code path. This document defines the types, the field-by-field mapping from Helius responses, the activity classification algorithm, and the derived coverage object.

Implementation reference: `lib/helius/normalize.ts`, `lib/analysis/report.ts` (`dedupeTxs`, `buildCoverage`), `lib/solana/programs.ts`. Type definitions: [`reference/types.ts`](../reference/types.ts) (verbatim copy of `lib/types.ts`).

## Contents

- [Domain types](#domain-types)
- [Parsed Events to NormalizedTx](#parsed-events-to-normalizedtx)
- [Activity classification](#activity-classification)
- [Swap and protocol extraction](#swap-and-protocol-extraction)
- [Program list](#program-list)
- [Token amounts](#token-amounts)
- [DAS normalization](#das-normalization)
- [Identity normalization](#identity-normalization)
- [Deduplication and ordering](#deduplication-and-ordering)
- [Coverage](#coverage)
- [Program registry](#program-registry)

## Domain types

### `NormalizedTx`

One on-chain transaction touching the analyzed address.

| Field | Type | Meaning |
|---|---|---|
| `signature` | `string` | Transaction signature (base58) |
| `timestamp` | `number \| null` | Block time, Unix seconds; `null` when the provider has none |
| `slot` | `number` | Slot |
| `feeLamports` | `number` | Fee paid, lamports |
| `feePayer` | `string \| null` | Fee payer address |
| `success` | `boolean` | `true` when the transaction executed successfully |
| `kind` | `ActivityKind` | `transfer`, `swap`, `liquidity`, `account`, `program`, `failed` or `unknown` (see [classification](#activity-classification)) |
| `summaryType` | `string \| null` | Provider summary type verbatim (for example `"swap"`, `"transfer"`) |
| `protocol` | `string \| null` | Swap/liquidity venue reported by the provider, lowercased (for example `"jupiter"`) |
| `description` | `string \| null` | Provider's human-readable summary |
| `nativeMoves` | `NativeMove[]` | SOL movements: `{ from: string \| null, to: string \| null, lamports: number }` |
| `tokenMoves` | `TokenMove[]` | SPL / Token-2022 movements: `{ from, to, mint, amount, decimals }`, with `amount` in UI units |
| `programs` | `{ id: string; name: string \| null }[]` | Distinct top-level and inner program ids, in first-seen order |
| `swap` | `{ inputMint: string \| null; outputMint: string \| null } \| null` | Swap mints when the provider reports a swap |

### `Holding` and `WalletBalances`

| `Holding` field | Type | Meaning |
|---|---|---|
| `mint` | `string` | Asset id (mint address) |
| `symbol` | `string \| null` | Token symbol |
| `name` | `string \| null` | Metadata name |
| `amount` | `number` | UI amount (raw / 10^decimals); `1` for an NFT without a token balance |
| `decimals` | `number` | Decimals (0 when not reported) |
| `usdValue` | `number \| null` | Provider-reported USD value; `null` when no price is published |
| `kind` | `'fungible' \| 'nft'` | Asset class |

| `WalletBalances` field | Type | Meaning |
|---|---|---|
| `address` | `string` | Analyzed address |
| `lamports` | `number` | Native balance |
| `sol` | `number` | `lamports / 1e9` |
| `solUsd` | `number \| null` | Provider-reported USD value of the SOL balance |
| `holdings` | `Holding[]` | Non-zero holdings, at most 200 |
| `truncated` | `boolean` | `true` when holdings were capped server-side or the provider reported more assets than it returned |
| `fetchedAt` | `string` | ISO-8601 time of normalization |

### `PublicLabel`

| Field | Type | Meaning |
|---|---|---|
| `address` | `string` | Labeled address |
| `name` | `string` | Label name as asserted by the source |
| `category` | `string \| null` | For example `"Centralized Exchange"` |
| `type` | `string \| null` | For example `"exchange"` |
| `source` | `'helius-identity' \| 'demo'` | Who asserted the label. CLOAK never creates labels itself |

## Parsed Events to NormalizedTx

`normalizeParsedResult(result, wallet)` maps one Parsed Events row. It returns `null` (the row is skipped and counted as a parser error) when `parserStatus !== "OK"` or `parsed` is absent.

| `NormalizedTx` field | Source (Parsed Events) | Rule |
|---|---|---|
| `signature` | `signature` | Verbatim |
| `timestamp` | `parsed.blockTime` | `?? null` |
| `slot` | `parsed.slot` | Verbatim (required) |
| `feeLamports` | `parsed.fee` | Defaults to `0` |
| `feePayer` | `parsed.feePayer` | `?? null` |
| `success` | `parsed.transactionStatus` | `=== "OK"` (field defaults to `"OK"` when absent) |
| `kind` | whole `parsed` object | `classify(parsed, wallet)` |
| `summaryType` | `parsed.summary.type` | `?? null` |
| `protocol` | swap summary `parsedData.protocol`, else `parsed.summary.parsedData.protocol` | Lowercased; `null` when neither is present |
| `description` | `parsed.summary.description` | `?? null` |
| `nativeMoves[i]` | `parsed.nativeTransfers[i]` | `from ← fromUserAccount`, `to ← toUserAccount`, `lamports ← amount`. No filtering here; dust is filtered during counterparty analysis |
| `tokenMoves[i]` | `parsed.tokenTransfers[i]` | `from ← fromUserAccount`, `to ← toUserAccount` (owner accounts, not token accounts), `mint`, `decimals` (default 0), `amount ← rawTokenAmount / 10^decimals`. `fromTokenAccount`, `toTokenAccount`, `tokenStandard` are dropped |
| `programs` | `parsed.instructions[].programId`, `.programName` | Distinct ids, first-seen order; name from the first instruction with that id |
| `swap` | swap summary `parsedData.input_mint`, `.output_mint` | `null` unless a swap summary exists |

Example (demo swap, from [`examples/report.demo.json`](../examples/report.demo.json) `recent`):

```json
{
  "signature": "5W4tCTryG8qr...V3zqDg",
  "timestamp": 1790508732,
  "slot": 313603416,
  "feeLamports": 10000,
  "feePayer": "CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11",
  "success": true,
  "kind": "swap",
  "summaryType": "swap",
  "protocol": "jupiter",
  "description": "Swap via Jupiter",
  "nativeMoves": [],
  "tokenMoves": [
    { "from": "CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11", "to": "HYE4LgWkf8tfxaQxVLjsp9CLDhUvTBWGbgKQ3pRPgK7q", "mint": "So11111111111111111111111111111111111111112", "decimals": 9, "amount": 1.750228158 },
    { "from": "HYE4LgWkf8tfxaQxVLjsp9CLDhUvTBWGbgKQ3pRPgK7q", "to": "CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11", "mint": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "decimals": 6, "amount": 563.15529 }
  ],
  "programs": [
    { "id": "ComputeBudget111111111111111111111111111111", "name": "compute_budget" },
    { "id": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "name": "jupiter" },
    { "id": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "name": "token" }
  ],
  "swap": { "inputMint": "So11111111111111111111111111111111111111112", "outputMint": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" }
}
```

## Activity classification

`kind` is assigned by the first matching rule, in this exact order:

| # | Condition | `kind` |
|---|---|---|
| 1 | `transactionStatus !== "OK"` | `failed` |
| 2 | `summary.type === "swap"` | `swap` |
| 3 | `summary.type` is `add_liquidity` or `remove_liquidity` | `liquidity` |
| 4 | `summary.type === "transfer"` | `transfer` |
| 5 | `summary.type` is `create_account` or `create_token_account` | `account` |
| 6 | Any instruction has `summary.type === "swap"` | `swap` |
| 7 | Any instruction's `programId` is **not** an infrastructure program | `program` |
| 8 | Any native or token transfer has the wallet as `fromUserAccount` or `toUserAccount` | `transfer` |
| 9 | Otherwise | `unknown` |

```ts
// lib/helius/normalize.ts — classify
function classify(p: ParsedTransaction, wallet: string): ActivityKind {
  if (p.transactionStatus !== 'OK') return 'failed'
  const type = p.summary?.type ?? null
  if (type === 'swap') return 'swap'
  if (type && LIQUIDITY.has(type)) return 'liquidity'
  if (type === 'transfer') return 'transfer'
  if (type && ACCOUNT.has(type)) return 'account'
  // Instruction-level swap summaries catch routes the tx-level summary missed.
  if (p.instructions.some((i) => i.summary?.type === 'swap')) return 'swap'
  const touchesWallet =
    p.nativeTransfers.some((t) => t.fromUserAccount === wallet || t.toUserAccount === wallet) ||
    p.tokenTransfers.some((t) => t.fromUserAccount === wallet || t.toUserAccount === wallet)
  const meaningfulProgram = p.instructions.some((i) => !PLUMBING_PROGRAMS.has(i.programId))
  if (meaningfulProgram) return 'program'
  if (touchesWallet) return 'transfer'
  return 'unknown'
}
```

Consequences of the ordering:

- A failed transaction is always `failed`, regardless of its summary.
- Rule 6 catches swaps the transaction-level summary did not label, for example a swap nested inside another program's instruction.
- Any other provider summary type (for example a staking or NFT event) falls through to rules 6–9 and usually becomes `program`.
- Rule 7 precedes rule 8: a transaction without a recognized summary that both calls a non-infrastructure program and moves funds to or from the wallet is `program`, not `transfer`. Only transactions that touch infrastructure programs exclusively fall back to `transfer`.
- `kind` drives counterparty extraction: `swap` and `liquidity` legs are attributed to the venue and never create counterparties ([05-counterparty-analysis.md](05-counterparty-analysis.md)).

Demo distribution (`dna.kindMix`, 96 transactions): `transfer` 57, `swap` 29, `program` 7, `failed` 3.

## Swap and protocol extraction

```ts
const swapSummary =
  p.summary?.type === 'swap' ? p.summary : (p.instructions.find((i) => i.summary?.type === 'swap')?.summary ?? null)
const protocol = swapSummary?.parsedData?.protocol ?? p.summary?.parsedData?.protocol ?? null
```

- **Swap summary:** the transaction-level summary if its type is `swap`; otherwise the summary of the **first** instruction whose summary type is `swap`; otherwise none.
- **`swap`:** `{ inputMint: parsedData.input_mint ?? null, outputMint: parsedData.output_mint ?? null }` from the swap summary, or `null`. For multi-hop routes only the first swap summary's mints are kept.
- **`protocol`:** the swap summary's `parsedData.protocol`, falling back to the transaction summary's `parsedData.protocol` (this is how liquidity venues are captured), lowercased. Transactions without either have `protocol: null`; swaps without a protocol are counted under `"unattributed"` in Wallet DNA.

## Program list

`programs` contains each distinct `instructions[].programId` once, in the order first encountered. Parsed Events returns top-level and inner instructions in one list, so inner (CPI) programs are included. The `name` is the provider's `programName` from the first instruction with that id, or `null`. Display names are resolved later with `programName()` (see [Program registry](#program-registry)).

## Token amounts

```ts
amount: toNumber(t.rawTokenAmount) / 10 ** t.decimals
```

`rawTokenAmount` may be a number or a numeric string; a non-finite value becomes `0`. Conversion uses IEEE-754 doubles, so raw amounts above 2^53 lose precision in the last digits. This does not affect any metric CLOAK computes (token legs are counted, not summed). Native amounts stay in lamports in `NativeMove`; SOL values are computed downstream as `lamports / 1e9`.

## DAS normalization

`normalizeAssets(address, raw, fallbackLamports)` converts a `getAssetsByOwner` result.

For each item:

1. **NFT detection.** `kind = 'nft'` when `interface` is one of `V1_NFT`, `V2_NFT`, `ProgrammableNFT`, `MplCoreAsset`, `LEGACY_NFT`; otherwise `fungible`.
2. **Amount.** `decimals = token_info.decimals ?? 0`. Raw balance is `token_info.balance` when present, else `1` for an NFT, else `0`. `amount = raw / 10^decimals`.
3. **Zero-balance drop.** Items with `amount <= 0` are discarded.
4. **Fields.** `symbol = token_info.symbol ?? content.metadata.symbol ?? null`; `name = content.metadata.name ?? null`; `usdValue = token_info.price_info.total_price ?? null`.

Then:

- **Sort:** `usdValue` descending (a `null` value sorts as `-1`, i.e. after every priced asset), then `amount` descending.
- **Cap:** `MAX_HOLDINGS = 200`; the first 200 after sorting are kept.
- **`truncated`:** `holdings.length > 200` **or** `result.total > items.length` (the provider has more assets than page 1 returned).
- **Native balance:** `lamports = result.nativeBalance.lamports ?? fallbackLamports ?? 0` (the scan passes `null` as fallback, so a missing native balance yields 0); `sol = lamports / 1e9`; `solUsd = result.nativeBalance.total_price ?? null`.

Demo result: 42.371 SOL and 6 holdings (4 fungible, 2 NFTs), `truncated: false`. The fictional `SPCMN` token has no price and therefore sorts after the priced tokens.

## Identity normalization

`normalizeIdentity(row)` returns `null` when the row is `unresolved`, or has no `address`, or has no `name`. Otherwise:

```json
{ "address": "...", "name": "...", "category": "... or null", "type": "... or null", "source": "helius-identity" }
```

`tags` are not used. Unresolved rows are dropped silently; the address is cached as having no label (see [03-data-sources-and-ingestion.md](03-data-sources-and-ingestion.md#wallet-api-public-labels)).

## Deduplication and ordering

`dedupeTxs(txs)` runs on every history before analysis:

1. Keep the first occurrence of each `signature`; drop later duplicates.
2. Sort **newest first**: `timestamp` descending (a `null` timestamp sorts as 0, i.e. last), then `slot` descending, then `signature` ascending (`localeCompare`).

The explicit tiebreak makes the order, and therefore every downstream "first N" selection (recent transactions in the report, evidence lists), deterministic. Second-hop seed histories used by the Trace Map are normalized but not passed through `dedupeTxs`.

## Coverage

`buildCoverage(txs, meta)` describes what the analysis actually saw:

| Field | Computation |
|---|---|
| `txCount` | Number of normalized, deduplicated transactions |
| `successCount` | Count with `success === true` |
| `failedCount` | `txCount − successCount` |
| `oldest`, `newest` | Min and max of non-null timestamps, or `null` |
| `spanDays` | `(newest − oldest) / 86400`, rounded to one decimal; `0` when either is `null` |
| `pagesFetched` | History pages requested (1 in demo mode) |
| `requestedLimit` | The effective window cap |
| `limitReached` | From pagination: `true` when the window filled before the end of history ([03](03-data-sources-and-ingestion.md#pagination-algorithm)) |
| `fetchedAt` | ISO time (fixed to `DEMO_NOW` in demo mode) |

Demo coverage: 96 transactions (93 successful, 3 failed), `oldest` 1784410918, `newest` 1790797664, `spanDays` 73.9, 1 page, `requestedLimit` 300, `limitReached: false`.

Parser-error rows are not part of `txCount`. Failed transactions are part of `txCount` and of timing metrics, but not of counterparties, program footprint or trading metrics.

## Program registry

`lib/solana/programs.ts` holds two fixed sets. They are display hints and filters for program ids; they are never used as identity labels for wallets.

### Infrastructure ("plumbing") programs

Programs nearly every transaction touches. They carry no behavioral signal and are excluded from the program footprint (Wallet DNA, CLOAK Index) and from rule 7 of classification.

| Program id | Name |
|---|---|
| `11111111111111111111111111111111` | System Program |
| `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | SPL Token |
| `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | Token-2022 |
| `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | Associated Token Account |
| `ComputeBudget111111111111111111111111111111` | Compute Budget |
| `Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo` | Memo v1 |
| `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` | Memo v2 |

### Known programs (display names)

All infrastructure programs above, plus:

| Program id | Display name |
|---|---|
| `Stake11111111111111111111111111111111111111` | Stake Program |
| `Vote111111111111111111111111111111111111111` | Vote Program |
| `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` | Jupiter Aggregator v6 |
| `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | Orca Whirlpools |
| `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | Raydium AMM v4 |
| `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | Raydium CLMM |
| `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | Meteora DLMM |
| `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | Pump.fun |
| `M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K` | Magic Eden v2 |
| `TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN` | Tensor Swap |
| `MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD` | Marinade Finance |
| `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | Metaplex Token Metadata |

The 19 known program ids are also excluded as transfer counterparties (`isProgramId`, see [05-counterparty-analysis.md](05-counterparty-analysis.md#leg-extraction)).

**Display name resolution** (`programName(id, providerName)`): the known-program name if listed; otherwise the provider's `programName` with underscores replaced by spaces and words title-cased (`bison_fi` → `Bison Fi`); otherwise a short id `abcd…wxyz`.

**Mint symbols** (`mintSymbol`, used for traded-pair labels): `So11111111111111111111111111111111111111112` → `wSOL`, `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` → `USDC`, `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` → `USDT`, `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` → `JUP`, `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` → `BONK`; any other mint is shortened to `abcd…wxyz`.

See also: [03-data-sources-and-ingestion.md](03-data-sources-and-ingestion.md) · [05-counterparty-analysis.md](05-counterparty-analysis.md) · [06-wallet-dna.md](06-wallet-dna.md) · [../reference/types.ts](../reference/types.ts)

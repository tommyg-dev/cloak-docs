# Limitations

This document lists what CLOAK does not see, does not model, or models only approximately. Each item names the implementation detail responsible, so a reader can judge its effect on a given report.

## Contents

- [Bounded analysis window](#bounded-analysis-window)
- [Provider coverage and parsing gaps](#provider-coverage-and-parsing-gaps)
- [Label coverage](#label-coverage)
- [Swaps are attributed to venues](#swaps-are-attributed-to-venues)
- [Dust threshold](#dust-threshold)
- [UTC-only timing](#utc-only-timing)
- [No clustering or ownership inference](#no-clustering-or-ownership-inference)
- [Holdings and NFTs](#holdings-and-nfts)
- [USD values](#usd-values)
- [Per-instance rate limits and caches](#per-instance-rate-limits-and-caches)
- [The CLOAK Index is relative to its thresholds](#the-cloak-index-is-relative-to-its-thresholds)
- [Heuristic secret detection](#heuristic-secret-detection)
- [Imported reports are unauthenticated](#imported-reports-are-unauthenticated)
- [The demo dataset is synthetic](#the-demo-dataset-is-synthetic)
- [Planned, not built](#planned-not-built)

## Bounded analysis window

A live scan analyzes only the **most recent ≤ `CLOAK_MAX_TX` transactions** (default 300, maximum 500), fetched newest first in pages of 100 (`fetchHistory` in `lib/server/helius.ts`). Older history is not retrieved and not analyzed.

- `coverage.limitReached` is `true` when the window filled before the provider signalled the end of history. It means "older history may exist and was not analyzed". A wallet with exactly `CLOAK_MAX_TX` transactions can be reported as capped, because the fetch loop stops as soon as the window is full.
- When capped, the terminal shows "window capped at N — older history not analyzed", signals state "Based on the most recent N transactions only", and the shareable summary adds "(recent window only)".
- The funding signal downgrades itself when capped: title "Earliest observed funding source", severity `low`, confidence `low`, with the limitation "Older history was not analyzed, so the true first funder may be different."
- Every metric (counterparties, Wallet DNA, the CLOAK Index) describes the window, not the wallet's lifetime. A busy wallet's 300-transaction window may span hours; a quiet wallet's may span years. Compare `coverage.spanDays` before comparing reports.
- Balances are a point-in-time snapshot from DAS at scan time and are not reconciled with the transaction window.

## Provider coverage and parsing gaps

- CLOAK sees what Helius Parsed Events returns for the address. Which transactions are associated with an address is the provider's definition; CLOAK does not separately query token accounts or other derived accounts.
- Results with `parserStatus` other than `OK` are skipped by `normalizeParsedResult` and counted as `parserErrors`. The count appears in the `mapping` stage progress line (`N unparseable skipped`) and in the transactions endpoint's `parserErrors` field. It is **not** stored in the report's `coverage` object, so a saved or exported report does not record how many transactions were skipped.
- Transactions without a `blockTime` have `timestamp: null` and are excluded from timing analysis.
- Provider classifications (`summary.type`, `protocol`) are taken as given. A swap the provider does not label as a swap is analyzed as whatever kind the normalizer derives from its transfers and instructions. See [Normalization model](04-normalization-model.md).
- Provider responses are validated for shape, not truth.

## Label coverage

- Public labels come only from the Helius Wallet API identity service, which requires a **paid plan**. On the Free plan the endpoint returns 403, `labelSupport` is `unsupported-plan`, a low-severity "Public labels not checked" signal is added, and the labeling component is excluded from the index.
- At most **100 addresses** are checked per scan: the wallet and its top 99 counterparties by transaction count. Lower-ranked counterparties are never looked up.
- Labels are **third-party assertions**. CLOAK displays them with their source and does not verify them. An unlabeled address is not evidence that the address is unknown to analysts.
- Label results are cached for 6 hours per instance; a label added or removed upstream within that time is not reflected.

## Swaps are attributed to venues

For transactions whose kind is `swap` or `liquidity`, `legsFor` (`lib/analysis/counterparties.ts`) returns no legs at all. Consequences:

- Swap counterparties (pool vaults, aggregator accounts) are not treated as relationships. This is intended: they are venues used by thousands of wallets.
- Relationships mediated by a venue (for example, two wallets repeatedly trading the same pool, or one wallet's swap output later reaching another) are not modeled.
- Any direct transfer bundled inside a swap or liquidity transaction is dropped along with the swap legs.
- Trading behavior is reported separately through swap counts, venues and pairs in Wallet DNA and the trading signal.

## Dust threshold

Native SOL moves below `DUST_LAMPORTS = 10,000` lamports (0.00001 SOL) are ignored when building relationships, to suppress address-poisoning spam.

- Genuine tiny SOL transfers are hidden from counterparties, edges and the funding signal.
- The threshold applies to native SOL only. Token transfers are kept if their amount is greater than zero, so token-based poisoning (fake or near-zero token transfers from look-alike addresses) can still create counterparties.
- The recurring-payment detector uses a separate floor of 1,000,000 lamports (0.001 SOL) and groups amounts rounded to three decimals.

## UTC-only timing

All hour-of-day, weekday and daily metrics use UTC (`getUTCHours`, `getUTCDay` in `lib/analysis/dna.ts`). CLOAK does not infer a time zone, and it does not adjust for daylight saving time, so a habit that is constant in local time can appear to shift by an hour across DST changes. The peak window is a fixed 4-hour width (wrapping past midnight), and the temporal signal requires at least 15 timestamped transactions.

## No clustering or ownership inference

CLOAK does not cluster addresses or infer that two addresses share an owner. A Trace Map edge means a transfer between two addresses was observed in the window; nothing more. CLOAK does not apply common-funder, fee-payer, timing-correlation or behavioral-fingerprint clustering, and does not link wallets across chains or to off-chain identities. Real-world analysts do, so CLOAK's findings are a lower bound on what can be inferred. See [Trace Map](09-trace-map.md).

## Holdings and NFTs

- Balances come from one DAS `getAssetsByOwner` call: page 1, up to 1,000 assets. Larger inventories set `balances.truncated`, and reports keep at most `MAX_HOLDINGS = 200` holdings.
- An asset counts as an NFT only if its DAS `interface` is one of `V1_NFT`, `V2_NFT`, `ProgrammableNFT`, `MplCoreAsset` or `LEGACY_NFT`. Assets with other interfaces and no token balance are dropped.
- Compressed NFTs are included only as DAS reports them; CLOAK has no compression-specific handling (no Merkle-tree or proof data, no special treatment of compressed transfers in history).
- Zero balances are dropped.

## USD values

USD values appear only when the provider publishes a price (`token_info.price_info.total_price` for tokens, `nativeBalance.total_price` for SOL); otherwise they are `null` and the UI shows "No price published". The holdings signal's USD thresholds sum priced assets only, so a wallet whose value is in unpriced tokens appears lower-value than it is. Prices are the provider's, at fetch time.

## Per-instance rate limits and caches

Rate-limit buckets and TTL caches are held in each server instance's memory. On serverless platforms the effective global rate limit is (warm instances × per-instance limit), and cache hits depend on which instance serves a request. See [Self-hosting and operations](15-self-hosting-and-operations.md#rate-limits-and-caches-across-instances).

## The CLOAK Index is relative to its thresholds

- Each component saturates at a fixed threshold (`THRESHOLDS` in `lib/analysis/score.ts`): holdings at 10, repeated counterparties at 6, programs at 10, swaps at 15, labeled-counterparty transactions at 5. Beyond saturation, more activity does not raise the index: a wallet with 15 swaps and one with 1,500 score the same on the trading component.
- The index measures how many observable indicators are present in **this window**, under **this methodology version** (`cloak-index/1.0`). It is not calibrated against real de-anonymization outcomes, is not a probability, and is not comparable across methodology versions.
- Components that cannot be evaluated are excluded rather than scored as zero. Below 10 successful timestamped transactions, or below 60 % evaluable weight, the result is INSUFFICIENT DATA rather than a number.
- A low index is not evidence of privacy. See [CLOAK Index](08-cloak-index.md).

## Heuristic secret detection

`looksLikeSecret` (`lib/solana/address.ts`) recognizes three shapes: 12 or more alphabetic words, a bracketed list of 32 or more integers, and a base58 string longer than 80 characters that decodes to 64 bytes.

- **False negatives:** secrets in other encodings (for example, hex) or phrases with punctuation or digits are not recognized as secrets. They still fail address validation and are rejected, but with the generic "Not a valid Solana public address" message rather than the explicit warning.
- **False positives:** a transaction signature (64 bytes base58) or a sentence of 12 or more plain words is refused with the secret warning.
- The wordlist is not checked against BIP-39.

## Imported reports are unauthenticated

Report import checks file size (5 MB) and structure only. Exports are not signed, so an imported report may have been edited, and the current UI does not mark imported reports differently from scanned ones. See [Terminal client](13-terminal-client.md#report-import).

## The demo dataset is synthetic

The demo wallet's activity is scripted to exercise specific signals (see [Demo dataset](14-demo-dataset.md)). Its index, signal mix and balances say nothing about typical wallets, and its scripted habits are cleaner than real behavior.

## Planned, not built

These are described on the marketing site as planned and **do not exist** in the codebase:

| Item | Status |
|---|---|
| Browser extension | Planned, in development; not shipped |
| Mobile app | Planned, in development; not shipped. The terminal is a responsive web app and can be opened in a wallet's in-app browser |
| Continuous exposure monitoring (opt-in re-scans and alerts) | Not built. Every scan is on demand; nothing runs in the background |
| `$CLOAK` token utility | Planned. No contract address is published in the codebase (`TOKEN.status = 'planned'`); no feature depends on a token |
| Paid analysis tiers | Planned, not built |

See also: [CLOAK Index](08-cloak-index.md) · [Exposure signals](07-exposure-signals.md) · [Security and privacy](12-security-and-privacy.md) · [Glossary](glossary.md)

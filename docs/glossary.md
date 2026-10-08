# Glossary

Definitions of terms used across the CLOAK documentation, in alphabetical order. Where a term maps to a code identifier, the identifier and module are given.

**Address poisoning.** A spam technique in which an attacker sends tiny transfers from an address that resembles one the victim uses, hoping the victim later copies it from their history. CLOAK ignores native SOL moves below the dust threshold so these transfers do not create counterparties. See [Counterparty analysis](05-counterparty-analysis.md).

**Band.** The qualitative range of a scored CLOAK Index: `low` (< 25), `moderate` (25–49), `elevated` (50–74), `high` (≥ 75). `scoreBand` in `lib/analysis/score.ts`.

**Base58.** The encoding Solana uses for addresses and signatures (alphabet without `0`, `O`, `I`, `l`). A valid address decodes to exactly 32 bytes; a signature to 64 bytes. `lib/solana/address.ts`.

**CLOAK Index.** A deterministic 0–100 observational exposure index for one analysis window: the weighted mean of the evaluable components, scaled to 100. 0 means fewer observable exposure indicators; 100 means more. It is not an anonymity score or a security guarantee. Methodology version `cloak-index/1.0`. See [CLOAK Index](08-cloak-index.md).

**CLOAK Intelligence Report.** The printable report on the Terminal's Reports page, assembled from a `ScanReport`: analyzed wallet, coverage, index, findings with evidence, wallet connections and recommendations.

**CLOAK Scanner.** The `/app/scan` view of the Terminal, which submits an address and shows the streamed scan stages.

**CLOAK Terminal.** The client application under `/app`. See [Terminal client](13-terminal-client.md).

**`cloak-findings/1`.** The JSON export format produced by Reports → JSON, including the full `ScanReport` for re-import. See [Terminal client](13-terminal-client.md#report-export-format-cloak-findings1).

**Confidence.** A signal's stated reliability (`low`, `medium`, `high`), separate from its severity. It typically drops when sample sizes are small or the window is capped.

**Counterparty.** An address with at least one transfer leg with the analyzed wallet in a successful, non-venue transaction, excluding known program IDs and dust. A counterparty records in/out counts, transaction count, SOL in/out, token-move count, mints, first/last seen, an optional public label and evidence. `aggregateCounterparties` in `lib/analysis/counterparties.ts`.

**Coverage window.** The set of transactions actually analyzed, described by the report's `coverage` object: `txCount`, `successCount`, `failedCount`, `oldest`, `newest`, `spanDays`, `pagesFetched`, `requestedLimit`, `limitReached` and `fetchedAt`. All findings describe this window, not the wallet's lifetime.

**DAS (Digital Asset Standard API).** Helius's asset-indexing API. CLOAK calls `getAssetsByOwner` with `showFungible` and `showNativeBalance` to read SOL, fungible tokens and NFTs.

**Data mode.** `live` (real addresses through Helius) or `demo` (the fictional dataset, no provider calls). Live mode never falls back to demo data.

**Demo address.** `CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11`, the only address demo mode accepts. See [Demo dataset](14-demo-dataset.md).

**Dust.** Native SOL moves below `DUST_LAMPORTS` = 10,000 lamports (0.00001 SOL). Ignored when building counterparties, edges and the funding signal. Token transfers are not dust-filtered beyond requiring an amount greater than zero.

**Edge.** A directed Trace Map connection (`source → target`) aggregated from observed transfer legs, with a transaction count, SOL total, token-move count and up to 4 evidence references. An edge does not imply shared ownership.

**Evaluable component.** A CLOAK Index component with enough data to compute its 0..1 indicator (`raw` is not `null`). Non-evaluable components are excluded from both numerator and denominator, so missing data never lowers the index. **Evaluated weight** is the sum of evaluable weights; below 60 the result is INSUFFICIENT DATA.

**Evidence reference.** A pointer attached to a signal, counterparty or edge: `{ kind: 'tx' | 'account' | 'token', ref, timestamp, note }`, where `ref` is a transaction signature, an address or a mint. In live mode the Terminal links it to Solscan; in demo mode it shows `demo · no record`.

**Exposure Signal.** An explainable finding derived from the window, with a category, title, observation, severity, confidence, evidence, a written limitation and an educational recommendation. See [Exposure signals](07-exposure-signals.md).

**Fee payer.** The account that paid a transaction's fee, as reported by the provider (`feePayer`).

**HHI (Herfindahl-Hirschman index).** The sum of squared shares of each counterparty's transaction count among all counterparty interactions: $\sum_i s_i^2$. It ranges from near 0 (interactions spread across many counterparties) to 1 (a single counterparty). Reported as `dna.counterpartyHhi`; `hhi` in `lib/analysis/dna.ts`.

**Hop.** Distance from the analyzed wallet in the Trace Map: 0 is the wallet, 1 a direct counterparty, 2 a counterparty of a second-hop seed.

**INSUFFICIENT DATA.** The CLOAK Index result (`status: 'insufficient'`, `value: null`) when there are fewer than 10 successful timestamped transactions or less than 60 % evaluable weight. It is shown instead of a number, never as a low score.

**Label support.** Whether public labels were available for a scan (`labelSupport`): `supported` (Helius identity queried), `unsupported-plan` (endpoint returned 403 on the current plan), `unavailable` (lookup failed for another reason), or `demo` (fictional labels).

**Lamport.** The smallest unit of SOL: 1 SOL = 1,000,000,000 lamports.

**Leg.** One directed transfer between the analyzed wallet and one other address inside a transaction (`direction: 'in' | 'out'`, SOL amount or token mint). Legs are extracted only from successful transactions that are not swaps or liquidity actions. `legsFor` in `lib/analysis/counterparties.ts`.

**`limitReached`.** Coverage flag that is `true` when the history window filled to its cap before the provider signalled the end of history, meaning older transactions may exist and were not analyzed.

**Methodology version.** The identifier of the scoring rules that produced an index, currently `cloak-index/1.0` (`METHODOLOGY_VERSION`). Indexes are comparable only within one version.

**Mint.** The address that defines an SPL token or NFT. Token holdings and token moves are keyed by mint.

**NDJSON (newline-delimited JSON).** A stream of JSON objects separated by `\n`. `POST /api/scan` responds with `content-type: application/x-ndjson`, one `ScanEvent` per line. See [Scan protocol](10-scan-protocol.md).

**Normalized transaction.** CLOAK's provider-independent transaction model (`NormalizedTx` in `lib/types.ts`): signature, timestamp, slot, fee, fee payer, success, kind, protocol, native moves, token moves, programs and swap summary. Analysis code sees only this type. See [Normalization model](04-normalization-model.md).

**Parsed Events.** The Helius transaction-history API used by CLOAK (`POST {rpc}/v1/parsed-events/transaction-history`), which returns parsed transactions with native transfers, token transfers, a summary and instructions. It replaces the legacy Enhanced Transactions API.

**Parser error.** A Parsed Events result whose `parserStatus` is not `OK`. CLOAK skips it and counts it; the count is reported in the mapping stage's progress line, not in the report.

**PDA (program-derived address).** An address derived from a program ID and seeds that has no private key (off the ed25519 curve). CLOAK accepts PDAs as scan targets because their history is public like any other address.

**Peak window.** The 4-hour UTC window (wrapping past midnight) containing the largest share of timestamped transactions (`dna.peakWindowStartHour`, `dna.peakWindowShare`). The temporal component rescales this share so a uniform distribution (4/24) maps to 0.

**Plumbing program.** An infrastructure program nearly every transaction touches (System Program, SPL Token, Token-2022, Associated Token Account, Compute Budget, Memo). Excluded from program-footprint metrics. `PLUMBING_PROGRAMS` in `lib/solana/programs.ts`.

**Privacy Mode.** CLOAK's name for its educational recommendations (wallet separation, fresh receiving addresses, funding hygiene). It changes nothing on-chain and cannot make past activity private.

**Public label.** A third-party name and category for an address (for example, an exchange), from the Helius Wallet API identity service on paid plans. CLOAK displays labels with their source and does not verify them.

**Rate limit.** Per-IP token buckets held in each server instance's memory: the scan bucket (capacity and refill `CLOAK_RATE_LIMIT_PER_MIN`, default 12) and the read bucket (4 ×). `lib/server/rateLimit.ts`.

**Report id.** A stable identifier `GR-` followed by a base-36 FNV-1a hash of `mode:address:newest:oldest:txCount`. `reportId` in `lib/analysis/report.ts`.

**Saturation.** The threshold at which a CLOAK Index component's indicator reaches 1 and stops increasing (for example, 15 swaps for trading, 6 repeated counterparties). Activity beyond saturation does not raise the index.

**Scan stage.** One of the five units of server work reported by the scan stream: `connecting`, `retrieving`, `mapping`, `analyzing`, `reporting`.

**Second-hop seed.** A first-hop counterparty whose own history is fetched for a depth-2 Trace Map. Up to 5 seeds, unlabeled counterparties only, most-connected first; 50 transactions and 6 neighbours per seed.

**Session.** A local record of how a visitor entered the Terminal: `wallet`, `saved` or `viewer`. There are no accounts or passwords.

**Severity.** A signal's assessed exposure impact (`low`, `medium`, `high`), derived from fixed thresholds per signal type.

**Signature.** A transaction's unique identifier: a 64-byte ed25519 signature, base58-encoded (typically 86–88 characters).

**Slot.** Solana's unit of ledger time; each transaction is recorded in a slot. Used by CLOAK as an ordering tiebreak.

**Top-3 share.** The fraction of all counterparty interactions held by the three counterparties with the most transactions (`dna.top3CounterpartyShare`); the indicator for the concentration component, evaluated once there are at least 5 interactions.

**Trace Map.** The Terminal's graph of observed transfers between the wallet and its counterparties, optionally with a bounded second hop. See [Trace Map](09-trace-map.md).

**Venue.** The protocol or pool through which a swap or liquidity action executes (for example, `jupiter`). Legs of swap and liquidity transactions are attributed to the venue rather than counted as wallet relationships.

**Viewer mode.** A Terminal session that writes no reports or history to browser storage; the session record lives in `sessionStorage` for the tab only. Deep links (`/app?demo=1`, `/app/scan?address=…`) enter in viewer mode.

**Wallet DNA.** The behavioral profile derived from the window: UTC hour and weekday distributions, day × hour heatmap, daily series, kind and protocol mix, program footprint, median gap, peak window, concentration metrics and trading summary. See [Wallet DNA](06-wallet-dna.md).

**Wallet Standard.** A cross-wallet interface through which wallets register themselves with web pages. CLOAK discovers wallets this way (Solana Wallet Adapter with an empty adapter list) and reads only the connected public key.

**wSOL (wrapped SOL).** SOL held as an SPL token under mint `So11111111111111111111111111111111111111112`, used by DEXs in swaps.

See also: [Overview](01-overview.md) · [CLOAK Index](08-cloak-index.md) · [Limitations](16-limitations.md)

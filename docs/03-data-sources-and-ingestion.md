# Data Sources and Ingestion

CLOAK reads all live data from Helius: parsed transaction history from the Parsed Events API, balances from the DAS API and public labels from the Wallet API. This document specifies every provider call (endpoint, request body, pagination, authentication), the timeout and retry policy, error mapping, caching, and how responses are validated.

Implementation reference: `lib/server/helius.ts`, `lib/server/env.ts`, `lib/server/cache.ts`, `lib/helius/schemas.ts`.

## Contents

- [Provider calls at a glance](#provider-calls-at-a-glance)
- [Authentication and endpoint configuration](#authentication-and-endpoint-configuration)
- [Parsed Events: transaction history](#parsed-events-transaction-history)
- [DAS: balances and holdings](#das-balances-and-holdings)
- [Wallet API: public labels](#wallet-api-public-labels)
- [Health probe](#health-probe)
- [Timeouts and retries](#timeouts-and-retries)
- [Error mapping](#error-mapping)
- [Caching](#caching)
- [Schema validation](#schema-validation)
- [Credit cost](#credit-cost)

## Provider calls at a glance

| Purpose | Helius product | Method and path | Caller | Plan |
|---|---|---|---|---|
| Transaction history (scan, summary, graph) | Parsed Events | `POST {rpc}/v1/parsed-events/transaction-history` | `fetchHistory` | All plans |
| One history page (transactions endpoint) | Parsed Events | `POST {rpc}/v1/parsed-events/transaction-history` | `fetchHistoryPage` | All plans |
| SOL, fungible and NFT balances | DAS | `POST {rpc}/` JSON-RPC `getAssetsByOwner` | `fetchBalances` | All plans |
| Public identity labels | Wallet API | `POST {api}/v1/wallet/batch-identity` | `fetchLabels` | Paid plans; `403` on Free |
| Liveness | RPC | `POST {rpc}/` JSON-RPC `getHealth` | `probeProvider` | All plans |

Parsed Events replaced the legacy Enhanced Transactions API; CLOAK does not call Enhanced Transactions. All calls are HTTP `POST` with `content-type: application/json` and `cache: 'no-store'`. All are idempotent reads, which is what makes retrying them safe.

## Authentication and endpoint configuration

The API key is sent as the `api-key` query parameter (URL-encoded) on every request. It is resolved server-side only and never sent to the browser.

**Key resolution order** (`env.heliusKey`, first non-empty value wins):

1. `HELIUS_API_KEY` (trimmed).
2. The `api-key` query parameter of `HELIUS_RPC_URL`, only if that URL's hostname matches `/helius/i`.
3. The `api-key` query parameter of `RPC_URL`, under the same Helius host check.

A URL whose host is not a Helius host (for example `https://api.mainnet-beta.solana.com/?api-key=...`) yields no key. This is covered by `tests/env.test.ts`.

**Base URLs:**

| Variable | Default | Processing |
|---|---|---|
| `HELIUS_RPC_URL` → `{rpc}` | `https://mainnet.helius-rpc.com` | Query string stripped (an embedded key is re-appended per request), trailing `/` removed |
| `HELIUS_API_URL` → `{api}` | `https://api.helius.xyz` | Trailing `/` removed |

`RPC_URL` contributes only a key; it does not change `{rpc}`. The Helius host check applies to key extraction, not to the `HELIUS_RPC_URL` base.

If no key resolves, live requests fail fast with `not_configured` before any network call. Demo mode never contacts the provider.

## Parsed Events: transaction history

### Request

```http
POST https://mainnet.helius-rpc.com/v1/parsed-events/transaction-history?api-key=<KEY>
content-type: application/json
```

```json
{
  "address": "GV6UUmNxz2RpKxmNAPadYKb7uQpszwqQAu3qLJxVdC52",
  "limit": 100,
  "sortOrder": "desc",
  "commitment": "confirmed",
  "paginationToken": "433950192:0"
}
```

| Field | Value |
|---|---|
| `address` | The analyzed address (already validated as 32-byte base58) |
| `limit` | `min(100, remaining)` — page size is 100 (`PAGE_SIZE`); the last page requests only what is left of the window |
| `sortOrder` | Always `"desc"` (newest first) |
| `commitment` | Always `"confirmed"` |
| `paginationToken` | Omitted on the first page; the previous response's token afterwards |

### Response (validated subset)

```json
{
  "data": [
    {
      "signature": "5xSKzM8b...",
      "parserStatus": "OK",
      "parsed": { "slot": 433950192, "blockTime": 1784487060, "fee": 2005000, "transactionStatus": "OK", "...": "..." }
    },
    { "signature": "x", "parserStatus": "ERROR", "parserError": { "code": "transaction_not_found" } }
  ],
  "paginationToken": "433950192:0"
}
```

Rows whose `parserStatus` is not `"OK"` (or that have no `parsed` object) are dropped during normalization and counted as `parserErrors`. The scan's mapping stage reports them ("n unparseable skipped"); `GET /api/wallet/{address}/transactions` returns the count as `parserErrors`. They count toward the fetched window but not toward `coverage.txCount`.

### Window size

| Setting | Value |
|---|---|
| `CLOAK_MAX_TX` | Default `300` when unset or non-numeric; otherwise floored and clamped to `[50, 500]` (an empty string parses as 0 and therefore becomes 50) |
| `POST /api/scan` body `limit` | Optional integer, schema bounds `10–500`; then clamped to `[1, CLOAK_MAX_TX]`. The Terminal never sends it, so scans use `CLOAK_MAX_TX` |
| Effective cap inside `fetchHistory` | `capped = max(1, min(limit, CLOAK_MAX_TX))` |
| Maximum pages per scan | `ceil(capped / 100)`, i.e. at most 5 |
| Second-hop seed history | `fetchHistory(seed, 50)`: one page of 50 |
| Summary and graph routes | `fetchHistory(address, CLOAK_MAX_TX)` (same cache key as a default scan) |

### Pagination algorithm

```ts
// lib/server/helius.ts — fetchHistory (trimmed)
while (results.length < capped) {
  const page = await postJson(url, {
    address,
    limit: Math.min(PAGE_SIZE, capped - results.length),
    sortOrder: 'desc',
    commitment: 'confirmed',
    ...(token ? { paginationToken: token } : {}),
  }, historyPageSchema, signal)
  pages += 1
  results.push(...page.data)
  onPage?.(pages, results.length)          // → "Page n · total transactions" progress event
  if (!page.paginationToken || page.data.length === 0) { reachedEnd = true; break }
  token = page.paginationToken
}
return { results: results.slice(0, capped), pagesFetched: pages, limitReached: !reachedEnd }
```

**`limitReached`** is `true` whenever the loop stopped because the window filled up rather than because the provider signalled the end of history (no `paginationToken`, or an empty page). It is conservative: if the window fills exactly at the true start of history but the provider still returned a token, `limitReached` is `true`. Downstream, `limitReached: true` lowers confidence for funding signals and is shown as "recent window only" in reports.

Pages are fetched **sequentially**, because each page needs the previous page's token.

### Single-page variant

`fetchHistoryPage(address, limit, cursor)` serves `GET /api/wallet/{address}/transactions`. It sends one request with `limit = clamp(limit, 1, 100)` (query default 25) and the caller's `cursor` as `paginationToken`. `nextCursor` is the response token, or `null` when the page was empty or no token was returned. The cursor must match `^[A-Za-z0-9:_-]+$` and be at most 200 characters.

## DAS: balances and holdings

### Request

```http
POST https://mainnet.helius-rpc.com/?api-key=<KEY>
content-type: application/json
```

```json
{
  "jsonrpc": "2.0",
  "id": "ghost-assets",
  "method": "getAssetsByOwner",
  "params": {
    "ownerAddress": "GV6UUmNxz2RpKxmNAPadYKb7uQpszwqQAu3qLJxVdC52",
    "page": 1,
    "limit": 1000,
    "options": { "showFungible": true, "showNativeBalance": true }
  }
}
```

Only page 1 with `limit: 1000` is requested; there is no further DAS pagination. When the provider's `result.total` exceeds the number of returned items, or more than 200 non-zero holdings remain after normalization, `WalletBalances.truncated` is `true` (see [04-normalization-model.md](04-normalization-model.md#das-normalization)).

A JSON-RPC `error` object in a `200` response is raised as `upstream` ("getAssetsByOwner failed: ...") and is not retried.

During a live scan, the DAS call runs **in parallel** with history pagination (`Promise.all` in `runScan`).

## Wallet API: public labels

### Request

```http
POST https://api.helius.xyz/v1/wallet/batch-identity?api-key=<KEY>
content-type: application/json
```

```json
{ "addresses": ["<wallet>", "<counterparty 1>", "...", "<counterparty 99>"] }
```

### Batch composition

- The candidate list is the analyzed wallet followed by its **top 99 counterparties** in counterparty sort order (transaction count desc, total SOL desc, address asc).
- Duplicates are removed and the list is truncated to **100** addresses.
- Addresses already in the identity cache (including cached negative results) are not re-requested; only the misses are sent. If every address is cached, no request is made.

### Response handling

The response is an array of identity rows (`address`, `name`, `category`, `type`, `tags`, `unresolved`). Rows that are `unresolved`, or lack `address` or `name`, produce no label. Every requested address is cached: with its label, or with `null` when none was returned.

| Outcome | `labelSupport` | Scan continues? |
|---|---|---|
| Success | `supported` | Yes |
| `403` (plan does not include the Wallet API) | `unsupported-plan`; memoized for 10 minutes so later scans skip the call | Yes; the labeling component is excluded from the CLOAK Index and a `label-coverage` signal is emitted |
| `401` (key rejected) | — | No; the error propagates and ends the scan |
| Any other failure (timeout, 5xx after retries, schema mismatch) | `unavailable` | Yes; same treatment as `unsupported-plan` |

Counterparties beyond the top 99 are never label-checked in a scan. Second-hop neighbours in the Trace Map are labeled only if they were part of that batch.

## Health probe

`GET /api/health` calls JSON-RPC `getHealth` through the same `postJson` (timeout and retries apply):

```json
{ "jsonrpc": "2.0", "id": "ghost-health", "method": "getHealth" }
```

It reports `latencyMs` on success and the `ProviderError` code on failure. Without a key it returns `not_configured` without a network call.

## Timeouts and retries

Every provider call goes through `postJson(url, body, schema, signal)`.

| Parameter | Value |
|---|---|
| Per-attempt timeout | 12 s (`TIMEOUT_MS = 12_000`), enforced with an `AbortController` |
| Attempts | 3 (`MAX_ATTEMPTS`) |
| Backoff before attempt *n*+1 | `400 · 2^(n−1)` ms plus uniform jitter in `[0, 200)` ms, i.e. 400–600 ms after attempt 1 and 800–1000 ms after attempt 2 |
| Retried | `429`, `5xx`, per-attempt timeout, network error (including a response body that is not valid JSON) |
| Not retried | `401`, `403`, other `4xx`, schema mismatch, JSON-RPC error object, caller cancellation |
| Cancellation | The route's `req.signal` is forwarded; when the client disconnects, the in-flight attempt is aborted and `timeout` ("Request cancelled.") is raised without retry |

```ts
// lib/server/helius.ts — postJson retry decision (trimmed)
lastErr = err
if (!err.retryable || attempt === MAX_ATTEMPTS) throw err
await sleep(400 * 2 ** (attempt - 1) + Math.random() * 200)
```

Worst case for a single call is therefore about 3 × 12 s + 1.6 s. History pages are sequential, so a slow provider can push a large window past the route's 60 s `maxDuration`.

## Error mapping

`ProviderError` carries a `code`, an optional upstream `status` and a `retryable` flag. REST routes translate it with `providerErrorResponse` (`lib/server/http.ts`); the scan stream emits it as an `error` event with `retryable = err.retryable || code === 'timeout'`.

| Upstream condition | `code` | `retryable` | REST status |
|---|---|---|---|
| No key resolved | `not_configured` | false | 503 |
| HTTP 401 | `unauthorized` | false | 502 |
| HTTP 403 | `forbidden` | false | 502 (label lookups convert it to `unsupported-plan` instead) |
| HTTP 429 | `rate_limited` | true | 429 |
| HTTP ≥ 500 | `upstream` | true | 502 |
| Other non-2xx (message includes up to 200 chars of the body) | `upstream` | false | 502 |
| Response fails the Zod schema | `invalid_response` | false | 502 |
| Attempt exceeded 12 s | `timeout` | true | 504 |
| Network failure, unparseable JSON | `upstream` | true | 502 |
| Caller cancelled | `timeout` | false | 504 |
| DAS JSON-RPC `error` object | `upstream` | false | 502 |

A non-`ProviderError` exception in a REST route returns `500 internal`; in the scan stream it is reported as `upstream`. Response formats: [11-api-reference.md](11-api-reference.md); stream semantics: [10-scan-protocol.md](10-scan-protocol.md).

## Caching

All caches are instances of `TtlCache` (`lib/server/cache.ts`): an in-process `Map` with a TTL per entry and LRU eviction. On serverless platforms each function instance has its own caches; they are a latency and credit optimization, never a source of truth.

| Cache | Key | TTL | Max entries | Notes |
|---|---|---|---|---|
| History (`fetchHistory`) | `{address}:{capped}` | 60 s | 200 | Whole paginated window. A cache hit emits "Served from 60s cache" during a scan |
| History page (`fetchHistoryPage`) | `{address}:{size}:{cursor}` | 60 s | 300 | Transactions endpoint only |
| Balances (`fetchBalances`) | `{address}` | 30 s | 300 | Normalized `WalletBalances` |
| Identity (`fetchLabels`) | `{address}` | 6 h | 5000 | Stores the label or `null` (negative caching) |
| Identity-unsupported memo | process-global | 10 min | 1 | Set on `403`; while fresh, label lookups return `unsupported-plan` without a request |

Behavior:

- **LRU.** A read hit moves the entry to the most-recent position. An insert into a full cache evicts the least recently used entry. Expired entries are removed lazily when read.
- **In-flight coalescing.** `getOrSet` keeps a map of pending computations; concurrent callers for the same key await the same promise (a scan and a graph request for the same address share one history crawl). Joiners are reported as `cached: true`.
- **Failures are not cached.** Only successful computations are stored.
- **Cross-route reuse.** The summary and graph routes request `CLOAK_MAX_TX` transactions, the same key a default Terminal scan uses, so they reuse a recent scan's history on the same instance.

HTTP response cache headers are separate: `/api/scan` and `/api/health` send `no-store`; summary sends `private, max-age=30`; transactions sends `private, max-age=30` (live) or `300` (demo); graph sends `private, max-age=60`.

## Schema validation

Provider responses are validated with Zod before normalization (`lib/helius/schemas.ts`). The schemas are deliberately lenient:

- Objects use `.passthrough()`: unknown fields are kept and ignored, so additive provider changes do not break a scan (`tests/provider.test.ts`, "tolerates additive provider fields").
- Optional fields get defaults: `fee` → `0`, `transactionStatus` → `"OK"`, `nativeTransfers`, `tokenTransfers`, `instructions` → `[]`, DAS `items` → `[]`.
- Nullable/optional strings are normalized to `null`.
- `rawTokenAmount` and DAS `balance` accept a number or a numeric string.

Fields the analysis relies on are required: `signature`, `parserStatus`, `parsed.slot`, `nativeTransfers[].amount`, `tokenTransfers[].mint` and `rawTokenAmount`, `instructions[].programId`, DAS `items[].id`, and `nativeBalance.lamports` when `nativeBalance` is present.

Validation is per response, not per row: one history row missing a required field fails the whole page with `invalid_response`, which ends the scan. This is intentional; partial pages would silently distort counterparties and timing.

## Credit cost

Figures from Helius pricing as documented in October 2026; verify against current Helius pricing before relying on them.

| Call | Cost | Calls per default live scan (uncached) |
|---|---|---|
| Parsed Events history page | 10 credits per request | Up to `ceil(CLOAK_MAX_TX / 100)` (3 at the default of 300) |
| DAS `getAssetsByOwner` | Per Helius DAS pricing | 1 |
| Wallet API `batch-identity` | 100 credits per call; paid plans only | 0–1 (0 when all addresses are cached or the plan is memoized as unsupported) |
| `getHealth` | 1 credit | Health checks only (the Terminal polls `/api/health` every 60 s while open) |

A live depth-2 graph request adds up to 5 seed history requests of 50 transactions each (up to 50 credits), plus the base history and label lookup when they are not cached. This is why it is charged 3 rate-limit tokens instead of 1. Cost planning: [15-self-hosting-and-operations.md](15-self-hosting-and-operations.md).

See also: [04-normalization-model.md](04-normalization-model.md) · [10-scan-protocol.md](10-scan-protocol.md) · [11-api-reference.md](11-api-reference.md) · [15-self-hosting-and-operations.md](15-self-hosting-and-operations.md)

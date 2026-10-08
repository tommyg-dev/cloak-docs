# API reference

CLOAK exposes a small, read-only HTTP API: a health endpoint, the streaming scan, and three per-wallet read routes. This document specifies every route's request parameters, response shape, status and error codes, caching, rate-limit cost, and gives curl examples with responses captured from production.

Implementation reference: `app/api/**/route.ts`, `lib/schemas.ts` (request validation), `lib/server/http.ts` (errors, rate-limit helper, cache headers), `lib/server/rateLimit.ts`, `next.config.ts` (security headers).

## Contents

- [Base URL](#base-url)
- [Conventions](#conventions)
- [Errors](#errors)
- [Rate limiting](#rate-limiting)
- [Demo mode rule](#demo-mode-rule)
- [Security headers](#security-headers)
- [GET /api/health](#get-apihealth)
- [POST /api/scan](#post-apiscan)
- [GET /api/wallet/{address}/summary](#get-apiwalletaddresssummary)
- [GET /api/wallet/{address}/transactions](#get-apiwalletaddresstransactions)
- [GET /api/wallet/{address}/graph](#get-apiwalletaddressgraph)
- [GET /api/og/result](#get-apiogresult)
- [Route summary](#route-summary)

## Base URL

```text
https://www.getcloak.net
```

The production deployment currently has no Helius API key configured. `GET /api/health` reports `"status": "demo-only"`, and every `mode=live` request fails with `not_configured` (HTTP 503 on REST routes; an in-stream `error` event on `/api/scan`). Demo mode works. A self-hosted instance with a key serves live data ([15 — Self-hosting and operations](15-self-hosting-and-operations.md)).

## Conventions

- **Read-only.** No route writes on-chain, requests signatures, or accepts keys. There is no authentication and no user account.
- **JSON.** All responses are JSON except the `/api/scan` stream, which is NDJSON.
- **Addresses.** `{address}` (path) and `address` (body) are validated by `addressSchema`:
  1. trimmed, at most 200 characters;
  2. rejected if it looks like a secret — 12 or more alphabetic words (recovery phrase), a JSON array of 32 or more integers (byte-array key), or a base58 string longer than 80 characters that decodes to 64 bytes (secret key) — with the message `That looks like a private key or recovery phrase. CLOAK never needs secrets — paste a public wallet address only.`;
  3. must be base58 that decodes to exactly 32 bytes (32–44 characters), otherwise `Not a valid Solana public address (32-byte base58).` On-curve wallets and off-curve PDAs are both accepted.
- **Mode.** `mode` is `live` or `demo`, default `live`.
- **Timestamps.** Unix seconds in data (`timestamp`, `oldest`, `newest`); ISO 8601 strings for `fetchedAt`, `generatedAt`, `time`; epoch milliseconds for scan event `at`.
- **Amounts.** `lamports` are integers; `sol` = lamports / 10^9; token `amount` is in UI units.
- **Types.** Response bodies use the domain types in [`../reference/types.ts`](../reference/types.ts). JSON Schemas: [`../reference/ScanReport.schema.json`](../reference/ScanReport.schema.json), [`../reference/ScanEvent.schema.json`](../reference/ScanEvent.schema.json).
- **CORS.** No CORS headers are set, so browsers only allow same-origin pages to read responses. Server-side clients (curl, scripts) are unaffected.

## Errors

All non-stream errors share one envelope and are sent with `cache-control: no-store`:

```json
{ "error": { "code": "invalid_address", "message": "Not a valid Solana public address (32-byte base58)." } }
```

Some codes add fields inside `error`: `retryAfter` (seconds) for the local rate limiter, `retryable` (boolean) for provider errors.

| `code` | HTTP | Raised by | Meaning |
|---|---|---|---|
| `invalid_json` | 400 | scan | Body is not valid JSON |
| `invalid_request` | 400 | scan | Body failed validation (bad address, secret detected, bad `mode`/`limit`, unknown key). `message` is the first validation issue. |
| `invalid_address` | 400 | wallet routes | Path `{address}` failed validation |
| `invalid_query` | 400 | wallet routes | Query string failed validation |
| `demo_address_only` | 400 | all except health | `mode=demo` with an address other than the fictional demo wallet |
| `rate_limited` | 429 | all | Local per-IP limit exceeded (`retryAfter`), or the provider returned 429 after retries (`retryable: true`) |
| `not_configured` | 503 | wallet routes, scan stream | Live mode requested but no Helius key is configured |
| `unauthorized` | 502 | wallet routes, scan stream | Provider rejected the configured key (401) |
| `forbidden` | 502 | wallet routes, scan stream | Provider plan lacks the endpoint (403) |
| `timeout` | 504 | wallet routes, scan stream | Provider did not respond within 12 s on the final attempt; on the scan stream, also a cancelled request |
| `upstream` | 502 | wallet routes, scan stream | Provider 5xx, network error, other non-2xx, or JSON-RPC error |
| `invalid_response` | 502 | wallet routes, scan stream | Provider response failed schema validation |
| `internal` | 500 | wallet routes | Unexpected server error (non-provider exception) |

Status mapping for provider errors (`providerErrorResponse` in `lib/server/http.ts`):

```ts
const status =
  e.code === 'not_configured' ? 503 : e.code === 'rate_limited' ? 429 : e.code === 'timeout' ? 504
  : e.code === 'unauthorized' || e.code === 'forbidden' ? 502 : 502
return jsonError(status, e.code, e.message, { retryable: e.retryable })
```

Provider retry policy: 12 s timeout per attempt, up to 3 attempts, retries only on 429, 5xx, timeouts and network errors, exponential backoff from 400 ms with up to 200 ms jitter. On `/api/scan`, errors after the stream starts are delivered as `error` events; see [10 — Scan protocol](10-scan-protocol.md#error-semantics).

Captured examples — both from `POST /api/scan`, HTTP 400 ([`../examples/error.demo-address-only.json`](../examples/error.demo-address-only.json): a real address with `"mode":"demo"`; [`../examples/error.secret-rejected.json`](../examples/error.secret-rejected.json): a recovery phrase as `address`):

```json
{"error":{"code":"demo_address_only","message":"Demo mode only analyzes the fictional sample wallet. Switch to Live mode to analyze a real address."}}
```

```json
{"error":{"code":"invalid_request","message":"That looks like a private key or recovery phrase. CLOAK never needs secrets — paste a public wallet address only."}}
```

## Rate limiting

- **Algorithm.** Token bucket per client IP, held in memory (`RateLimiter` in `lib/server/rateLimit.ts`). Buckets start full and refill continuously.
- **Two limiters.**

| Limiter | Capacity | Refill | Used by |
|---|---|---|---|
| `scanLimiter` | `CLOAK_RATE_LIMIT_PER_MIN` (default 12) | same amount per minute | `POST /api/scan`, `GET …/graph` (shared bucket) |
| `readLimiter` | 4 × `CLOAK_RATE_LIMIT_PER_MIN` (default 48) | same amount per minute | `GET /api/health`, `GET …/summary`, `GET …/transactions` |

`CLOAK_RATE_LIMIT_PER_MIN` is clamped to 1–600.

- **Costs.**

| Request | Limiter | Cost |
|---|---|---|
| `POST /api/scan`, live | scan | 1 |
| `POST /api/scan`, demo | scan | 0.25 |
| `GET …/graph`, live, depth 1 | scan | 1 |
| `GET …/graph`, live, depth 2 | scan | 3 |
| `GET …/graph`, demo (any depth) | scan | 0.25 |
| `GET /api/health`, `…/summary`, `…/transactions` | read | 1 |

With defaults, one IP can start 12 live scans per minute, or 48 demo scans, from a full bucket.

- **Client IP.** The first entry of `x-forwarded-for`, else `x-real-ip`, else the constant `local`. Deploy behind a proxy that sets these headers (Vercel does).
- **Per-instance caveat.** Buckets live in each server instance's memory. On serverless platforms, separate instances keep separate buckets, so the effective global limit can be higher than configured. The limiter protects provider credits per instance; it is not a global quota.
- **Order of checks.** `/api/health`, `…/summary` and `…/transactions` consume a token before validating input. `/api/scan` and `…/graph` validate input and apply the demo rule first, and consume tokens only for valid requests.
- **Response.** `429` with the error envelope and `retryAfter` in seconds, computed as the time until enough tokens have refilled for the request's cost (no `Retry-After` header). Example with illustrative values:

```json
{"error":{"code":"rate_limited","message":"Too many requests. Try again in 5s.","retryAfter":5}}
```

## Demo mode rule

`mode=demo` serves only the fictional demo wallet `CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11`. Any other address with `mode=demo` is rejected with `400 demo_address_only`. CLOAK never presents fictional data under a real address. Demo responses carry `"demo": true` (REST) or `"mode": "demo"` (reports). Demo requests make no provider calls. See [14 — Demo dataset](14-demo-dataset.md).

## Security headers

Set on every path by `next.config.ts`:

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |

`poweredByHeader: false` removes `X-Powered-By`. See [12 — Security and privacy](12-security-and-privacy.md).

---

## GET /api/health

Reports service status, provider configuration and reachability, configured limits and the methodology version. Every call probes the provider with a JSON-RPC `getHealth` request when a key is configured.

**Request.** No parameters.

**Response 200**

| Field | Type | Description |
|---|---|---|
| `status` | `"ok"` \| `"degraded"` \| `"demo-only"` | `ok`: provider reachable. `degraded`: key configured but probe failed. `demo-only`: no key configured. |
| `time` | string | Server time, ISO 8601 |
| `modes.demo` | boolean | Always `true` |
| `modes.live` | boolean | `true` only when the probe succeeded |
| `provider.name` | string | `"helius"` |
| `provider.configured` | boolean | A Helius key was found (`HELIUS_API_KEY`, or an `api-key` in a Helius `HELIUS_RPC_URL` / `RPC_URL`) |
| `provider.reachable` | boolean | Probe succeeded |
| `provider.latencyMs` | number \| null | Probe round-trip time |
| `provider.error` | string \| null | Probe failure code (e.g. `not_configured`, `unauthorized`, `timeout`) |
| `limits.maxTxPerScan` | number | Effective `CLOAK_MAX_TX` |
| `limits.scansPerMinutePerIp` | number | Effective `CLOAK_RATE_LIMIT_PER_MIN` |
| `limits.graph` | object | `GRAPH_LIMITS` (see [09 — Trace Map](09-trace-map.md)) |
| `methodologyVersion` | string | `cloak-index/1.0` |

**Errors.** `429 rate_limited`.

**Caching.** `cache-control: no-store`. **Rate-limit cost.** read limiter, 1.

Because the probe uses the same retry policy as other provider calls, a degraded provider can make this endpoint slow to respond.

```bash
curl -s https://www.getcloak.net/api/health
```

Captured response ([`../examples/health.demo-only.json`](../examples/health.demo-only.json)):

```json
{
  "status": "demo-only",
  "time": "2026-10-08T15:16:30.488Z",
  "modes": { "demo": true, "live": false },
  "provider": {
    "name": "helius",
    "configured": false,
    "reachable": false,
    "latencyMs": null,
    "error": "not_configured"
  },
  "limits": {
    "maxTxPerScan": 300,
    "scansPerMinutePerIp": 12,
    "graph": {
      "maxNodes": 80,
      "maxFirstHop": 40,
      "maxSecondHopSeeds": 5,
      "secondHopPerSeed": 6,
      "secondHopTxPerSeed": 50,
      "evidencePerEdge": 4
    }
  },
  "methodologyVersion": "cloak-index/1.0"
}
```

---

## POST /api/scan

Runs a full scan and streams progress and the final `ScanReport` as NDJSON. The complete protocol (events, stages, timing, cancellation, reference client) is specified in [10 — Scan protocol](10-scan-protocol.md).

**Request body** (`scanRequestSchema`, strict — unknown keys are rejected)

| Field | Type | Required | Default | Bounds |
|---|---|---|---|---|
| `address` | string | yes | — | See [Conventions](#conventions) |
| `mode` | `"live"` \| `"demo"` | no | `"live"` | — |
| `limit` | integer | no | `CLOAK_MAX_TX` (300) | 10–500, then capped at `CLOAK_MAX_TX` |

**Response 200.** `content-type: application/x-ndjson; charset=utf-8`, `cache-control: no-store`, `x-accel-buffering: no`. One `ScanEvent` per line, ending with exactly one `result` (carrying the `ScanReport`) or `error` event.

**Pre-stream errors.** `400 invalid_json`, `400 invalid_request`, `400 demo_address_only`, `429 rate_limited`. Provider and configuration failures (including `not_configured`) arrive in-band as `error` events with HTTP status 200.

**Caching.** `no-store`. **Rate-limit cost.** scan limiter; live 1, demo 0.25. **Function limit.** 60 s.

```bash
curl -N -X POST https://www.getcloak.net/api/scan \
  -H 'content-type: application/json' \
  -d '{"address":"CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11","mode":"demo"}'
```

Captured stream (first three and last two lines; full capture in [`../examples/scan-stream.demo.ndjson`](../examples/scan-stream.demo.ndjson), as re-serialized by the capture tool):

```text
{"type": "stage", "stage": "connecting", "status": "start", "at": 1791472590037}
{"type": "stage", "stage": "connecting", "status": "done", "detail": "Demo mode · fictional dataset · no provider calls", "at": 1791472590037}
{"type": "stage", "stage": "retrieving", "status": "start", "at": 1791472590037}
...
{"type": "stage", "stage": "reporting", "status": "done", "detail": "Report GR-0URAI4F", "at": 1791472590039}
{"type": "result", "report": {"id": "GR-0URAI4F", "address": "CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11", "mode": "demo", "score": {"status": "scored", "value": 77, "band": "high"}, "…": "full ScanReport — see examples/report.demo.json"}}
```

The full report is [`../examples/report.demo.json`](../examples/report.demo.json).

---

## GET /api/wallet/{address}/summary

Balances, coverage and headline activity counts for one wallet, without scoring, signals or labels.

**Request**

| Parameter | In | Type | Default | Bounds |
|---|---|---|---|---|
| `address` | path | string | — | See [Conventions](#conventions) |
| `mode` | query | `live` \| `demo` | `live` | — |

**Behavior.** Live: fetches history (up to `CLOAK_MAX_TX` transactions) and DAS balances in parallel, normalizes and deduplicates, builds coverage and aggregates counterparties without label lookup. Demo: uses the fictional dataset.

**Response 200**

| Field | Type | Description |
|---|---|---|
| `address` | string | Analyzed address |
| `mode` | `"live"` \| `"demo"` | Mode used |
| `demo` | boolean | `true` in demo mode |
| `balances` | `WalletBalances` | SOL, holdings, provider USD values, `truncated`, `fetchedAt` |
| `coverage` | `Coverage` | Window statistics. In demo, `requestedLimit` equals the dataset size (96) and `coverage.fetchedAt` is the request time. |
| `counterpartyCount` | number | Distinct transfer counterparties ([05 — Counterparty analysis](05-counterparty-analysis.md)) |
| `interactionTypes` | `{ kind, count }[]` | Transactions per `ActivityKind`, sorted by count descending |

**Errors.** `400 invalid_address`, `400 invalid_query`, `400 demo_address_only`, `429 rate_limited`, provider errors (`503 not_configured`, `502`, `504`, `429`), `500 internal`.

**Caching.** `cache-control: private, max-age=30` (both modes). **Rate-limit cost.** read limiter, 1.

```bash
curl -s 'https://www.getcloak.net/api/wallet/CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11/summary?mode=demo'
```

Captured response ([`../examples/summary.demo.json`](../examples/summary.demo.json)), `holdings` trimmed to 3 of 6 entries:

```json
{
  "address": "CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11",
  "mode": "demo",
  "demo": true,
  "balances": {
    "address": "CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11",
    "lamports": 42371000000,
    "sol": 42.371,
    "solUsd": 6355.650000000001,
    "holdings": [
      { "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "symbol": "USDC", "name": "USD Coin", "amount": 1250.4, "decimals": 6, "usdValue": 1250.4, "kind": "fungible" },
      { "mint": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "symbol": "JUP", "name": "Jupiter", "amount": 340.2, "decimals": 6, "usdValue": 272.16, "kind": "fungible" },
      { "mint": "9FcwBK4dRAVbRR8Et8jeuqZTL3LUfCUTHFTD2W4ZtepC", "symbol": null, "name": "Fictional Collection #0412", "amount": 1, "decimals": 0, "usdValue": null, "kind": "nft" }
    ],
    "truncated": false,
    "fetchedAt": "2026-09-30T21:00:00.000Z"
  },
  "coverage": {
    "txCount": 96,
    "successCount": 93,
    "failedCount": 3,
    "oldest": 1784410918,
    "newest": 1790797664,
    "spanDays": 73.9,
    "pagesFetched": 1,
    "requestedLimit": 96,
    "limitReached": false,
    "fetchedAt": "2026-10-08T15:16:30.988Z"
  },
  "counterpartyCount": 20,
  "interactionTypes": [
    { "kind": "transfer", "count": 57 },
    { "kind": "swap", "count": 29 },
    { "kind": "program", "count": 7 },
    { "kind": "failed", "count": 3 }
  ]
}
```

---

## GET /api/wallet/{address}/transactions

One bounded page of normalized transactions, newest first, with a cursor for the next page.

**Request**

| Parameter | In | Type | Default | Bounds |
|---|---|---|---|---|
| `address` | path | string | — | See [Conventions](#conventions) |
| `mode` | query | `live` \| `demo` | `live` | — |
| `limit` | query | integer (coerced from string) | 25 | 1–100 |
| `cursor` | query | string | none | At most 200 characters matching `^[A-Za-z0-9:_-]+$` |

**Cursor semantics**

- Live: the cursor is the provider's pagination token, passed through. `nextCursor` is the token for the next page, or `null` when the page was empty or no token was returned. Treat it as opaque.
- Demo: the cursor is a decimal offset into the fictional dataset. A non-numeric cursor is treated as offset 0. `nextCursor` is `String(offset + limit)` while more items remain, else `null`.

**Response 200**

| Field | Type | Description |
|---|---|---|
| `address` | string | Analyzed address |
| `mode` | `"live"` \| `"demo"` | Mode used |
| `demo` | boolean | `true` in demo mode |
| `items` | `NormalizedTx[]` | Up to `limit` transactions ([04 — Normalization model](04-normalization-model.md)) |
| `parserErrors` | number | Live only: provider results that could not be normalized and were skipped |
| `nextCursor` | string \| null | Cursor for the next page |

Live pages are not deduplicated across pages; deduplication happens in the scan pipeline.

**Errors.** `400 invalid_address`, `400 invalid_query`, `400 demo_address_only`, `429 rate_limited`, provider errors, `500 internal`.

**Caching.** `cache-control: private, max-age=30` (live) or `private, max-age=300` (demo). Live pages are also cached in-process for 60 s per (address, size, cursor). **Rate-limit cost.** read limiter, 1.

```bash
curl -s 'https://www.getcloak.net/api/wallet/CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11/transactions?mode=demo&limit=2'
```

Captured response ([`../examples/transactions.demo.json`](../examples/transactions.demo.json)), `items` trimmed to 1 of 2:

```json
{
  "address": "CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11",
  "mode": "demo",
  "demo": true,
  "items": [
    {
      "signature": "35pZntzW6DioZBs4QXFth9KQHEAaYsXqqhpZ4ypPuDbZWZ65DsdBtGkd6LeUyaP4kwuEJkws4Jyq9J5K3C8PXjJq",
      "timestamp": 1790797664,
      "slot": 312581603,
      "feeLamports": 10000,
      "feePayer": "CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11",
      "success": true,
      "kind": "transfer",
      "summaryType": "transfer",
      "protocol": null,
      "description": "Peer transfer",
      "nativeMoves": [
        {
          "from": "CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11",
          "to": "7n6sBYjn3JUm1yoLmgWNGKDXatDDPf814nrWHHZ3Lktp",
          "lamports": 142000000
        }
      ],
      "tokenMoves": [],
      "programs": [
        { "id": "ComputeBudget111111111111111111111111111111", "name": "compute_budget" },
        { "id": "11111111111111111111111111111111", "name": "system" }
      ],
      "swap": null
    }
  ],
  "nextCursor": "2"
}
```

Next page: `?mode=demo&limit=2&cursor=2`.

---

## GET /api/wallet/{address}/graph

The observed-transfer graph (Trace Map) for one wallet, optionally with a bounded second hop. Construction rules and caps are specified in [09 — Trace Map](09-trace-map.md).

**Request**

| Parameter | In | Type | Default | Bounds |
|---|---|---|---|---|
| `address` | path | string | — | See [Conventions](#conventions) |
| `mode` | query | `live` \| `demo` | `live` | — |
| `depth` | query | integer (coerced) | 1 | 1–2 |

**Behavior.** Live: fetches up to `CLOAK_MAX_TX` transactions, aggregates counterparties, and looks up public labels for the wallet plus the first 99 counterparties. With `depth=2`, up to 5 unlabeled counterparties (`maxSecondHopSeeds`) are used as seeds and each seed's history is fetched (up to 50 transactions, `secondHopTxPerSeed`) in parallel. Labeled counterparties are never seeds. Demo: uses the fictional dataset and its fictional second-hop transactions. This route does not propagate client cancellation to provider calls.

**Response 200**

| Field | Type | Description |
|---|---|---|
| `mode` | `"live"` \| `"demo"` | Mode used |
| `demo` | boolean | `true` in demo mode |
| `graph` | `WalletGraph` | `center`, `nodes`, `edges`, `depth`, `truncated`, `limits` |

**Errors.** `400 invalid_address`, `400 invalid_query`, `400 demo_address_only`, `429 rate_limited`, provider errors, `500 internal`.

**Caching.** `cache-control: private, max-age=60`. **Rate-limit cost.** scan limiter; live depth 1: 1, live depth 2: 3, demo: 0.25. **Function limit.** 60 s.

```bash
curl -s 'https://www.getcloak.net/api/wallet/CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11/graph?mode=demo&depth=2'
```

Captured response ([`../examples/graph.depth2.demo.trimmed.json`](../examples/graph.depth2.demo.trimmed.json); the capture is trimmed to 7 nodes / 11 edges; this excerpt shows 3 nodes and 1 edge with 2 evidence entries, so the edge target is one of the omitted nodes):

```json
{
  "mode": "demo",
  "demo": true,
  "graph": {
    "center": "CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11",
    "nodes": [
      { "id": "CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11", "role": "center", "label": null, "txCount": 96, "hop": 0 },
      { "id": "7n6sBYjn3JUm1yoLmgWNGKDXatDDPf814nrWHHZ3Lktp", "role": "counterparty", "label": null, "txCount": 13, "hop": 1 },
      {
        "id": "5XuRMmAxmLo64UhyQF4jNc7sNVUCHDSwehBy5Wqvrh9K",
        "role": "counterparty",
        "label": {
          "address": "5XuRMmAxmLo64UhyQF4jNc7sNVUCHDSwehBy5Wqvrh9K",
          "name": "Demo Exchange (fictional)",
          "category": "Centralized Exchange",
          "type": "exchange",
          "source": "demo"
        },
        "txCount": 7,
        "hop": 1
      }
    ],
    "edges": [
      {
        "id": "CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11->HVqm5zhFip2XLKaibdbAQD84hRX9SKLm7DvYz577YwrN",
        "source": "CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11",
        "target": "HVqm5zhFip2XLKaibdbAQD84hRX9SKLm7DvYz577YwrN",
        "count": 11,
        "sol": 16.5,
        "tokenMoves": 0,
        "evidence": [
          { "kind": "tx", "ref": "Ci8SFjgd3k5izZ7teYJAWwyjrSSEKvinNLPMg7MTJsoWDinRhBzy9Tn5GCUW1ejLPn731nkL549xLpnfEzzACvy", "timestamp": 1790779161, "note": "Outbound transfer" },
          { "kind": "tx", "ref": "32GtSrjHTo73PoAQdpFDQ4F8pwG5Z17bxJZbi2trdPzpLKQBewqxpZFmcBdkPxN1Q1h9dX79s2isHLKm6MmfDAwP", "timestamp": 1790167590, "note": "Outbound transfer" }
        ]
      }
    ],
    "depth": 2,
    "truncated": false,
    "limits": { "maxNodes": 80, "maxSecondHopSeeds": 5, "secondHopTxPerSeed": 50 }
  }
}
```

---

## GET /api/og/result

Renders the 1200 × 630 PNG share thumbnail for a CLOAK Index result. Used as the `og:image` / `twitter:image` of `/share` pages and by the terminal's **Share result** panel. Implementation: `app/api/og/result/route.tsx` (`next/og` `ImageResponse`, Node.js runtime) with `lib/og/ResultCard.tsx`.

The route accepts **aggregate values only** — there is no parameter for an address, balance, counterparty or transaction. Parameters are validated by `shareParamsSchema` (`lib/share.ts`); if any parameter fails validation, the whole set falls back to the neutral defaults (an `INSUFFICIENT DATA` card with zero counts), so malformed links cannot inject content.

| Query | Type | Default | Meaning |
|---|---|---|---|
| `i` | integer 0–100, or `na` | `na` | CLOAK Index value; `na` renders `INSUFFICIENT DATA` |
| `b` | `low` \| `moderate` \| `elevated` \| `high` | — | Band (colours the bar and label) |
| `h`, `m`, `l` | integer 0–99 | 0 | Signal counts by severity |
| `tx` | integer 0–100000 | 0 | Transactions analyzed |
| `d` | `0` \| `1` | `0` | `1` adds a **DEMO DATA · FICTIONAL WALLET** badge |
| `v` | `cloak-index/<major>.<minor>` | `cloak-index/1.0` | Methodology version printed in the footer |

Response: `200 image/png`, `cache-control: public, max-age=86400, s-maxage=86400, immutable` (the image is a pure function of the query). Not rate-limited.

```bash
curl -o card.png "https://www.getcloak.net/api/og/result?i=77&b=high&h=4&m=5&l=0&tx=96&d=1&v=cloak-index/1.0"
```

Rendered output: [`../examples/share-card.demo.png`](../examples/share-card.demo.png).

### Share page and site thumbnail

- `GET /share?<same query>` — a public landing page for a shared result. Its `generateMetadata` sets `og:image`/`twitter:image` (card `summary_large_image`) to `/api/og/result?<query>`, so pasting the link into X, Telegram, Discord or Slack shows the result card. The page is `noindex` and states that the values come from the link and are not verified.
- `/og/cloak-share.jpg` — the static site-wide preview (a ~75 KB JPEG) used by every other page. It is a snapshot of `GET /og-source`, which renders the same card with `next/og`; the JPEG is published instead because the 480 KB PNG exceeds the preview size some chat apps accept.
- Absolute thumbnail URLs are resolved against `NEXT_PUBLIC_SITE_URL`, else Vercel's `VERCEL_PROJECT_PRODUCTION_URL`, else `http://localhost:4800`.

## Route summary

| Route | Method | Purpose | Limiter / cost | `cache-control` |
|---|---|---|---|---|
| `/api/health` | GET | Status, provider, limits | read / 1 | `no-store` |
| `/api/scan` | POST | Streaming full scan (NDJSON) | scan / live 1, demo 0.25 | `no-store` |
| `/api/wallet/{address}/summary` | GET | Balances, coverage, activity counts | read / 1 | `private, max-age=30` |
| `/api/wallet/{address}/transactions` | GET | One page of normalized transactions | read / 1 | `private, max-age=30` (live), `300` (demo) |
| `/api/wallet/{address}/graph` | GET | Trace Map graph, depth 1–2 | scan / live 1 or 3, demo 0.25 | `private, max-age=60` |
| `/api/og/result` | GET | Share thumbnail PNG (aggregate values only) | none | `public, max-age=86400, immutable` |

All error responses use `cache-control: no-store`.

See also: [10 — Scan protocol](10-scan-protocol.md) · [12 — Security and privacy](12-security-and-privacy.md) · [15 — Self-hosting and operations](15-self-hosting-and-operations.md) · [09 — Trace Map](09-trace-map.md)

# Self-hosting and operations

This document covers running CLOAK yourself: requirements, configuration, deployment to Vercel, health semantics, monitoring, multi-instance behavior of caches and rate limits, scaling the scan window, and the provider-credit cost of a scan.

## Contents

- [Requirements](#requirements)
- [Install and run](#install-and-run)
- [Scripts](#scripts)
- [Environment variables](#environment-variables)
- [Helius plan matrix](#helius-plan-matrix)
- [Deploying to Vercel](#deploying-to-vercel)
- [Health endpoint semantics](#health-endpoint-semantics)
- [What to monitor](#what-to-monitor)
- [Rate limits and caches across instances](#rate-limits-and-caches-across-instances)
- [Scaling the scan window](#scaling-the-scan-window)
- [Cost model](#cost-model)

## Requirements

| Requirement | Notes |
|---|---|
| Node.js ≥ 20 | Next.js 16 requires Node 20.9 or later. Tested on Node 24 (24.11.1). `package.json` declares no `engines` field |
| npm | A `package-lock.json` is committed; use `npm ci` for reproducible installs |
| Helius API key | Optional. Without it the deployment runs in demo-only mode |
| Outbound HTTPS | To `mainnet.helius-rpc.com` and `api.helius.xyz` (or your overrides) |

No database, cache server or background worker is required.

## Install and run

```bash
npm ci
cp .env.example .env.local     # add HELIUS_API_KEY for Live mode (optional)
npm run dev                    # http://localhost:4800
```

Without a key, the terminal's top bar shows `Live data: not configured`, live scans fail at the `connecting` stage with `not_configured`, and Demo mode works. Live mode never substitutes demo data.

Production build:

```bash
npm run build
npm start                      # next start -p 4800
```

`.env.local` and other `.env.*` files (except `.env.example`) are excluded from Vercel uploads by `.vercelignore`; keep them out of version control.

## Scripts

| Script | Command | Purpose |
|---|---|---|
| `dev` | `next dev -p 4800` | Development server on port 4800 |
| `build` | `next build` | Production build |
| `start` | `next start -p 4800` | Serve the production build on port 4800 |
| `typecheck` | `tsc --noEmit` | Type-check without emitting |
| `test` | `vitest run` | Run the Vitest suites once (37 tests in `tests/analysis.test.ts`, `tests/env.test.ts`, `tests/provider.test.ts`, `tests/score.test.ts`, `tests/share.test.ts`) |
| `test:watch` | `vitest` | Watch mode |

Tests run in a Node environment and alias `server-only` to a stub (`vitest.config.ts`), so server modules can be imported. They make no network calls.

## Environment variables

Server variables are read in `lib/server/env.ts` (`import 'server-only'`). `NEXT_PUBLIC_*` variables are inlined into the client bundle **at build time**; changing them requires a rebuild.

| Variable | Default | Bounds / parsing | Purpose |
|---|---|---|---|
| `HELIUS_API_KEY` | none | trimmed | Helius key. Required for Live mode. Highest precedence key source. Never prefix with `NEXT_PUBLIC_` |
| `RPC_URL` | none | parsed as a URL; used only if the hostname contains `helius` | **Key source only**: the `api-key` query parameter is used when neither `HELIUS_API_KEY` nor a key in `HELIUS_RPC_URL` is set. Its host is **not** used as the RPC base URL |
| `HELIUS_RPC_URL` | `https://mainnet.helius-rpc.com` | query string stripped; trailing `/` removed | RPC base for Parsed Events, DAS and `getHealth`. An embedded `?api-key=` is the second key source (hostname must contain `helius`) |
| `HELIUS_API_URL` | `https://api.helius.xyz` | trailing `/` removed | Base for the Wallet API (`/v1/wallet/batch-identity`) |
| `CLOAK_MAX_TX` | `300` | integer, floored, clamped to 50–500 | Transactions fetched per scan (pages of 100). Also the history depth for summary and graph requests |
| `CLOAK_RATE_LIMIT_PER_MIN` | `12` | integer, floored, clamped to 1–600 | Scan-bucket capacity and refill per minute per IP; the read bucket gets 4 × this value |
| `NEXT_PUBLIC_CLOAK_CA` | `null` | build-time | `$CLOAK` contract address placeholder (`lib/config/token.ts`) |
| `NEXT_PUBLIC_CLOAK_PUMPFUN_URL` | `null` | build-time | `$CLOAK` launch-page link placeholder |
| `NEXT_PUBLIC_CLOAK_DEX_URL` | `null` | build-time | `$CLOAK` DEX link placeholder |
| `NEXT_PUBLIC_CLOAK_X_URL` | `null` | build-time | `$CLOAK` community link placeholder |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:4800` | build-time | `metadataBase` for canonical and Open Graph URLs (`app/layout.tsx`) |

The `$CLOAK` token is **planned**: `TOKEN.status` is hard-coded to `'planned'`, and unset placeholders render as "To be announced". Setting the variables only fills in links; it does not enable any token utility.

**Key resolution order:** `HELIUS_API_KEY` → `api-key` in `HELIUS_RPC_URL` → `api-key` in `RPC_URL` (covered by `tests/env.test.ts`).

**Parsing gotcha.** Numeric variables fall back to the default only when the value is not a finite number. A variable that is **set but empty** parses as `0` and is clamped to the minimum: `CLOAK_MAX_TX=` gives 50 and `CLOAK_RATE_LIMIT_PER_MIN=` gives 1 request per minute. Delete unused variables instead of leaving them empty.

**Load time.** `rpcUrl`, `apiUrl`, `maxTx` and `rateLimitPerMin` are evaluated once when the module loads; `heliusKey` is read on every access. In practice every change requires a restart or redeploy.

## Helius plan matrix

| Data | Helius product | Free plan | Paid plans | CLOAK behavior when unavailable |
|---|---|---|---|---|
| Parsed transaction history | Parsed Events `POST {rpc}/v1/parsed-events/transaction-history` | Yes | Yes | Scan fails at `retrieving` with the provider error |
| SOL, tokens, NFTs | DAS `getAssetsByOwner` with `showFungible` and `showNativeBalance` | Yes | Yes | Scan fails at `retrieving` |
| Public labels | Wallet API `POST {api}/v1/wallet/batch-identity` | No (403) | Yes | `labelSupport: 'unsupported-plan'`; mapping stage reports `labels: not on this plan`; the labeling index component is excluded (not scored as zero) |
| Liveness | JSON-RPC `getHealth` | Yes | Yes | `/api/health` reports `degraded` |

A 403 from the identity endpoint is memoized for 10 minutes per instance, so Free-plan deployments do not retry it on every scan. A 401 from any endpoint (`unauthorized`, key rejected) fails the scan. Other identity errors yield `labelSupport: 'unavailable'` and the scan continues. Plan rate limits and request quotas are set by Helius; consult the Helius dashboard for your plan.

## Deploying to Vercel

1. Import the repository in Vercel (framework preset: Next.js). No `vercel.json` is needed.
2. Under **Project → Settings → Environment Variables**, add `HELIUS_API_KEY` (and any optional variables) for **Production** and **Preview**.
3. Deploy.
4. **Redeploy after changing environment variables.** Running deployments keep the values they were built and started with; `NEXT_PUBLIC_*` values are baked into the client bundle at build time.
5. **Function duration.** `/api/scan` and `/api/wallet/[address]/graph` declare `export const maxDuration = 60`. Confirm your plan permits 60-second functions. The application README recommends keeping `CLOAK_MAX_TX` at 300 or below on the Hobby plan.
6. **Deployment Protection.** If new deployments redirect visitors to a Vercel login page, turn off Deployment Protection for the project (**Settings → Deployment Protection**) or configure it to apply only to previews.

CLI alternative:

```bash
npx vercel link
npx vercel env add HELIUS_API_KEY production
npx vercel deploy --prod
```

Streaming: `/api/scan` returns `content-type: application/x-ndjson`, `cache-control: no-store` and `x-accel-buffering: no` so proxies flush each event. If you put a reverse proxy in front of a self-hosted `next start`, disable response buffering for `/api/scan`, and make sure the proxy overwrites `X-Forwarded-For` (see below).

## Health endpoint semantics

`GET /api/health` (`app/api/health/route.ts`) runs a live `getHealth` probe on every call (no caching), consumes one read-bucket token, and always returns HTTP 200 with `cache-control: no-store`.

| `status` | Condition | `modes.live` |
|---|---|---|
| `ok` | A key is configured and the `getHealth` probe succeeded | `true` |
| `degraded` | A key is configured but the probe failed (`provider.error` holds the code, e.g. `unauthorized`, `timeout`, `upstream`) | `false` |
| `demo-only` | No key is configured (`provider.error: "not_configured"`) | `false` |

`modes.demo` is always `true`. The body also reports `provider.latencyMs`, `limits` (`maxTxPerScan`, `scansPerMinutePerIp`, `graph` = `GRAPH_LIMITS`) and `methodologyVersion`. Example: [`examples/health.demo-only.json`](../examples/health.demo-only.json).

For uptime checks, assert on the JSON `status` field, not on the HTTP status code.

## What to monitor

| Signal | Where | Why |
|---|---|---|
| `/api/health` `status` | Synthetic check | `degraded` means live scans will fail |
| Scan `error` events | Client telemetry or a synthetic scan | **Scan failures are delivered inside an HTTP 200 NDJSON stream** as `{"type":"error", ...}`; HTTP-status monitoring alone will not see them |
| HTTP 429 `rate_limited` | Request logs | CLOAK's own limiter responds with `retryAfter`; a Helius rate limit surfaces with the same code but `retryable: true` and no `retryAfter` |
| HTTP 502 `unauthorized` / `forbidden` | Request logs | Key rejected or endpoint not on plan |
| HTTP 504 `timeout` | Request logs | Provider did not respond within 12 s after retries |
| Function duration near 60 s | Platform metrics | Large windows plus retries can exhaust `maxDuration` |
| `[scan]` and `[api]` error lines | Function logs | The only application logging: unexpected exceptions |
| Credit consumption | Helius dashboard | See [Cost model](#cost-model) |
| `labelSupport` distribution | Reports | `unsupported-plan` or `unavailable` reduces label coverage |

## Rate limits and caches across instances

All limiter and cache state is **in process memory** (`lib/server/rateLimit.ts`, `lib/server/cache.ts`):

| Store | Capacity | TTL |
|---|---|---|
| `scanLimiter` buckets | one per IP | capacity `CLOAK_RATE_LIMIT_PER_MIN`, refill same per minute |
| `readLimiter` buckets | one per IP | 4 × the scan values |
| History cache (`address:limit`) | 200 entries | 60 s |
| Balances cache | 300 entries | 30 s |
| Transaction-page cache | 300 entries | 60 s |
| Identity (label) cache | 5,000 addresses | 6 h |
| Identity plan-support memo | 1 value | 10 min for `unsupported-plan` |

Caches coalesce concurrent identical requests within an instance (`getOrSet` keeps an in-flight promise map) and evict least-recently-used entries. Bucket maps sweep entries idle for 10 minutes once they exceed 5,000 keys.

Consequences on serverless platforms:

- Each instance enforces its own limit; the effective global limit grows with the number of warm instances.
- A cold start begins with empty caches and full buckets.
- A Trace Map depth-2 request benefits from the scan's 60-second history cache only if it lands on the same instance.

**Client IP.** The bucket key is the first `X-Forwarded-For` entry, then `X-Real-IP`, then `local`. Vercel sets these headers. Behind your own proxy, ensure it overwrites rather than appends client-supplied `X-Forwarded-For`, or every client can pick its own key. Without any proxy headers all clients share the `local` bucket.

### Replacing `RateLimiter` with a shared store

The current class:

```ts
// lib/server/rateLimit.ts
export class RateLimiter {
  constructor(private capacity: number, private refillPerMs: number) {}
  take(key: string, cost = 1): { ok: boolean; retryAfterSec: number; remaining: number }
}
```

`take` is synchronous, and `limit()` in `lib/server/http.ts` calls it synchronously. A network-backed store (Redis, Vercel KV, Upstash) needs an asynchronous version, so the change is: make `take` return a `Promise` with the same result shape, make `limit()` async, and `await limit(...)` in each route. The bucket semantics can stay identical by running the refill-and-take step atomically in the store. A sketch using a Lua script (illustrative; any Redis client with `EVAL` works):

```ts
// Illustrative only — not part of the codebase.
const TAKE = `
local b = redis.call('HMGET', KEYS[1], 't', 'u')
local cap, rate, now, cost = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local tokens = tonumber(b[1]) or cap
local updated = tonumber(b[2]) or now
tokens = math.min(cap, tokens + (now - updated) * rate)
local ok = 0
if tokens >= cost then tokens = tokens - cost; ok = 1 end
redis.call('HSET', KEYS[1], 't', tokens, 'u', now)
redis.call('PEXPIRE', KEYS[1], 600000)
return { ok, tostring(tokens) }`

export class SharedRateLimiter {
  constructor(private redis: { eval(script: string, keys: string[], args: string[]): Promise<unknown> },
              private name: string, private capacity: number, private refillPerMs: number) {}

  async take(key: string, cost = 1) {
    const [ok, t] = (await this.redis.eval(TAKE, [`rl:${this.name}:${key}`],
      [String(this.capacity), String(this.refillPerMs), String(Date.now()), String(cost)])) as [number, string]
    const tokens = Number(t)
    return ok === 1
      ? { ok: true, retryAfterSec: 0, remaining: Math.floor(tokens) }
      : { ok: false, retryAfterSec: Math.ceil((cost - tokens) / this.refillPerMs / 1000), remaining: 0 }
  }
}
```

The TTL caches can stay per-instance: they are a latency and credit optimization, never a source of truth. Sharing them is optional.

## Scaling the scan window

`CLOAK_MAX_TX` controls how many of the most recent transactions a scan analyzes. The server fetches pages of 100 sequentially (each page needs the previous page's `paginationToken`), so:

- **Pages per scan** = ⌈min(window, available history) / 100⌉, at most 5.
- **Latency** grows roughly linearly with pages. Each page attempt has a 12 s timeout; a page that times out three times costs about 37–38 s (3 × 12 s plus backoff), which is why 500-transaction windows on slow upstreams can approach the 60 s function limit.
- **Credits** grow linearly with pages (see below).
- The client can request a smaller window with `limit` (10–500) on `POST /api/scan`, but never a larger one than `CLOAK_MAX_TX`. The terminal does not send `limit`.

Going beyond 500 requires code changes in three places (the clamp in `lib/server/env.ts`, `limit.max(500)` in `lib/schemas.ts`, and the function-duration budget) and, realistically, moving history collection out of the request into a background job. Larger windows also change the analysis inputs: see [Limitations](16-limitations.md#bounded-analysis-window).

## Cost model

Provider calls per operation (`lib/server/helius.ts`, `lib/server/scan.ts`):

| Operation | Calls | Credits per call |
|---|---|---|
| Live scan: history | ⌈transactions / 100⌉ Parsed Events pages (≤ 5) | 10 per page |
| Live scan: balances | 1 DAS `getAssetsByOwner` (page 1, limit 1000) | per Helius DAS pricing (*D* below) |
| Live scan: labels | 1 `batch-identity` request for ≤ 100 addresses, only addresses not in the 6 h label cache; paid plans | 100 per request |
| Trace Map depth 2 | history of the wallet (cache hit if same instance within 60 s, else as above) + labels (usually cached) + up to 5 second-hop histories of 50 transactions = 1 page each | 10 per page |
| `/api/health` | 1 `getHealth` | 1 |
| Demo mode (any route) | none | 0 |

Credit prices are Helius's and can change. The Parsed Events (10), identity (100) and `getHealth` (1) figures reflect Helius pricing as documented in October 2026; the DAS cost is written as *D*. Verify all of them against current Helius pricing before you budget. Each retried attempt (on 429, 5xx, timeout or network error, up to 3 attempts) is a separate request.

### Example: a 300-transaction live scan

For an address with at least 300 transactions, `CLOAK_MAX_TX=300`, cold caches:

| Item | Calculation | Credits |
|---|---|---|
| History | 3 pages × 10 | 30 |
| Balances | 1 DAS call | *D* |
| Labels (paid plan) | 1 batch request × 100 | 100 |
| **Total, paid plan** | | **130 + *D*** (140 if a DAS call costs 10 credits) |
| **Total, Free plan** | identity returns 403; memoized for 10 min | **30 + *D*** (40 if a DAS call costs 10 credits), plus whatever Helius bills for the rejected request |

Follow-ups:

- Re-scanning the same address on the same instance within 60 s costs 0 for history; within 30 s, 0 for balances; labels cached for 6 h cost 0.
- Opening the Trace Map at depth 2 adds up to 5 × 10 = **50** credits for second-hop histories, plus 30 for the wallet's history and up to 100 for labels if the request lands on a different instance or after the caches expire.
- Each visible terminal tab polls `/api/health` every 60 s: about **60 credits per hour per tab** (polling pauses while the tab is hidden).
- A 500-transaction window raises the history line to 5 pages × 10 = 50 credits.

See also: [Architecture](02-architecture.md) · [Data sources and ingestion](03-data-sources-and-ingestion.md) · [API reference](11-api-reference.md) · [Security and privacy](12-security-and-privacy.md)

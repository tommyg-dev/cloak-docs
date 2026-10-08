# Changelog

This file tracks the **CLOAK Index methodology** and the public data contracts (`ScanReport`, `ScanEvent`, the `cloak-findings` export format). Application UI changes are not listed here.

A methodology version is bumped whenever a weight, threshold, normalization formula, evaluability rule or band boundary changes, because scores produced under different versions are not comparable. Every report carries the version it was computed with in `methodologyVersion` (and `score.methodologyVersion`).

## cloak-index/1.0 — 2026-10-08

Initial public methodology. See [docs/08-cloak-index.md](docs/08-cloak-index.md).

- Seven components: Visible holdings (15), Repeated counterparties (20), Relationship concentration (15), Activity rhythm (15), Program footprint (10), Public trading (15), Public labeling (10).
- Index = weighted mean of evaluable components × 100, rounded to the nearest integer. Unevaluable components are excluded from numerator and denominator.
- `INSUFFICIENT DATA` when fewer than 10 successful, timestamped transactions are available or less than 60 % of total weight is evaluable.
- Bands: < 25 low, < 50 moderate, < 75 elevated, ≥ 75 high.
- Analysis rules: native transfers under 10,000 lamports ignored as dust; swap and liquidity legs attributed to the venue; infrastructure programs excluded from the program footprint.

## Data contracts — 2026-10-08

- `ScanEvent` stages: `connecting`, `retrieving`, `mapping`, `analyzing`, `reporting`.
- `cloak-findings/1` export format, including the full `report` object for re-import.

## Data contracts — 2026-10-08 (later)

- Share links: `/share` and `GET /api/og/result` with query keys `i, b, h, m, l, tx, d, v` (aggregate values only). See [docs/11-api-reference.md](docs/11-api-reference.md#get-apiogresult).

# Reference

| File | Description |
|---|---|
| [`types.ts`](types.ts) | The CLOAK domain model, verbatim from the application (`lib/types.ts`). Every API response and export is built from these types. |
| [`cloak-index.ts`](cloak-index.ts) | Reference implementation of the CLOAK Index (`cloak-index/1.0`), verbatim from `lib/analysis/score.ts` (import path adjusted). Pure and deterministic. |
| [`ScanReport.schema.json`](ScanReport.schema.json) | JSON Schema (draft-07) for `ScanReport`, generated from `types.ts` with `ts-json-schema-generator`. |
| [`ScanEvent.schema.json`](ScanEvent.schema.json) | JSON Schema (draft-07) for the NDJSON scan events. |

The schemas are generated, not hand-written; regenerate them after any change to `types.ts`:

```bash
npx ts-json-schema-generator@2 --path types.ts --type ScanReport --no-type-check --expose none > ScanReport.schema.json
npx ts-json-schema-generator@2 --path types.ts --type ScanEvent  --no-type-check --expose none > ScanEvent.schema.json
```

`types.ts` also exports one runtime constant, `SCAN_STAGES`, which lists the five scan stages with their display labels.

# Examples

Real responses captured from the production API (`https://www.getcloak.net`) in **demo mode** on 2026-10-08. The demo wallet `CLoAKdemo7SpecimenWa11etXXfictiona1PubKey11` is fictional: every address, signature, balance and label in these files is generated from a fixed seed and is not a real mainnet account. See [docs/14-demo-dataset.md](../docs/14-demo-dataset.md).

| File | Endpoint | Notes |
|---|---|---|
| [`scan-stream.demo.ndjson`](scan-stream.demo.ndjson) | `POST /api/scan` | Full event stream; the final `result` event's report is abbreviated |
| [`report.demo.json`](report.demo.json) | `POST /api/scan` → `result.report` | Complete `ScanReport` (validates against [`ScanReport.schema.json`](../reference/ScanReport.schema.json)) |
| [`findings-export.demo.json`](findings-export.demo.json) | Terminal → Reports → JSON | `cloak-findings/1` export; the embedded `report` field is replaced by a pointer for size |
| [`summary.demo.json`](summary.demo.json) | `GET /api/wallet/{address}/summary` | |
| [`transactions.demo.json`](transactions.demo.json) | `GET /api/wallet/{address}/transactions?limit=2` | Normalized transactions + `nextCursor` |
| [`graph.depth2.demo.trimmed.json`](graph.depth2.demo.trimmed.json) | `GET /api/wallet/{address}/graph?depth=2` | Trimmed to the subject, 3 first-hop and 3 second-hop nodes (11 edges) |
| [`health.demo-only.json`](health.demo-only.json) | `GET /api/health` | Deployment without a Helius key (`status: demo-only`) |
| [`error.secret-rejected.json`](error.secret-rejected.json) | `POST /api/scan` | A recovery phrase submitted as an address is refused |
| [`error.demo-address-only.json`](error.demo-address-only.json) | `POST /api/scan` | Demo mode refuses real addresses |
| [`share-card.demo.png`](share-card.demo.png) | `GET /api/og/result` | Share thumbnail for the demo result |

Validate the examples yourself:

```bash
npm i ajv@8
node -e '
const Ajv = require("ajv"); const fs = require("fs");
const ajv = new Ajv({ strict: false });
const v = ajv.compile(JSON.parse(fs.readFileSync("reference/ScanReport.schema.json")));
console.log(v(JSON.parse(fs.readFileSync("examples/report.demo.json"))) || v.errors);
'
```

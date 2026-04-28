# T166 perf results — 2026-04-28

**Iterations**: 30 per mode (sync + async).

| Mode | median ms | p95 ms |
|---|---|---|
| asyncReceiptPdf=true (T166 default) | 814 | 859 |
| asyncReceiptPdf=false (legacy) | 1190 | 1657 |

**Improvement (p95)**: 48.2 %

Source: `tests/perf/webhook-async-pdf-benchmark.test.ts`

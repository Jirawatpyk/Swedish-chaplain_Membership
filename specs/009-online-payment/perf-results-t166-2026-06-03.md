# T166 perf results — 2026-06-03

**Iterations**: 100 per mode (sync + async).

| Mode | median ms | p95 ms |
|---|---|---|
| asyncReceiptPdf=true (T166 default) | 867 | 922 |
| asyncReceiptPdf=false (legacy) | 1245 | 1681 |

**Improvement (p95)**: 45.2 %

Source: `tests/perf/webhook-async-pdf-benchmark.test.ts`

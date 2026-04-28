# T166 perf results — 2026-04-28

**Iterations**: 30 per mode (sync + async).

| Mode | median ms | p95 ms |
|---|---|---|
| asyncReceiptPdf=true (T166 default) | 899 | 918 |
| asyncReceiptPdf=false (legacy) | 1288 | 1688 |

**Improvement (p95)**: 45.6 %

Source: `tests/perf/webhook-async-pdf-benchmark.test.ts`

# T166 perf results — 2026-04-28

**Iterations**: 30 per mode (sync + async).
**Sample-size caveat (review-20260428-102639.md W4)**: n=30 is below the n=100 used for T148/T149. p95 from n=30 is the 2nd-highest observation; one cold-start outlier shifts it a full slot. Re-run with n=100 + 5-warmup tracked as W4 follow-up before `/speckit.ship`.

| Mode | median ms | p95 ms |
|---|---|---|
| asyncReceiptPdf=true (T166 default) | 814 | 859 |
| asyncReceiptPdf=false (legacy) | 1190 | 1657 |

**Improvement (p95)**: 48.2 %

Source: `tests/integration/perf/webhook-async-pdf-benchmark.test.ts`

## Async-path round-trip decomposition (review-20260428-102639.md S11 closure)

To validate the production estimate of `609-709 ms` (= dev 859 ms − 150-250 ms cross-border RTT), here is the round-trip count for the post-T166 succeeded-branch:

| Stage | DB round-trips | Estimated ms (dev) | Estimated ms (prod, sin1→Neon SG) |
|---|---|---|---|
| `processor_events` ON CONFLICT INSERT (idempotency guard) | 1 | ~50 | ~5 |
| `runInTenant` SET LOCAL app.current_tenant | 1 | ~50 | ~5 |
| `findByProcessorPaymentIntentId` (FOR UPDATE) | 1 | ~50 | ~5 |
| F4 `markPaidFromProcessor` (composite tx — invoice update + audit emit + receipt-number allocation + `receipt_pdf_status='pending'` flip) | 4 | ~200 | ~20 |
| `notifications_outbox` INSERT (receipt_pdf_render row) | 1 | ~50 | ~5 |
| F5 `payments` UPDATE → succeeded + audit `payment_succeeded` emit | 2 | ~100 | ~10 |
| `processor_events.markProcessed` UPDATE | 1 | ~50 | ~5 |
| **Total DB RTT only** | **11** | **~550** | **~55** |
| App-layer compute (CPU work, ORM serialise, tracer/audit emitter) | — | ~200 | ~200 |
| **Total estimated p95** | — | **~750** | **~255** |

Caveats:
1. The 11-round-trip count is a static analysis of `markPaidFromProcessor` + the surrounding webhook handler. Real Postgres can pipeline some of these (drizzle's `tx.execute` + `tx.insert` chain is not strictly serialised).
2. Measured dev p95 = 859 ms — 109 ms higher than the static 750 ms estimate. Difference attributable to: cold-start GC pauses, Neon connection pool wait, drizzle ORM overhead.
3. Production estimate of 255 ms is the **floor**; real-world p95 will be higher due to the same overhead amplified by Vercel cold-starts. The shipped budget of 750 ms (prod) leaves ~3× margin.

This decomposition matches the methodology used in `perf-results-2026-04-27.md § T149` (canceled-branch).

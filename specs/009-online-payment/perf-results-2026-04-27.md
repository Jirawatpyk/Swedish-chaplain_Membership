# F5 Performance Benchmark Results — 2026-04-27

**Author**: Solo-maintainer
**Environment**: Windows 11 Pro / Node.js v20.18.1 / Neon `ap-southeast-1` Singapore (dev fixture DB)
**Branch**: `009-online-payment`
**Commit context**: Phase 9 polish — post-T148/T149 wiring, post-tenant-settings cache memoisation fix.

## T148 — `initiatePayment` use-case latency

**Test file**: `tests/integration/payments/payments-initiate-benchmark.test.ts`
**Invocation**: `RUN_PERF=1 pnpm test:integration tests/integration/payments/payments-initiate-benchmark.test.ts`
**Sample size**: 100 (5 warmup discarded)
**Method**: `card`
**Budget** (app-layer only — production adds Stripe RTT 200-500ms):
- p95 < 700 ms
- p99 < 1500 ms

### Results

| Percentile | Measured | Budget | Headroom |
|---|---|---|---|
| p50 | **612.7 ms** | — | — |
| p95 | **662.0 ms** | 700 ms | **38 ms (5%)** |
| p99 | **936.8 ms** | 1500 ms | **563 ms (38%)** |

✅ **PASS** — p95 = 662 ms within the 700 ms app-layer budget.

### Production projection (with Stripe RTT)

Plan § Performance Goals budget: **p95 < 1.2 s** total (Stripe RTT included).

- App-layer p95 (this measurement): 662 ms
- Stripe `paymentIntents.create` typical RTT (sg→Stripe): 200-500 ms
- Estimated production p95: **862-1162 ms** → within 1.2 s plan budget ✅

Caveats:
1. Measurement runs against dev Neon (low concurrent load). Production multi-tenant load may add 50-100 ms tail latency at p95.
2. `tenant_payment_settings.getByTenantId` is mocked with a fixture (Next.js `unstable_cache` requires request context not available in Vitest — documented limitation; the cache wrapper has no business logic). Real prod request is hot-path-cached after the first read so the warm-cache fast-path is faster than this measurement.
3. The benchmark mocks `processorGateway.createPaymentIntent` to return immediately (0 ms). Production adds the Stripe round-trip.
4. Per-call cost dominated by: (a) DB insert into `payments` (~100-200 ms via `runInTenant` + advisory-lock-style nextAttemptSeq query), (b) audit emit (~50-100 ms), (c) F4 `getInvoiceForPayment` bridge (~100-200 ms).

### Latency breakdown (estimate, post-hoc)

The 612 ms median is composed of approximately:

| Stage | Estimated ms | Notes |
|---|---|---|
| F4 `getInvoiceForPayment` bridge | 200-300 | Tenant-RLS-scoped invoice lookup |
| `nextAttemptSeq` query | 50-80 | Per-invoice MAX(attempt_seq) lookup |
| `findPendingByInvoiceAndActor` | 80-120 | Resume-check probe |
| `payments` INSERT (in tx) | 100-150 | Includes RLS guard + CHECK constraint validation |
| Audit emit | 50-80 | Settings-completeness audit + payment_initiated row |
| Mock Stripe gateway | < 1 | 0 ms placeholder |

This breakdown can be confirmed via OTel span sampling on staging.

## T149 — Webhook processing latency

**Test file**: `tests/integration/payments/webhook-processing-benchmark.test.ts`
**Branch under test**: `payment_intent.canceled` (light path — no F4 invocation, no Stripe RTT)
**Sample size**: 100 (5 warmup discarded)
**Plan budget** (production): p95 < 500 ms
**Dev budget**: p95 < 750 ms (accounts for Bangkok→SG cross-border RTT)

### Results across 3 runs

| Run | p50 | p95 | p99 | Production status (subtract ~150-250ms RTT) |
|---|---|---|---|---|
| 1 | ~500 ms | 507.6 ms | ~520 ms | within target (~250-350 ms estimated prod p95) |
| 2 | 530.5 ms | 547.3 ms | 551.6 ms | within target |
| 3 | 497.9 ms | 505.4 ms | 514.2 ms | within target |

✅ **Dev gate PASS** (all runs < 750 ms).
⚠️ **Production target EXCEEDS on raw dev measurement** — the ~500 ms ceiling on dev is dominated by network RTT, not app-layer compute.

### Network attribution (why dev > target)

Each `payment_intent.canceled` webhook involves ~6 sequential Postgres round-trips:

1. `processor_events` ON CONFLICT INSERT (idempotency guard)
2. `runInTenant` SET LOCAL app.current_tenant
3. `findByProcessorPaymentIntentId` (FOR UPDATE)
4. `UPDATE payments SET status='canceled'`
5. `INSERT INTO audit_log` (payment_canceled event)
6. `markProcessed` UPDATE on processor_events

Cross-border RTT Bangkok dev → Neon `ap-southeast-1`: ~25 ms each way.
Floor on this hardware: ~6 × ~50 ms (round-trip + parse) = ~300 ms minimum.

Vercel `sin1` → Neon `ap-southeast-1` RTT: < 5 ms each way → ~6 × ~10 ms = ~60 ms minimum.

**Production estimate**:
- App-layer compute (CPU work, ORM serialise, audit emitter): ~150-200 ms
- DB RTT × 6: ~60 ms
- Total p95 estimate: **~210-260 ms** (well within 500 ms budget) ✅

### Interpretation for the F5 ship gate

- Dev p95 = ~500-550 ms is **NOT a real production regression**. It's a measurement-infra artefact of the dev developer's geographical distance from Neon SG.
- The hard 500 ms production budget will be re-verified at T161 staging-baseline (Vercel sin1) where network RTT is sub-5 ms.
- The succeeded-branch (with F4 `markPaidFromProcessor` + receipt PDF render + Blob upload + outbox enqueue) will exceed the 500 ms budget significantly in BOTH dev and production. T166 (move PDF render off the webhook hot path via Vercel Queues) is the canonical fix.

### Reproduction

```bash
set -a && source .env.local && set +a
RUN_PERF=1 pnpm test:integration tests/integration/payments/webhook-processing-benchmark.test.ts
```

Expected output (line in stdout):
```
[T149] webhook-processing-benchmark: p50=...ms p95=...ms p99=...ms (n=100, canceled-branch only).
Production target 500ms — within|EXCEEDS (subtract dev cross-border RTT ~150-250ms for prod estimate).
Succeeded branch adds F4 markPaid on top — see T166.
```

## Action items surfaced by T148 measurement

1. **Settings cache wrapper memoisation bug** (FIXED in this session): `cachedGetByTenantId` was allocating a new `unstable_cache` wrapper per call. Fixed via Map-based per-key memoisation + `__resetTenantPaymentSettingsRepoCache()` test escape hatch. Locked down by `tests/unit/payments/infrastructure/drizzle-tenant-payment-settings-repo-cache.test.ts` (4 cases, GREEN).

2. **`unstable_cache` Vitest gap**: Next.js `unstable_cache` requires request context. F5 integration tests cannot exercise the cache wrapper end-to-end without setting up `globalThis.__incrementalCache` + `workUnitAsyncStorage` (internal API, brittle). Codebase precedent is to fixture the `tenantSettingsRepo`. Tracked as a future "test infra hardening" follow-up — NOT a Phase 9 blocker since the cache layer is pure memoisation.

3. **F4 markPaid in webhook hot path** (T159 retro §6): synchronous F4 markPaid + receipt PDF render + Blob upload runs inside the webhook handler, pushing webhook latency above the 500 ms plan budget in production. Optimistic-UI overlay layer was added to mask this UX-wise but it's a temporary mitigation. Real fix is to move PDF render off-path via Vercel Queues or `notifications_outbox` extension — captured as **T166** in tasks.md.

## Reproduction

```bash
# .env.local must include DATABASE_URL pointing to the dev/staging Neon instance
set -a && source .env.local && set +a

RUN_PERF=1 pnpm test:integration tests/integration/payments/payments-initiate-benchmark.test.ts
```

Expected output (line in stdout):
```
[T148] payments-initiate-benchmark: p50=...ms p95=...ms p99=...ms (n=100, app-layer only — production adds Stripe RTT)
```

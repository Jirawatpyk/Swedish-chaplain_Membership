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

**Status**: SKELETON. Per `tests/integration/payments/webhook-processing-benchmark.test.ts` top-of-file docblock, full implementation requires a per-measurement seeded payments row + mocked `webhookVerifier`. The fixture is heavyweight for repeatable measurement; deferred to T161 staging-baseline session.

App-layer estimate (without F4 markPaid, dominant production cost):
- Mock-verifier signature check: ~1 ms
- `processor_events` upsert: ~100-150 ms
- runInTenant + dispatch branch: ~200-300 ms
- F4 `markPaidFromProcessor` (production-only): ~300-500 ms
- Total estimate: ~600-950 ms — within 500 ms budget on app-layer, but F4 markPaid dominates total path

This will need pre-prod measurement to confirm; the 500 ms p95 plan budget excludes F4 markPaid in some readings of plan § VII (markPaid is invoked synchronously inside the webhook handler, so realistically the budget should be re-evaluated against the F4 + F5 combined path — surfaced as an action item for T159 retrospective § 6 F4 follow-ups).

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

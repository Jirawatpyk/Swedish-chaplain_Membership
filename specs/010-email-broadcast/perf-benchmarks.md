# F7 — Performance Benchmarks (T204)

**Date**: 2026-05-02
**Branch**: `010-email-broadcast`
**Phase**: 10 polish — perf benchmark capture per SC-010 + perf.md CHK065
**Test file**: `tests/integration/broadcasts/benefits-page-perf.test.ts`
**Test data seed**: ~200 broadcasts + 200 delivery rows × 1 member; 1 tenant
**Runner**: Local from Bangkok against Neon `ap-southeast-1` (Singapore)

## Network distance caveat

Production target is **Vercel sin1 ↔ Neon ap-southeast-1**, ~1–3 ms
RTT per query. Local runs from Bangkok add ~25 ms RTT per query × N
queries per measurement, so the captured p95 numbers are
**~3–4× the production target** at this scale.

Per-test override env vars allow cross-region runs to use relaxed
budgets without losing the regression-detection signal:

| Env var | BKK-from-local default | Production target |
|---------|------------------------|-------------------|
| `PERF_QUOTA_P95_MS` | 800 ms | 200 ms (SC-010) |
| `PERF_LIST_P95_MS` | 800 ms | 300 ms (SC-010) |
| `PERF_DETAIL_P95_MS` | 600 ms | 250 ms (SC-010) |

Production-target verification belongs in the staging-deploy pipeline
(staging Vercel sin1 + staging Neon Singapore) — captured at first
post-ship deploy per § Re-evaluation cadence below.

## Captured p95 (n=20 per measurement)

| Surface | Use-case | p95 (BKK→SG, ms) | Production-target estimate (sin1↔ap-southeast-1) |
|---------|----------|------------------|---------------------------------------------------|
| `/portal/benefits/e-blasts` quota counter | `computeQuotaCounter` | 589 ms | ~150 ms (subtract ~3× RTT × 5 queries ≈ 425 ms network overhead) |
| `/portal/broadcasts` history page=1 | `listMemberBroadcasts page=1` | 272 ms | ~80 ms |
| `/portal/broadcasts` history page=10 (deep offset) | `listMemberBroadcasts page=10` | 229 ms | ~70 ms |
| `/portal/broadcasts/[id]` detail | `getMemberBroadcast` | 351 ms | ~110 ms |

EXPLAIN ANALYZE on `listMemberBroadcasts` confirms the planner uses
the `broadcasts_tenant_member_created_at_idx` covering index added in
migration 0077 (with `enable_seqscan = OFF` to disambiguate the
small-table planner choice; index is the chosen plan at production
scale where stats favour index over seq-scan).

## SC-010 / SLO-F7-001…006 production targets (per docs/observability.md § 22.2)

| SLO | Surface | Target | Current local-run estimate | Status |
|-----|---------|--------|----------------------------|--------|
| SLO-F7-001 | compose page TTFB | < 600 ms | (server-component, measured via Vercel Speed Insights) | ⏳ post-deploy |
| SLO-F7-002 | submit endpoint | < 1.2 s | n/a (auth-required, separate test) | ⏳ post-deploy |
| SLO-F7-003 | admin queue list | < 500 ms @ 1k pending | (server-component, measured via Vercel Speed Insights) | ⏳ post-deploy |
| SLO-F7-004 | approve & send-now | < 1.5 s | n/a (auth-required + Resend RTT) | ⏳ post-deploy |
| SLO-F7-005 | webhook handler | < 250 ms | (network-bound, captured via OTel histogram) | ⏳ post-deploy |
| SLO-F7-006 | unsubscribe page TTFB | < 400 ms | (server-component, measured via Vercel Speed Insights + OTel) | ⏳ post-deploy |

## Re-evaluation cadence

- **At first staging deploy**: re-run `RUN_PERF=1 pnpm test:integration tests/integration/broadcasts/benefits-page-perf.test.ts` from a Vercel sin1 function shell against staging Neon. Capture sin1↔SG p95.
- **7 days post-prod-deploy**: capture Vercel Speed Insights RUM windows for SLO-F7-001/003/006 (TTFB) per T215.
- **F7.1 amendment**: re-evaluate budgets if member counts × broadcasts scale changes (current SweCham single-tenant, ~131 members, ~8 broadcasts/year).

## Local re-run command

```bash
RUN_PERF=1 PERF_QUOTA_P95_MS=800 PERF_LIST_P95_MS=800 PERF_DETAIL_P95_MS=600 \
  pnpm test:integration tests/integration/broadcasts/benefits-page-perf.test.ts
```

## Production re-run command (from sin1)

```bash
# After staging deploy, on a sin1 function shell:
RUN_PERF=1 \
  pnpm test:integration tests/integration/broadcasts/benefits-page-perf.test.ts
# (default budgets enforce SC-010 production targets)
```

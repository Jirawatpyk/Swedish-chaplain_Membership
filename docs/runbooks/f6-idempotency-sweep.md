# F6 Idempotency Sweep Stalled — Runbook

**Alert source**: SLO-F6-004 violation — `eventcreate_idempotency_sweep_rows_total` counter has not incremented in 25 hours (expected daily 04:00 Asia/Bangkok run)
**Severity**: P2
**Last reviewed**: 2026-05-17 (Phase 10 T131 alert #6)

## Symptoms

- Daily idempotency-sweep cron job has not emitted its expected aggregate audit (`eventcreate_idempotency_sweep_rows_total{outcome=swept}` counter flat).
- `eventcreate_idempotency_receipts` row count growing past expected steady-state (~7 days × tenant request rate).
- Postgres slow-query log may show `tenant_id, source, request_id` PK contention.

## Root causes

1. **cron-job.org silently disabled** — external coordinator unsubscribed / suspended.
2. **CRON_SECRET rotation mismatch** — env var rotated but cron-job.org dashboard not updated → 401 on every call.
3. **Vercel deployment URL changed** — preview deployment was used in cron-job.org URL; promoted to production but cron still hits the stale URL.
4. **Sweep handler timeout** — cron handler hit Vercel function timeout (>60s) before completing.
5. **RLS/permission regression** — recent migration broke `chamber_app` role's DELETE permission on `eventcreate_idempotency_receipts`.

## Triage steps

1. **Check cron-job.org execution log**: `https://console.cron-job.org` → find `sweep-eventcreate-idempotency` entry → review last 7 days of runs. If all 401 → cause (2). If 0 runs → cause (1). If 504 → cause (4).
2. **Verify Bearer auth**: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://swecham.zyncdata.app/api/internal/retention/sweep-eventcreate-idempotency` → expect 200 with `{ok: true, swept: N}`. 401 → cause (2). 500 → cause (5).
3. **Inspect receipt table size**: `SELECT COUNT(*), MIN(ttl_expires_at), MAX(ttl_expires_at) FROM eventcreate_idempotency_receipts`. If MIN is > 14 days old → sweep hasn't run for that long.
4. **Test manually**: trigger one sweep run via the curl above. If success → confirm cron-job.org entry, possibly cause (3).
5. **Check RLS**: as `chamber_app` role, `SET LOCAL app.current_tenant='test-swecham'; DELETE FROM eventcreate_idempotency_receipts WHERE tenant_id='test-swecham' AND ttl_expires_at < NOW();` — must succeed.

## Mitigations

| Cause | Action |
|---|---|
| (1) Disabled | Re-enable in cron-job.org dashboard. |
| (2) Auth mismatch | Update cron-job.org with new CRON_SECRET. |
| (3) Stale URL | Update cron-job.org URL to production canonical (per `docs/runbooks/cron-jobs.md`). |
| (4) Timeout | Inspect handler logs. If receipt count > 100k, the daily sweep needs batching. Open backlog issue + run manual sweep with smaller window: `?maxRows=5000`. |
| (5) RLS regression | Identify offending migration. `psql` as superadmin → grant DELETE back to `chamber_app`. File bug. |

## Verification

- Trigger manual sweep → confirm `eventcreate_idempotency_sweep_rows_total{outcome=swept}` counter increment.
- Watch next scheduled run (next 04:00 Asia/Bangkok) → confirm runs autonomously.
- Receipt table size returns to steady-state within 24-48 hours.

## Escalation

- **3 days stalled** + receipt-table size > 500k rows → P1 (idempotency-table bloat risks INSERT performance regression on webhook ingest path).

# Runbook — External Cron Triggers (cron-job.org)

**Severity**: WARN (any individual job stalled > 30 min); ALARM (≥ 2 jobs simultaneously stalled)
**Owner**: Platform on-call
**Scope**: This file is the **index / configuration reference** for every
external cron trigger driving Chamber-OS. Per-job operational playbooks
(symptoms, on-call response) live in their own runbooks linked below.

## Why cron-job.org instead of Vercel Cron

The SweCham deployment runs on Vercel Hobby plan, which **rate-limits
native `vercel.json` crons to once-per-day per project**. Several
Chamber-OS features need 5-minute cadence (F5 stale-pending detection,
F7 scheduled-broadcast dispatch). To keep these features functional
without forcing a Pro upgrade we trigger them from
[cron-job.org](https://cron-job.org), which:

- Supports cron expressions down to 1-minute granularity (free tier)
- Sends Bearer-authenticated HTTP GET to our internal endpoints
- Alerts via email on consecutive failures
- Has an attempt-history view useful for forensics

Native Vercel Cron `vercel.json` entries are intentionally **NOT** added
for these endpoints — see § "Migration path: Pro plan" below.

## Job catalogue

| Job | Endpoint | Cadence | Auth | Detail runbook |
|-----|----------|---------|------|----------------|
| F5 stale-pending-count | `GET /api/internal/metrics/stale-pending-count` | `*/5 * * * *` | `Authorization: Bearer ${CRON_SECRET}` | [stale-pending-count.md](./stale-pending-count.md) |
| F5 stale-refund sweep | `POST /api/cron/sweep-stale-pending-refunds` | `0 3 * * *` (native Vercel) | `Authorization: Bearer ${CRON_SECRET}` | [stale-pending-refund-sweep.md](./stale-pending-refund-sweep.md) |
| F4 outbox purge | `POST /api/cron/outbox-purge` | `15 20 * * *` (native Vercel) | `Authorization: Bearer ${CRON_SECRET}` | (in `vercel.json`) |
| F4 receipt-pdf reconcile | `POST /api/internal/cron/receipt-pdf-reconcile` | `30 3 * * *` (native Vercel) | `Authorization: Bearer ${CRON_SECRET}` | [receipt-pdf-permanently-failed.md](./receipt-pdf-permanently-failed.md) |
| **F7 broadcasts dispatch** | **`POST /api/cron/broadcasts/dispatch-scheduled`** | **`*/5 * * * *`** | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F7) |

**Daily-cadence jobs** stay in `vercel.json` (the 1×/day limit
accommodates them). **5-minute-cadence jobs** are mandatory cron-job.org
externals on Hobby.

## F7 — broadcasts/dispatch-scheduled (NEW — F7 ship)

Dispatches scheduled E-Blast broadcasts whose `scheduled_for <= NOW()`
and `status='approved'`. Expected recipient cap per tick: ≤ 5,000
recipients per broadcast (FR-016a) × N broadcasts due in the window.

### Setup steps (one-time, reproducible)

1. Sign in to https://cron-job.org with the SweCham ops account
   (credentials in 1Password vault: `swecham/cron-job-org`).
2. Create new cron-job:
   - **Title**: `Chamber-OS · broadcasts.dispatch-scheduled`
   - **URL**: `https://swecham.zyncdata.app/api/cron/broadcasts/dispatch-scheduled`
   - **Schedule**: `*/5 * * * *` (every 5 minutes, UTC)
   - **Request method**: POST
   - **Headers**:
     - `Authorization: Bearer <CRON_SECRET>` — value reused from F4/F5
       (single shared secret; rotate via the procedure in § "Secret
       rotation" below)
   - **Notifications**: enable email on failure (3 consecutive failures
     → maintainer email)
   - **Timeout**: 60 seconds (broadcast dispatch may issue several
     Resend Broadcasts API calls; the route handler is bounded by the
     dispatch loop's per-broadcast watchdog).
   - **Save attempt history**: 100 most recent (default)
3. Click **Run** to verify a 200 OK response with payload:

   ```json
   { "ok": true, "dispatched": N, "skipped": M, "stuckSendingDetected": K, "timestamp": "..." }
   ```

   - `dispatched` — broadcasts that transitioned `approved → sending`
     this tick
   - `skipped` — broadcasts due-but-blocked (e.g. tenant kill-switch,
     concurrent dispatch holding the advisory lock — both expected)
   - `stuckSendingDetected` — broadcasts sitting in `status='sending'`
     for > 24h; emit `broadcast_resend_resource_missing` audit event
     for ops follow-up. ≥1 should escalate to
     [broadcasts-stuck-sending runbook](./broadcasts-stuck-sending.md)
     (authored at T032).

4. Confirm the dispatch metric increments in Vercel OTel telemetry
   within 5 minutes (`broadcasts.cron.dispatched` counter).

### Expected response codes

| Status | Meaning | Action |
|--------|---------|--------|
| 200 | Normal dispatch tick (zero or more broadcasts handled) | None — expected |
| 202 | Tick in progress (advisory lock held by overlapping run) | None — next tick will catch up |
| 503 | `FEATURE_F7_BROADCASTS=false` (kill-switch active) | If intentional, suppress alerting; otherwise escalate to feature owner |
| 401 | `Authorization` header missing/invalid | Check cron-job.org headers UI; rotate secret if leaked |
| 5xx | Internal error (DB outage, Resend down, app crash) | Inspect Vercel logs; consult [broadcasts-dispatch-failure.md](./broadcasts-dispatch-failure.md) |

### Why POST not GET

The F7 endpoint mutates DB state (transitions broadcast rows from
`approved → sending` and emits audit events). REST convention
reserves GET for safe/idempotent reads. `cron-job.org` supports both;
choose POST per HTTP semantics.

## Secret rotation

`CRON_SECRET` is a single shared secret across F4 + F5 + F7
cron-driven endpoints. Rotation procedure (zero downtime):

1. Generate new secret: `openssl rand -base64 48`
2. `vercel env add CRON_SECRET <new-value> production`
3. Redeploy production (the new env value loads at boot)
4. Update **every** cron-job.org job's Bearer header in the headers UI
   (currently 2 jobs: F5 stale-pending-count and F7 dispatch-scheduled
    — see catalogue above)
5. Click **Run** on each updated job to confirm 200 OK
6. After 1 hour of clean runs, optionally: `vercel env rm
   CRON_SECRET_OLD production` if you kept the old value as a fallback

Native Vercel Cron entries automatically pick up the new value via
their `Authorization` header — no UI action needed.

## Recreating after cron-job.org account loss

If the cron-job.org account is lost, every 5-minute-cadence cron
**stops firing silently** — Vercel does not synthesise a fallback.
Symptoms surface at:

- F5: `payments.stale_pending_count` gauge stays at 0 → alert won't
  fire on stuck payments
- F7: scheduled broadcasts pile up in `status='approved' AND
  scheduled_for < NOW()` and never dispatch → member-facing complaint

Recovery:

1. Create a new cron-job.org account (free tier sufficient).
2. Re-run the per-job setup steps in this runbook + linked detail
   runbooks for each job in the catalogue table above.
3. Within 6 minutes confirm metric/audit increment.
4. Audit the gap window: `SELECT * FROM broadcasts WHERE status =
   'approved' AND scheduled_for < NOW();` — manually trigger
   dispatch via the endpoint if backlog is non-empty.

## Migration path: Pro plan

When SweCham upgrades to Vercel Pro the following changes ship:

1. Add `vercel.json` cron entries at `*/5 * * * *` for each
   currently-external job (F5 stale-pending-count, F7 dispatch).
2. Disable the corresponding cron-job.org jobs (do NOT delete — keep
   as standby in case Pro plan limits change again).
3. Update this runbook's catalogue table.
4. Re-run smoke tests for each affected runbook.

The route handlers are unchanged. The Bearer-auth pattern continues
to work — Vercel Cron supplies the same `Authorization: Bearer
${CRON_SECRET}` header.

## Owner

Platform on-call (default: maintainer). Per-feature ownership escalates
via the linked detail runbooks for the affected job.

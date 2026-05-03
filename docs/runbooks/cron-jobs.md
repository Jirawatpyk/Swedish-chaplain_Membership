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
| **F7 broadcasts dispatch** | **`POST /api/cron/broadcasts/dispatch-scheduled`** | **`*/5 * * * *`** | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F7 dispatch) |
| **F7 reconcile-stuck-sending** | **`POST /api/cron/broadcasts/reconcile-stuck-sending`** | **`*/15 * * * *`** | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F7 reconcile) |
| **F7 prune-expired-drafts** | **`POST /api/cron/broadcasts/prune-expired-drafts`** | **`30 4 * * *`** (daily 04:30 UTC) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F7 prune-drafts) |
| **F7 broadcasts gauges** (T172) | **`GET /api/internal/metrics/broadcasts-gauges`** | **`*/5 * * * *`** | **`Authorization: Bearer ${CRON_SECRET}`** | emits `broadcasts.queue_pending` + `broadcasts.stuck_sending_count` gauges per tenant |
| **F8 renewal dispatch (coordinator)** | **`POST /api/cron/renewals/dispatch-coordinator`** | **`0 6 * * *`** (daily 06:00 Asia/Bangkok) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F8 dispatch) |
| **F8 at-risk recompute (coordinator)** | **`POST /api/cron/renewals/at-risk-recompute-coordinator`** | **`0 2 * * 0`** (Sun 02:00 Asia/Bangkok) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F8 at-risk) |
| **F8 tier-upgrade evaluate (coordinator)** | **`POST /api/cron/renewals/tier-upgrade-evaluate-coordinator`** | **`0 3 * * 0`** (Sun 03:00 Asia/Bangkok) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F8 tier-upgrade) |
| **F8 reconcile-pending-reactivations (coordinator)** | **`POST /api/cron/renewals/reconcile-pending-reactivations-coordinator`** | **`0 7 * * *`** (daily 07:00 Asia/Bangkok) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F8 reconcile-reactivations) |
| **F8 prune consumed link tokens** | **`POST /api/cron/renewals/prune-consumed-tokens`** | **`0 4 * * 6`** (Sat 04:00 Asia/Bangkok) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F8 token prune) |
| **F8 reconcile pending tier-upgrades** | **`POST /api/cron/renewals/reconcile-pending-applications`** | **`0 5 * * 6`** (Sat 05:00 Asia/Bangkok) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F8 reconcile-tier-upgrades) |

**Daily-cadence jobs** stay in `vercel.json` (the 1×/day limit
accommodates them). **5-minute-cadence jobs** are mandatory cron-job.org
externals on Hobby.

## Retry policy contract (READ BEFORE CONFIGURING ANY F7 JOB)

cron-job.org defaults to **retry-on-non-2xx with exponential backoff**.
For F7 jobs, **disable failure-retry** in the cron-job.org config —
both endpoints distinguish "harness should retry" from "operator
should look but harness MUST NOT retry":

| HTTP code | Meaning | Operator action |
|-----------|---------|-----------------|
| 200 + `gateway_error > 0` in body | Resend outage. Per-row reconcile already done idempotently. Next 15-min tick is the natural retry. | Check Resend status page; alert pipeline pages on the dedicated `cron.broadcasts.reconcile.gateway_outage` log channel |
| 500 + `uncaught_error > 0` | Programmer bug or transient DB blip | Harness MAY retry; investigate next morning if persistent |
| 500 + `server_error > 0` | Use-case Result.err (transition guard, RLS probe, etc.) | Harness MAY retry; investigate stack trace in logs |
| 401 | Bearer token mismatch | Rotate `CRON_SECRET`; reconfigure cron-job.org headers |
| 503 | `FEATURE_F7_BROADCASTS=false` | Expected during dark-launch; do nothing |

**Why disable failure-retry**: cron-job.org's default retry storm
(every 30s for 1 hour) on a 500 response would hammer the endpoint
during a Resend outage. The 15-min cadence already provides natural
retry; the 500 status is purely a dashboard-paint-red signal.

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

## F7 — broadcasts/prune-expired-drafts (NEW — F7 US6 / Phase 8)

Daily housekeeping cron deleting `broadcasts WHERE status='draft' AND
updated_at < NOW() - INTERVAL '30 days'` per FR-001a (US1 AS3 draft
restoration window). Drafts are user-controlled scratch space; pruning
emits NO audit event (preserves the FR-001 "drafts do NOT consume or
reserve quota" invariant).

Members are NOT notified of impending draft expiry in MVP — a "your
draft will expire in N days" toast remains in scope for a future
polish iteration but is intentionally not part of F7 MVP.

### Setup steps (one-time, reproducible)

1. Sign in to https://cron-job.org with the SweCham ops account.
2. Create new cron-job:
   - **Title**: `Chamber-OS · broadcasts.prune-expired-drafts`
   - **URL**: `https://swecham.zyncdata.app/api/cron/broadcasts/prune-expired-drafts`
   - **Schedule**: `30 4 * * *` (every day at 04:30 UTC = 11:30 ICT —
     low-traffic window for SweCham; chosen to avoid overlapping with
     the 5-min dispatch tick boundary). Schedule is **flexible** — the
     30-day cutoff has 24h tolerance so a missed daily tick is not a
     correctness issue (next tick catches up).
   - **Request method**: POST
   - **Headers**:
     - `Authorization: Bearer <CRON_SECRET>` — value reused from F4/F5/F7-other
   - **Notifications**: enable email on consecutive failures (3 → maintainer
     email)
   - **Timeout**: 30 seconds (single tenant DELETE statement; expected
     row count well under 1k for SweCham scale)
   - **Disable failure-retry** per § "Retry policy contract" — daily
     cadence is the natural retry; a missed day is not a blocker.
3. Click **Run** to verify a 200 OK response with payload:

   ```json
   {
     "tenantId": "swecham",
     "prunedCount": 0,
     "cutoff": "2026-04-02T04:30:00.000Z",
     "durationMs": 42
   }
   ```

   - `prunedCount: 0` is the expected steady state (drafts older than
     30 days are rare on a healthy deployment)
   - `cutoff` is the timestamp threshold passed to the DELETE; sanity
     check that it is exactly 30 days before the request time
   - `durationMs` should stay under 1s; if it climbs, investigate
     missing index or unbounded draft growth

### On-call response

| HTTP code | Meaning | Operator action |
|-----------|---------|-----------------|
| 200 + `prunedCount: 0` | Healthy steady state | None |
| 200 + `prunedCount > 100` | Unusual draft churn — investigate which member is creating drafts that age out | Query `SELECT requested_by_member_id, COUNT(*) FROM broadcasts WHERE status='draft' GROUP BY 1 ORDER BY 2 DESC LIMIT 10` for outliers |
| 500 + body contains `prune.server_error` | DB outage or RLS misconfiguration. Drafts NOT pruned this tick. | Investigate next morning; harness will retry on next daily tick — no action needed within 24h |
| 503 | `FEATURE_F7_BROADCASTS=false` | Expected during dark-launch; do nothing |
| 401 | Bearer token mismatch | Rotate `CRON_SECRET`; reconfigure cron-job.org headers |

## Secret rotation

`CRON_SECRET` is a single shared secret across F4 + F5 + F7
cron-driven endpoints. Rotation procedure (zero downtime):

1. Generate new secret: `openssl rand -base64 48`
2. `vercel env add CRON_SECRET <new-value> production`
3. Redeploy production (the new env value loads at boot)
4. Update **every** cron-job.org job's Bearer header in the headers UI
   — see the job catalogue table at the top of this file for the
   complete list (currently 4 jobs: F5 stale-pending-count, F7
   dispatch-scheduled, F7 reconcile-stuck-sending, F7
   prune-expired-drafts). Verify the catalogue is up-to-date before
   rotation; missing one cron job mid-rotation causes ≤5min outage.
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

## F8 — renewals/dispatch-coordinator (NEW — F8 Phase 4)

Coordinator endpoint that fans out per-tenant renewal-reminder dispatch (per
research.md R14). For each active tenant the coordinator parallel-fetches
`/api/cron/renewals/dispatch/[tenantId]`; each per-tenant invocation runs in
its own Vercel function 300s budget. Bearer-auth via shared `CRON_SECRET`
(rotated atomically across F4/F5/F7/F8 per R17). Emits
`cron_dispatch_orchestrated` audit; per-tenant fault isolation; SaaS-scale
ready (50+ tenants).

### Setup steps (one-time)

1. Sign in to https://cron-job.org with the SweCham ops account.
2. Create new cron-job:
   - **Title**: `Chamber-OS · F8 renewal-dispatch coordinator`
   - **URL**: `https://swecham.zyncdata.app/api/cron/renewals/dispatch-coordinator`
   - **Schedule**: `0 6 * * *` (daily 06:00 Asia/Bangkok = 23:00 UTC prior day)
   - **Method**: POST
   - **Headers**: `Authorization: Bearer <CRON_SECRET>` (copy from Vercel env)
   - **Timeout**: 60 seconds
3. Click **Run** to verify 200 OK with payload:
   ```json
   { "skipped": false, "tenants_enqueued": N, "tenants_succeeded": N, "tenants_failed": 0, "duration_ms": <small> }
   ```

## F8 — renewals/at-risk-recompute-coordinator (NEW — F8 Phase 6)

Weekly batch-recompute of member at-risk scores (8-factor formula per FR-029
+ FR-029a F6-readiness fallback). Per-tenant fan-out same as dispatch
coordinator. Emits `at_risk_score_recomputed` per member + threshold-crossing
audits.

### Setup steps

Same pattern as dispatch coordinator with these differences:
- **Title**: `Chamber-OS · F8 at-risk recompute coordinator`
- **URL**: `.../api/cron/renewals/at-risk-recompute-coordinator`
- **Schedule**: `0 2 * * 0` (Sun 02:00 Asia/Bangkok)
- **Timeout**: 60 seconds (per-tenant SLO ≤60s @ 5k members per FR-036)

## F8 — renewals/tier-upgrade-evaluate-coordinator (NEW — F8 Phase 7)

Weekly evaluation of tier-upgrade eligibility per F2 plan thresholds
(`declared_turnover_thb_min`, `lifetime_invoice_thb_min`). Creates
`tier_upgrade_suggestions` rows for objective candidates + emits
`tier_upgrade_suggested` audit.

### Setup steps

- **Title**: `Chamber-OS · F8 tier-upgrade evaluate coordinator`
- **URL**: `.../api/cron/renewals/tier-upgrade-evaluate-coordinator`
- **Schedule**: `0 3 * * 0` (Sun 03:00 Asia/Bangkok — 1h after at-risk)
- **Timeout**: 30 seconds (per-tenant SLO ≤30s @ 5k members per FR-057)

## F8 — renewals/reconcile-pending-reactivations-coordinator (NEW — F8 Phase 5)

Daily T-7/T-3/T-1 reminder ladder + 30d auto-timeout for cycles in
`pending_admin_reactivation` state per FR-005c. Auto-cancels timed-out cycles
+ triggers F5 refund + F4 credit-note creation atomically. Emits
`lapsed_member_admin_reactivation_reminder_t-7/-3/-1` and
`lapsed_member_admin_reactivation_timed_out` audits.

### Setup steps

- **Title**: `Chamber-OS · F8 reconcile-pending-reactivations coordinator`
- **URL**: `.../api/cron/renewals/reconcile-pending-reactivations-coordinator`
- **Schedule**: `0 7 * * *` (daily 07:00 Asia/Bangkok — 1h after dispatch)
- **Timeout**: 30 seconds (small dataset; partial-index scan)

## F8 — renewals/prune-consumed-tokens (NEW — F8 Phase 9)

Weekly housekeeping: deletes rows from `consumed_link_tokens` table where
`consumed_at < now() - interval '60 days'`. Prevents unbounded growth
(per /speckit.critique round 1 / E7). Trivial maintenance — single SQL
DELETE statement.

### Setup steps

- **Title**: `Chamber-OS · F8 prune consumed link tokens`
- **URL**: `.../api/cron/renewals/prune-consumed-tokens`
- **Schedule**: `0 4 * * 6` (Sat 04:00 Asia/Bangkok)
- **Timeout**: 30 seconds

## F8 — renewals/reconcile-pending-applications (NEW — F8 Phase 7)

Weekly reconciliation: detects orphaned `tier_upgrade_suggestions` where
`status='accepted_pending_apply'` and `target_apply_at_cycle_id` references
a cycle that's already terminal (completed/lapsed/cancelled) without the
suggestion having transitioned to `applied` or `superseded`. Emits
`tier_upgrade_pending_orphan_detected` audit for admin investigation
(does NOT auto-resolve — orphan implies missed F4 invoice-creation hook,
genuine bug surfaces in audit).

### Setup steps

- **Title**: `Chamber-OS · F8 reconcile pending tier-upgrades`
- **URL**: `.../api/cron/renewals/reconcile-pending-applications`
- **Schedule**: `0 5 * * 6` (Sat 05:00 Asia/Bangkok — 1h after token prune)
- **Timeout**: 5 seconds (small table + partial-index-driven scan)

## Owner

Platform on-call (default: maintainer). Per-feature ownership escalates
via the linked detail runbooks for the affected job.

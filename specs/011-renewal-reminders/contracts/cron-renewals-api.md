# F8 — Cron Renewals API Contract

**Feature**: F8 Renewal Tracking + Smart Reminders
**Branch**: `011-renewal-reminders`
**Date**: 2026-05-03
**Status**: Phase 1 contract output

All cron endpoints are HTTP POST triggers from cron-job.org (Hobby-plan-compatible operational pattern reused from F4/F5/F7). Bearer auth via shared `CRON_SECRET` env var (rotated atomically across all cron-using features).

Runtime pinned to **Node.js** (NOT Edge) for `@js-joda/timezone` Asia/Bangkok date math + Drizzle pool access.

**Architecture (per research.md R14 + /speckit.critique 2026-05-03 round 1 / X1)**: Each cron job uses a **coordinator + per-tenant fan-out** pattern instead of a single handler iterating all tenants. The coordinator endpoint (called by cron-job.org) reads `tenants WHERE active = TRUE` and for each active tenant makes an internal HTTP call (`fetch`) to a per-tenant endpoint. Each per-tenant invocation runs in its own Vercel function instance with its own 300s budget. This keeps the per-tenant SLO (<60s @ 5,000 active members per FR-017) within the single function timeout AND allows the system to scale to 50+ tenants without exceeding Vercel's 300s default function timeout (which a single-handler-iterating-all-tenants approach would breach at SaaS scale).

Per-tenant work uses `SELECT ... FOR UPDATE SKIP LOCKED` + `pg_advisory_xact_lock(hashtextextended('renewals:<job>:'||tenantId, 0))`. Coordinator emits `cron_dispatch_orchestrated` audit with `{tenants_enqueued, duration_ms}` for visibility. A failed per-tenant invocation does NOT block other tenants AND naturally retries on the next cron pass via FR-011 idempotency.

Kill-switch: `FEATURE_F8_RENEWALS=false` short-circuits all 3 cron handlers (return 200 with `{skipped: true, reason: 'feature_flag_disabled'}` and emit no audit events).

---

## 1. Daily reminder dispatch (coordinator + per-tenant)

### `POST /api/cron/renewals/dispatch-coordinator`

**Cadence**: Daily 06:00 Asia/Bangkok (cron-job.org timer; the ONLY endpoint cron-job.org hits for daily dispatch)

**Headers**: `Authorization: Bearer <CRON_SECRET>` (required; mismatched/missing → 401)

**Behavior**:
1. Resolve all active tenants from `SELECT tenant_id FROM tenants WHERE active = TRUE`
2. For each active tenant, fan out via internal HTTP call: `await fetch('/api/cron/renewals/dispatch/' + tenantId, { headers: { Authorization: 'Bearer ' + CRON_SECRET } })`
3. Run all per-tenant fetches in parallel via `Promise.allSettled` (cap at 50 concurrent for SaaS-scale safety)
4. Aggregate results from all per-tenant responses
5. Emit audit `cron_dispatch_orchestrated` with `{tenants_enqueued, tenants_succeeded, tenants_failed, duration_ms}`
6. Return summary

**Response 200**:
```json
{
  "skipped": false,
  "tenants_enqueued": 1,
  "tenants_succeeded": 1,
  "tenants_failed": 0,
  "per_tenant_results": [
    { "tenant_id": "swecham", "reminders_dispatched": 18, "tasks_created": 2, "duration_ms": 3200 }
  ],
  "duration_ms": 3450
}
```

**SLO**: coordinator pass < 5s @ 50 active tenants (the per-tenant work runs in parallel; coordinator overhead is HTTP-fan-out latency only).

**Failure mode**: if a per-tenant fetch fails (timeout / non-200), the failed tenant retries on tomorrow's cron pass via FR-011 idempotency. Coordinator records `tenants_failed` count.

---

### `POST /api/cron/renewals/dispatch/[tenantId]`

**Called by**: the dispatch-coordinator endpoint (NOT cron-job.org directly).

**Headers**: `Authorization: Bearer <CRON_SECRET>` (required; mismatched/missing → 401)

**Behavior**:
1. Bind `app.current_tenant = tenantId` via `runInTenant(ctx, fn)`
2. Acquire `pg_advisory_xact_lock(hashtextextended('renewals:dispatch:'||tenantId, 0))`
3. Query active members per FR-007a canonical definition
4. For each member, evaluate the schedule policy for their `tier_bucket`:
   - For each step where `today === expires_at + offset_days`:
     - If `channel === 'email'`:
       - Skip-reason checks per FR-012 (already_sent / email_unverified / member_opted_out / member_archived / read_only_mode / member_below_min_tenure_for_step / multi_year_non_final_year / outreach_in_progress / no_primary_contact)
       - Else dispatch via Resend transactional API
       - Insert `renewal_reminder_events` row (idempotent on `(cycle_id, step_id, year_in_cycle)`)
     - If `channel === 'task'`:
       - Insert `renewal_escalation_tasks` row (idempotent on open `(member_id, cycle_id, task_type)`)
       - Audit `escalation_task_created`
   - **Retry path** per FR-010a: failed events with retryable `failure_reason` (upstream_unavailable / rate_limited / transient) within `retry_until = original_dispatch_at + 24h` are retried; permanent-failure transition emits `renewal_reminder_send_failed_permanent` + creates `manual_outreach_required` escalation task.
5. Return summary

**Response 200**:
```json
{
  "skipped": false,
  "tenant_id": "swecham",
  "reminders_dispatched": 18,
  "reminders_skipped": { "already_sent": 12, "member_opted_out": 1, "outreach_in_progress": 0, "no_primary_contact": 0, ... },
  "reminders_retried": 2,
  "reminders_failed_permanent": 0,
  "tasks_created": 2,
  "duration_ms": 3200,
  "errors": []
}
```

**Response 200 (kill-switch)**: `{ skipped: true, reason: "feature_flag_disabled" }`

**Response 200 (read-only)**: `{ skipped: true, reason: "read_only_mode" }` + audit `renewal_reminder_deferred_read_only` per skipped step

**Response 401**: `{ error: "unauthorized" }`

**Response 500**: never; per-tenant errors are caught and reported in the `errors` array; the cron handler always returns 200 unless something is truly fatal (DB unreachable, etc.).

**SLO**: full pass < 60s @ 5,000 active members per tenant (FR-017 / SC-005)

**Idempotency**: re-running on the same day produces zero additional dispatches per FR-011.

---

## 2. Weekly at-risk recompute

### `POST /api/cron/renewals/at-risk-recompute`

**Cadence**: Weekly Sunday 02:00 Asia/Bangkok

**Headers**: `Authorization: Bearer <CRON_SECRET>`

**Behavior**:
1. Resolve all active tenants
2. Per tenant: probe `EventAttendeesPort.isAvailable()` once at start
3. Per tenant: acquire `pg_advisory_xact_lock(hashtextextended('renewals:atrisk:'||tenantId, 0))`
4. Per tenant: iterate active members per FR-007a; skip if tenure < `min_tenure_days_for_at_risk`
5. For each eligible member: compute score per FR-029 + FR-029a; persist to `members.risk_score` + `risk_score_band` + `risk_score_factors` + `risk_score_last_computed_at`; emit `at_risk_score_recomputed` audit
6. If band crossed to higher-risk: emit `at_risk_score_threshold_crossed`
7. Return summary

**Response 200**:
```json
{
  "skipped": false,
  "tenants_processed": 1,
  "members_recomputed": 5000,
  "f6_active": false,
  "active_max": 70,
  "band_distribution": { "healthy": 3000, "warning": 1500, "at-risk": 400, "critical": 100 },
  "threshold_crossings_to_higher": 12,
  "duration_ms": 42000,
  "errors": []
}
```

**SLO**: full pass < 60s @ 5,000 active members per tenant (FR-036 / SC-005)

---

## 3. Weekly tier-upgrade evaluate

### `POST /api/cron/renewals/tier-upgrade-evaluate`

**Cadence**: Weekly Sunday 03:00 Asia/Bangkok (1h after at-risk to allow rolling)

**Headers**: `Authorization: Bearer <CRON_SECRET>`

**Behavior**:
1. Resolve all active tenants
2. Per tenant: check `tenant_renewal_settings.auto_upgrade_enabled`; if false → emit `tier_upgrade_tenant_disabled` once + skip
3. Per tenant: acquire `pg_advisory_xact_lock(hashtextextended('renewals:tierupgrade:'||tenantId, 0))`
4. Per tenant: iterate active members per FR-007a
5. For each member: evaluate against `next_higher_tier.eligibility` from F2 plan catalogue
   - If member already at or above suggested target → `tier_upgrade_already_at_target` audit, skip
   - If suspended (`tier_upgrade_suggestions.suppressed_until > now`) → skip
   - If qualifies AND no open/pending suggestion → INSERT into `tier_upgrade_suggestions` (status `open`) + emit `tier_upgrade_suggested`
   - If tenant has no thresholds configured on F2 plans → `tier_upgrade_skipped_no_thresholds_configured` once per tenant + skip
6. Return summary

**Response 200**:
```json
{
  "skipped": false,
  "tenants_processed": 1,
  "members_evaluated": 5000,
  "suggestions_created": 8,
  "suggestions_already_existed": 3,
  "tenants_disabled": 0,
  "tenants_no_thresholds": 0,
  "duration_ms": 18000,
  "errors": []
}
```

**SLO**: full pass < 30s @ 5,000 active members per tenant (FR-057 / SC-005)

---

## 4. Operational notes

### Secret rotation

`CRON_SECRET` rotates atomically across all cron-using features (F4 stale-pending, F5 stale-pending-count, F7 broadcasts dispatch + reconcile, F8 dispatch + at-risk + tier-upgrade). Rotation procedure documented in `docs/runbooks/cron-jobs.md` (existing F7 catalogue extended with F8 entries).

### Manual triggering (staging / dev / failure recovery)

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://staging.swecham.zyncdata.app/api/cron/renewals/dispatch
```

### cron-job.org configuration

Add 3 new jobs to the existing cron-job.org account:

| Job name | URL | Cadence | Notify on failure |
|---|---|---|---|
| F8 Renewal Dispatch | `https://swecham.zyncdata.app/api/cron/renewals/dispatch` | `0 6 * * *` (Bangkok) | ops@... |
| F8 At-Risk Recompute | `.../api/cron/renewals/at-risk-recompute` | `0 2 * * 0` (Bangkok Sunday) | ops@... |
| F8 Tier-Upgrade Evaluate | `.../api/cron/renewals/tier-upgrade-evaluate` | `0 3 * * 0` (Bangkok Sunday) | ops@... |

### Failure SLO

Cron success rate ≥99% over rolling 30 days. Alerting per FR-056 alert rule "cron-failure (no successful run in 25h)".

---

## 5. Housekeeping crons (added /speckit.critique 2026-05-03 round 1)

### `POST /api/cron/renewals/prune-consumed-tokens` (E7 — consumed_link_tokens unbounded growth)

**Cadence**: Weekly Saturday 04:00 Asia/Bangkok

**Headers**: `Authorization: Bearer <CRON_SECRET>`

**Behavior**: `DELETE FROM consumed_link_tokens WHERE consumed_at < now() - interval '60 days'`. Trivial maintenance.

**Response 200**: `{ rows_pruned: 1234, duration_ms: 45 }`

**SLO**: <30s for any reasonable backlog.

---

### `POST /api/cron/renewals/reconcile-pending-applications` (E19 — orphaned tier-upgrade pending state)

**Cadence**: Weekly Saturday 05:00 Asia/Bangkok (1h after token prune)

**Headers**: `Authorization: Bearer <CRON_SECRET>`

**Behavior**: Scan `tier_upgrade_suggestions` where `status = 'accepted_pending_apply'` AND `target_apply_at_cycle_id` references a cycle whose `status IN ('completed','lapsed','cancelled')` AND the suggestion has NOT transitioned to `applied` or `superseded`. For each orphan, emit audit event `tier_upgrade_pending_orphan_detected` with `{suggestion_id, member_id, target_apply_at_cycle_id, target_cycle_status, suggestion_age_days}` for admin investigation. Does NOT auto-resolve (admin reviews manually because the orphan implies a missed F4 invoice-creation hook → genuine bug surfaces in audit).

**Response 200**: `{ orphans_detected: N, audit_events_emitted: N, duration_ms: T }`

**SLO**: <5s @ SaaS scale (small table, partial-index-driven scan).

---

### cron-job.org configuration update (revised)

| Job name | URL | Cadence | Notify on failure |
|---|---|---|---|
| F8 Renewal Dispatch (coordinator) | `https://swecham.zyncdata.app/api/cron/renewals/dispatch-coordinator` | `0 6 * * *` Bangkok | ops@... |
| F8 At-Risk Recompute (coordinator) | `.../api/cron/renewals/at-risk-recompute-coordinator` | `0 2 * * 0` Bangkok Sun | ops@... |
| F8 Tier-Upgrade Evaluate (coordinator) | `.../api/cron/renewals/tier-upgrade-evaluate-coordinator` | `0 3 * * 0` Bangkok Sun | ops@... |
| **F8 Token Prune** (E7) | `.../api/cron/renewals/prune-consumed-tokens` | `0 4 * * 6` Bangkok Sat | ops@... |
| **F8 Reconcile Pending Tier-Upgrades** (E19) | `.../api/cron/renewals/reconcile-pending-applications` | `0 5 * * 6` Bangkok Sat | ops@... |
| **F8 Reconcile Pending Reactivations** (M3 round 2) | `.../api/cron/renewals/reconcile-pending-reactivations-coordinator` | `0 7 * * *` Bangkok daily | ops@... |

6 cron-job.org jobs total (was 3 originally; +2 housekeeping at /speckit.critique round 1; +1 reactivation timeout at /speckit.critique round 2 / M3).

---

### `POST /api/cron/renewals/reconcile-pending-reactivations-coordinator` (M3 round 2)

**Cadence**: Daily 07:00 Asia/Bangkok (1h after main dispatch coordinator)

**Headers**: `Authorization: Bearer <CRON_SECRET>`

**Behavior**: Coordinator pattern (per R14) — reads active tenants, fans out to per-tenant `/api/cron/renewals/reconcile-pending-reactivations/[tenantId]`. Each per-tenant invocation iterates `renewal_cycles` rows where `status = 'pending_admin_reactivation'` and:

1. If `entered_pending_at < now() - 7 days` AND no T-7 reminder sent yet: dispatch admin email reminder + emit `lapsed_member_admin_reactivation_reminder_t-7`
2. If `entered_pending_at < now() - 27 days` AND no T-3 reminder sent yet: dispatch second reminder + emit `lapsed_member_admin_reactivation_reminder_t-3`
3. If `entered_pending_at < now() - 29 days` AND no T-1 reminder sent yet: dispatch final reminder + emit `lapsed_member_admin_reactivation_reminder_t-1`
4. If `entered_pending_at < now() - 30 days`: trigger auto-timeout flow per FR-005c:
   - Transaction: transition cycle to `cancelled` (closed_reason='pending_reactivation_timed_out') + close task (skipped, reason='timed_out') + invoke F5 `issueRefund` + record `linked_credit_note_id`
   - Dispatch member email
   - Emit `lapsed_member_admin_reactivation_timed_out` with full payload

Idempotency: each reminder step has its own audit-event-existence guard so re-running daily doesn't double-send.

**Response 200**:
```json
{
  "skipped": false,
  "tenant_id": "swecham",
  "pending_total": 3,
  "t-7_reminders_sent": 1,
  "t-3_reminders_sent": 0,
  "t-1_reminders_sent": 0,
  "auto_timed_out": 0,
  "duration_ms": 850
}
```

**SLO**: <30s @ SaaS scale (small dataset, partial-index scan).

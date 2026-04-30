# Runbook — `broadcasts_queue_overflow`

**Owner**: Platform on-call (escalate to chamber admin if approval-side bottleneck)
**Severity**: warn (admin SLA at risk of breach; member-facing UX may show "Awaiting review for >48h")
**Source signal**: `broadcasts.queue_pending` gauge (> 8000 broadcasts in `status='submitted'` or `status='approved' WHERE scheduled_for IS NOT NULL` triggers warn)
**Audit events**: none directly; correlates with `broadcasts.median_time_to_decision` exceeding 24h-48h FR-013 SLA target
**Last reviewed**: 2026-04-29 (Batch D T032 spec scaffolding)
**Status**: SPEC — emit sites + queue metric land Phase 3+ (T036+); operational triage assumes Phase 3+ admin queue UI + `GET /api/admin/broadcasts/sla-stats` endpoint exist.

---

## Symptom

The admin review queue + scheduled-dispatch queue combined exceed 8000 pending broadcasts. The chamber SC-002 SLA target is 48h median time-to-decision (FR-013); when queue depth exceeds 8000 the SLA is unlikely to be honoured without admin intervention.

8000 is a heuristic threshold — at SweCham scale (~131 members in F1, 6 max E-Blasts/year on Premium tier) sustained queue > 1000 is itself unusual. The 8000 threshold is sized for SaaS-scale tenant onboarding (F11+).

## Why this matters

- Member experience: "Submit pending review" indicator stuck for days erodes trust + makes the platform appear unmaintained.
- FR-013 SLA breach surfaces in admin queue page banner (T125a SLA banner) — admins see red status repeatedly.
- Scheduled dispatch backlog (`status='approved' WHERE scheduled_for < now()`) means future-dated broadcasts may dispatch late, missing their event window.

This is fundamentally an **admin capacity issue** — the platform can scale arbitrarily, but the human review pipeline has finite throughput. F7 MVP targets 10 submissions per member per 24h max (FR-002d rate limit); cap × member count is the per-tenant ceiling.

---

## Triage steps (in order)

1. **Verify the queue depth metric**.
   ```sql
   SELECT status, count(*) FROM broadcasts
    WHERE tenant_id = $tenant
      AND status IN ('submitted', 'approved')
    GROUP BY status;
   ```
   - If both buckets sum > 8000 → confirmed.
   - If one bucket dominates → identify (admin review backlog vs scheduled-dispatch backlog).

2. **Check admin SLA stats**.
   ```sql
   SELECT
     percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (approved_at - submitted_at))/3600) AS median_hours,
     percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (approved_at - submitted_at))/3600) AS p95_hours,
     count(*) AS decision_count
     FROM broadcasts
    WHERE tenant_id = $tenant
      AND submitted_at >= now() - interval '30 days'
      AND status IN ('approved', 'rejected');
   ```
   - Median > 24h → SLA banner shows amber.
   - p95 > 48h → SLA banner shows red (SC-002 breach).

3. **Identify queue blockers**.
   - Are admins logging in? Audit log: `SELECT actor_user_id, count(*) FROM audit_log WHERE event_type IN ('broadcast_approved', 'broadcast_rejected') AND emitted_at > now() - interval '7 days' GROUP BY 1;`
   - If only 1 admin is approving → engage chamber admin for capacity.
   - If 0 admin activity → escalate to chamber business owner; admins may have lost portal access.

4. **Drain scheduled-dispatch backlog if present**.
   - The dispatch-scheduled cron (Phase 3+ T169 — runs every 5 min via cron-job.org) should pick up due `approved` rows automatically.
   - If backlog is growing despite cron firing → see [broadcasts-dispatch-failure.md](./broadcasts-dispatch-failure.md).
   - Check cron-job.org dashboard for last successful trigger of `broadcasts/dispatch-scheduled`.

5. **Bulk-reject obsolete submissions** (last resort, with admin approval).
   - For broadcasts that are months stale + content references past events → admin can bulk-reject:
     ```sql
     -- Run inside a manual psql session with admin user audit context
     UPDATE broadcasts
        SET status = 'rejected',
            rejected_at = now(),
            rejected_by_user_id = $admin_user_id,
            rejection_reason = 'Stale; content references past event'
      WHERE tenant_id = $tenant
        AND status = 'submitted'
        AND submitted_at < now() - interval '30 days';
     -- Then bulk-insert audit_log rows with event_type='broadcast_rejected'
     ```
   - This releases reserved quota slots → members can resubmit.

---

## Escalation

- **Queue depth > 16000** → page chamber admin; consider opening Phase 4 enhancement to add admin team scaling tools (auto-routing, bulk approve/reject filters).
- **SLA red across multiple weeks** → review F7 Phase 4 backlog for "admin capacity scaling" features.
- **Cron-job.org dispatch failed** → see [broadcasts-dispatch-failure.md](./broadcasts-dispatch-failure.md) + [cron-jobs.md](./cron-jobs.md).

---

## Recovery

After queue is drained:

1. Verify gauge returns under threshold within 1h.
2. Verify SLA banner returns to green within 30-day rolling window.
3. Document any process changes (admin team additions, bulk-reject criteria) in chamber SOP.

---

## Prevention

- FR-002d 10/24h per-member rate limit caps submission velocity (~131 members × 10/day = 1310 max daily — well under 8000 weekly assuming 7d).
- Per-broadcast 5,000 recipient cap (FR-016a) prevents single-broadcast queue chokes.
- Phase 4 scaling: if F7 expands to multi-tenant SaaS, queue threshold scales linearly per tenant.
- Quarterly review of admin team capacity vs queue depth trend.

# Runbook — `f8_at_risk_perf_regression`

**Owner**: Platform on-call
**Severity**: warn (cron throughput; not data integrity)
**Source signal**: F8-A4 alert — `renewals.at_risk.recompute_duration_ms` p95 > 60,000ms (60s budget per SC-005). Coordinator audit `cron_dispatch_orchestrated{cron_kind=at_risk_recompute}` payload `duration_ms` exceeds budget.
**Audit events**: none (perf regression is metric-only); look for `at_risk_compute_partial_failure` co-occurrence
**Last reviewed**: 2026-05-09 (F8 Phase 9 / T233)

---

## Symptom

Weekly at-risk recompute cron pass (Sunday 02:00 Asia/Bangkok) takes longer than 60 seconds for a single tenant of 5,000 active members. The cron is fire-and-forget from cron-job.org; sustained slowdown means the job creeps toward Vercel Functions 300s timeout, then fails entirely.

| Metric | Budget | Source |
|---|---|---|
| `renewals.at_risk.recompute_duration_ms` p95 | < 60,000ms | OTel histogram per tenant |
| `at_risk_compute_partial_failure` audit count per pass | 0 | audit_log |

---

## Why this matters

The at-risk recompute is a **batch read-write**: scans every active member, applies the 8-factor heuristic (FR-029), writes `members.risk_score` + `risk_score_band` + `risk_score_factors`. A single slow pass breaches SC-005 + erodes admin trust in the at-risk widget freshness.

If the pass times out at 300s, partial state may persist (members 1..N updated, N+1..end stale). The application detects this via `at_risk_compute_partial_failure` per-tenant audit emit + `renewals.at_risk.recompute_members_failed_total` counter — the next pass picks up where the failed one left off, but for 7 days admins see a mix of fresh and stale risk scores.

---

## Triage steps (in order)

1. **Confirm scope**. Check the coordinator audit row:
   ```sql
   SELECT payload FROM audit_log
   WHERE event_type = 'cron_dispatch_orchestrated'
     AND payload->>'cron_kind' = 'at_risk_recompute'
   ORDER BY created_at DESC LIMIT 1;
   ```
   Look for `tenants_failed > 0`. If non-zero, drill into `payload.per_tenant_results` (truncated to bounded cardinality) to identify which tenant slowed down.

2. **Identify the bottleneck — query plan**. Connect to read-replica:
   ```sql
   SET app.current_tenant = 'swecham';
   EXPLAIN (ANALYZE, BUFFERS) SELECT
     m.member_id, m.company_name, m.joined_at, m.expires_at,
     m.last_activity_at, m.risk_snoozed_until,
     /* aggregates from F4 invoices */
     (SELECT COUNT(*) FROM invoices WHERE member_id = m.member_id AND status = 'overdue') AS overdue_count,
     /* event attendance from F6 (or stub) */
     (SELECT COUNT(*) FROM event_attendees WHERE member_id = m.member_id AND attended_at > NOW() - INTERVAL '90 days') AS recent_events
   FROM members m
   WHERE m.status = 'active' AND m.risk_snoozed_until IS NULL;
   ```
   Watch for sequential scans. Expected: index scan via `members(tenant_id, status) WHERE status='active'` + per-row subquery via `invoices(tenant_id, member_id, status)`.

3. **Check for query-loop regression**. The compute use-case (`compute-at-risk-score.ts`) should iterate members in batches and reuse a single connection. If a recent refactor introduced a per-member round-trip, p95 quadruples.
   ```bash
   git log --oneline -- src/modules/renewals/application/use-cases/compute-at-risk-score.ts
   git log --oneline -- src/modules/renewals/application/use-cases/recompute-at-risk-scores-batch.ts
   ```
   Roll back recent changes if they introduced N+1 patterns.

4. **Check member-volume growth**. The 60s budget assumes ≤5,000 active members per tenant. If a tenant has grown beyond that:
   ```sql
   SELECT COUNT(*) FROM members WHERE status = 'active';
   ```
   For 10k+ tenants, raise the SC-005 budget per stakeholder agreement (it is currently a per-tenant SLO, not a multi-tenant SLO) AND consider sharding the recompute into 2k-member windows triggered by cron-job.org separately per shard.

5. **Check F6 event-attendees stub**. If F6 EventCreate has not yet shipped, `EventAttendeesPort.isAvailable()` returns false → the event-attendance factor is skipped. This is a planned degraded mode. If F6 HAS shipped and the port is timing out, the at-risk pass blocks waiting on F6 reads — see `event-integration` module health metrics.

6. **Check Neon connection pool**. Same as pipeline-perf-regression triage step 5.

---

## Mitigations

- **Temporarily skip the recompute** for an oversized tenant by setting `FEATURE_F8_AT_RISK_DISABLED=true` in Vercel env (granular kill-switch per FR-052b). Recompute pauses; existing risk scores remain visible until next successful pass.
- **Raise the budget**: SC-005 budget can be revisited per tenant in `specs/011-renewal-reminders/spec.md` if member volume justifies. Stakeholder signoff required.

---

## Escalation

- Sustained > 90s for ≥ 4 weeks → spec-amendment + budget revisit (Phase 11).
- Partial-failure audit volume sustained > 5% → engage Neon to verify replica replication lag.
- F6 stub returning false but app behaviour suggests F6 active → fault-isolate the F6 boundary.

---

## Related

- [`docs/observability.md` § 23.1.2](../observability.md) — at-risk metric catalogue
- [`specs/011-renewal-reminders/spec.md` § SC-005](../../specs/011-renewal-reminders/spec.md) — budget contract
- [`specs/011-renewal-reminders/research.md` § R-FR-029a](../../specs/011-renewal-reminders/research.md) — F6 readiness fallback design

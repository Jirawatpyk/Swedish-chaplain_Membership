# Runbook — `f8_pipeline_perf_regression`

**Owner**: Platform on-call
**Severity**: warn (UX degradation; not data integrity)
**Source signal**: SC-003 violation — `/admin/renewals` p95 render > 500ms at 5,000 active members + 600 within 90-day window. OTel histogram `renewals.pipeline.load_duration_ms` p95 > 500.
**Audit events**: none (perf regression is metric-only)
**Last reviewed**: 2026-05-09 (F8 Phase 9 / T233)

---

## Symptom

Vercel Speed Insights p95 latency for `/admin/renewals` exceeds 500ms. The renewal pipeline is the **most-used F8 surface** — admins land here daily as part of their morning routine, so a sustained breach erodes confidence and pushes admins back to manual Excel scrolling.

| Metric | Budget | Source |
|---|---|---|
| `renewals.pipeline.load_duration_ms` p95 | < 500ms | OTel histogram |
| `/admin/renewals` TTFB | < 600ms | Vercel Speed Insights |
| `/api/admin/renewals` route p95 | < 500ms | OTel span `admin_pipeline_load` |

---

## Why this matters

SC-003 is a contract-level success criterion. The pipeline composite query (`loadPipelinePage`) joins `renewal_cycles` × `members` × `renewal_reminder_events` (last reminder per cycle) + computes urgency-bucket on the DB side per FR-046. Any p95 breach signals one of:

- The partial index `renewal_cycles(tenant_id, status, expires_at) WHERE status IN ('upcoming','reminded','awaiting_payment')` is bloated, missing, or unused.
- The per-cycle last-reminder lookup degraded to a sequential scan.
- Neon connection pool saturation under concurrent admin sessions.
- pg_trgm index on `members.company_name` is bloated (search filter slow).
- TanStack Table v8 client-side bundle regression doubled JS parse cost.

---

## Triage steps (in order)

1. **Identify which leg of the budget is breaching**. Open Vercel Speed Insights; filter to `/admin/renewals` route. Compare:
   - Server-side TTFB (DB query + render): if > 400ms → DB issue
   - Client-side hydration / bundle parse: if > 200ms → frontend issue

2. **Correlate with recent deploys**. Vercel Deployments → if regression started immediately after a deploy → roll back via `vercel rollback <previous-deployment-url>`.

3. **Run the EXPLAIN ANALYZE**. From production read-replica:
   ```sql
   SET app.current_tenant = 'swecham';
   EXPLAIN (ANALYZE, BUFFERS) SELECT
     rc.cycle_id, rc.member_id, m.company_name, rc.tier_bucket_at_creation,
     rc.expires_at, rc.status, ev.dispatched_at AS last_reminder_at,
     ev.step_id AS last_reminder_step_id, rc.linked_invoice_id,
     rc.closed_reason, m.email_unverified
   FROM renewal_cycles rc
   JOIN members m ON m.member_id = rc.member_id
   LEFT JOIN LATERAL (
     SELECT dispatched_at, step_id FROM renewal_reminder_events
     WHERE cycle_id = rc.cycle_id ORDER BY dispatched_at DESC LIMIT 1
   ) ev ON TRUE
   WHERE rc.status IN ('upcoming','reminded','awaiting_payment','pending_admin_reactivation')
   ORDER BY rc.expires_at ASC LIMIT 50;
   ```
   Expected: Index Scan using `renewal_cycles_tenant_status_expires_partial` (or similar). If you see Seq Scan → index missing or bloated.

4. **Check index health**:
   ```sql
   SELECT relname, n_dead_tup, n_live_tup,
     ROUND(n_dead_tup::numeric / GREATEST(n_live_tup, 1) * 100, 1) AS bloat_pct
   FROM pg_stat_user_tables
   WHERE relname IN ('renewal_cycles', 'renewal_reminder_events', 'members')
   ORDER BY bloat_pct DESC;
   ```
   `bloat_pct > 20` warrants a `VACUUM ANALYZE` pass during low-traffic window. Neon offers automatic vacuum but heavy churn can outpace it.

5. **Check Neon connection pool saturation**. Neon Console → Compute → connection_count. Under burst load (multiple admins refresh dashboard simultaneously) the pool can saturate. If sustained > 80% capacity:
   ```bash
   vercel env add DATABASE_POOL_MAX production   # raise from 10 to 20
   ```
   Redeploy.

6. **Check bundle size regression**. Run `pnpm build && pnpm tsx scripts/check-bundle-budgets.ts`. The pipeline route budget is 150 KB per Phase 9 / T255. If breaching:
   ```bash
   pnpm build:analyse
   ```
   Look for newly-added client components in `_components/` directory. Server components do not count against bundle.

7. **Check TanStack Table column cardinality**. The pipeline table renders ≤50 rows × ≤8 columns. If a column accidentally got a heavy formatter (e.g. `Intl.DateTimeFormat` constructed per cell instead of memoised), p95 hydration spikes — search the route's `_components/` for non-memoised formatters.

---

## Escalation

- Index bloat re-emerges within 7 days of VACUUM → schedule a deeper REINDEX during maintenance window.
- Neon read-replica lag > 1s → engage Neon support.
- Sustained > 2× budget for ≥ 24h → incident-ticket; consider temporary pagination cap reduction (50 → 25 rows) as breaker.

---

## Related

- [`docs/observability.md` § 23.1](../observability.md) — pipeline metric catalogue
- [`specs/011-renewal-reminders/spec.md` § SC-003](../../specs/011-renewal-reminders/spec.md) — perf budget contract
- [`drizzle/migrations/0087_*`](../../drizzle/migrations/) — pipeline_idx index migration

# F6.1 State-Change Quota Rollback — P2 Runbook

**Alert source**: `eventcreate_csv_state_change_fallback_total{reason="quota_decrement"}` counter increments ≥ 1 in 5-minute window (or sustained `> 0` over 10 min)
**Severity**: **P2 — investigate within 1 business hour** (P1 if sustained > 30 min)
**Last reviewed**: 2026-05-18 (R2-1 /speckit-review Round 2 close-out)

## What it means

The F6.1 CSV state-change probe (`maybeApplyStateChange` in `src/modules/events/application/use-cases/import-csv.ts`) hit a quota-decrement error AFTER acquiring the per-(tenant, member, event) advisory lock. The outer catch in `maybeApplyStateChange` re-threw `TxStageError('quota_decrement')` so the SAVEPOINT rolled back atomically — that means:

- `payment_status` is **unchanged** for the affected registration row.
- `counted_against_partnership` / `counted_against_cultural_quota` flags are **unchanged**.
- **NO new audit row** was written for this state change attempt (`csv_import_row_state_changed` AND `quota_credit_back_refund` / `quota_*_decremented` are all absent for this row's attempt).
- The CSV summary reported the row as `row_failed` with `failureStage='quota_decrement'`.

The strict-correctness invariant from `import-csv.ts:660-667` is preserved: *"either the row flips AND the quota reflects the new state, or neither."*

Background context: R2-1 (/speckit-review Round 2, 2026-05-18) replaced a silent-swallow path with this re-throw. Before R2-1, this same failure class committed the payment_status flip with stale quota flags + no audit row — a Reliability/Privacy/Compliance regression that this counter is now designed to catch.

## Symptoms

- Vercel alert fires on the `csv_state_change_fallback{reason="quota_decrement"}` series.
- Structured pino log shows:
  ```
  level=error event=f6_csv_state_change_savepoint_rollback stage=quota_decrement msg="[F6.1] state-change probe TxStageError — savepoint rolls back atomically"
  ```
  Plus `tenantId`, `eventId`, `rowNumber`, `attendeeEmailHash`, and the wrapped error message.
- Admin UI: row appears as **Failed** in the CSV import summary (not silently absent).

## Immediate response (first 30 minutes)

1. **Acknowledge alert + open low-pri ticket** (Slack #f6-ops or equivalent).
2. **Confirm the savepoint actually rolled back** by inspecting the affected registration row:
   ```sql
   SELECT registration_id, payment_status, counted_against_partnership,
          counted_against_cultural_quota, updated_at
   FROM event_registrations
   WHERE tenant_id = '<tenantId-from-log>'
     AND event_id = '<eventId-from-log>'
     AND attendee_email_lower = '<resolved-from-log>'
   ORDER BY updated_at DESC LIMIT 1;
   ```
   - `payment_status` must match the pre-import state. If it changed, the rollback failed — escalate to P1.
   - `counted_against_*` flags must match the pre-import quota state.
3. **Inspect the wrapped error** in the pino log's `err` / `cause.message`:
   - `lock_acquisition_failed` (advisory-lock acquire threw — DB blip or pool exhaust)
   - `setQuotaEffect failed: db_error` (repo write blocked; check RLS / role grants)
   - `setQuotaEffect failed: pseudonymised_row_rejected` (rare — admin re-uploaded a PII-erased row)
   - `allotment snapshot failed` (`queryAllotments` from the quota accounting port returned an err)
4. **Identify scope**: is this one row or many?
   ```bash
   vercel logs <deployment-url> --since=15m | grep f6_csv_state_change_savepoint_rollback | wc -l
   ```
   - 1–3 rows → likely transient (advisory-lock contention with another worker / brief Neon hiccup).
   - >10 rows in the same admin upload → systemic (RLS policy regression, enum drift, or pool exhaust).

## Most-likely root causes

1. **Neon advisory-lock contention** — concurrent webhook + CSV import targeted the same (tenant, member, event). The advisory-lock wait timed out. **Fix**: retry the CSV upload after the webhook job completes (usually <1 min). Pattern is self-healing.
2. **Neon pool exhaustion** — pool capped at the connection limit and `setQuotaEffect` waited too long. **Fix**: check Neon dashboard → connections; if at limit, scale up the Neon plan or wait for the pool to drain.
3. **`setQuotaEffect` repo db_error** — RLS denial, transient connection loss, or migration-in-flight. **Fix**: check `audit_log` and Neon logs for ROLE GRANT or RLS POLICY changes in the last hour.
4. **`queryAllotments` failure** — F8 quota accounting port returned an err. **Fix**: check the F8 `quota_accounting_failed_total` counter; cross-reference with F8 ops dashboard.
5. **Adversarial concurrent debit** — two simultaneous admin re-uploads racing the same registration. **Fix**: by-construction, the advisory lock serializes — but check the timestamps; if both throws fired within 100ms, investigate whether the lock acquire path itself is degraded.

## Manual reconciliation

If the affected admin needs the row to land in its target state immediately:

1. **Verify the row's current state** (step 2 above).
2. **Have the admin re-upload the same CSV** (or just the affected row). The orphan-recovery / state-change paths are idempotent — a successful re-upload will complete the flip + emit the audit pair.
3. **If the underlying cause persists** (pool exhaust, RLS regression), no admin action will succeed. Escalate to engineering.

## Forensic recovery

For DPO/compliance review (audit-trail completeness invariant):

```bash
# Pull every rollback event in the window:
vercel logs <deployment-url> --since=30m \
  | grep f6_csv_state_change_savepoint_rollback \
  | jq -r '"\(.tenantId) \(.eventId) row=\(.rowNumber) stage=\(.stage) err=\(.err)"'
```

Each line is one rolled-back state-change attempt. The audit-log row for `csv_import_row_state_changed` is INTENTIONALLY ABSENT (the rollback was correct). The forensic line above IS the trail — log retention is 30 days minimum on Vercel runtime logs.

## Escalation criteria

- **P1**: ≥10 rollbacks in the same 5-min window across multiple tenants → cross-cutting infra failure.
- **P1**: rollback fired AND payment_status / counted_against_* are inconsistent → atomicity broken; engineering must inspect immediately.
- **P2**: 1–9 rollbacks in 5-min, same tenant, same `cause.message` cluster → likely workflow-specific; engage tenant admin.

## Related runbooks

- `f6-audit-fallback-double-failure.md` — when the audit emit itself fails (different class).
- `f6-idempotency-sweep.md` — when receipts get stranded.
- `f6-bridge-eventattendees-degraded.md` — when the F8 bridge degrades (often correlated with this rollback if quota lookup is the trigger).

## Change log

- **2026-05-18** — Created (R2-1 close-out). Replaces the silent-swallow path with explicit re-throw + dedicated counter so this rollback class is now observable.

-- 0305 — 121-void-supersede-links: partial expression indexes for the
-- void-on-reissue supersede link on `audit_log`.
--
-- `issueMembershipBill` (106-void-on-reissue) supersede-voids a member's older
-- outstanding bill through `voidInvoice`, whose `invoice_voided` audit row
-- carries `payload.superseded_by_invoice_id` (the new bill). The admin and
-- portal invoice detail pages now read that link back in BOTH directions
-- (`invoiceSupersessionAdapter`):
--
--   forward  voided bill  → its replacement   WHERE payload->>'invoice_id' = $1
--   reverse  replacement  → what it replaced  WHERE payload->>'superseded_by_invoice_id' = $1
--
-- The audit row stays the single source of truth (no column on `invoices`; see
-- specs/121-void-supersede-links/plan.md § Design decision). No existing index
-- serves either lookup: `audit_log_tenant_event_ts_idx` narrows to a tenant's
-- `invoice_voided` rows but then JSON-filters every one; the `invoice_id`
-- expression index `audit_log_overdue_once_per_day` is partial on
-- `invoice_overdue_detected`.
--
-- Both indexes are PARTIAL on the supersede predicate, so they hold only
-- supersede-void rows (one per reactivation) — tiny, and no other audit write
-- pays for them. The adapter's WHERE repeats the predicate verbatim; the
-- reverse lookup's `= $1` also implies `IS NOT NULL`. `invoice_voided` has been
-- a committed enum value since F4, so the predicate is safe in-transaction
-- (no 55P04).
--
-- Plain CREATE INDEX (not CONCURRENTLY), per the 0021 precedent: the migration
-- runner wraps the pending batch in one transaction (CONCURRENTLY would error)
-- and `audit_log` volume is low, so the build lock is brief. Should it ever be
-- visible, rebuild outside the pipeline with DROP/CREATE INDEX CONCURRENTLY
-- (same runbook note as 0021). IF NOT EXISTS keeps the file replay-safe.
--
-- Rollback: DROP INDEX IF EXISTS audit_log_invoice_superseded_fwd_idx,
-- audit_log_invoice_superseded_rev_idx; — the adapter still works without them
-- (tenant/event index + filter), just slower.
--
-- Fail fast on the lock (0293 precedent): CREATE INDEX takes a SHARE lock on
-- `audit_log`, which every audited write needs. If a long transaction holds a
-- conflicting lock, abort after 5 s and let the deploy retry rather than queue
-- every audit INSERT behind us. SET LOCAL lives to the end of the migrator's
-- single batch transaction, so the default is handed back as the LAST
-- statement — later migrations in the same deploy must not inherit it.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "audit_log_invoice_superseded_fwd_idx"
  ON "audit_log" ("tenant_id", ("payload"->>'invoice_id'))
  WHERE "event_type" = 'invoice_voided'
    AND ("payload"->>'superseded_by_invoice_id') IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "audit_log_invoice_superseded_rev_idx"
  ON "audit_log" ("tenant_id", ("payload"->>'superseded_by_invoice_id'))
  WHERE "event_type" = 'invoice_voided'
    AND ("payload"->>'superseded_by_invoice_id') IS NOT NULL;--> statement-breakpoint

SET LOCAL lock_timeout = DEFAULT;

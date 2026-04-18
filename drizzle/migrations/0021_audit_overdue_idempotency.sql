-- Migration 0021 — partial unique index for `invoice_overdue_detected`
-- idempotency (at-most-once per invoice per Bangkok-local day).
--
-- Split from 0020 because Postgres requires the enum value
-- `invoice_overdue_detected` to be committed BEFORE a WHERE clause
-- can reference it (error 55P04 "unsafe use of new value"). The
-- `ALTER TYPE ADD VALUE` ran in 0020; this index runs in the next
-- transaction after 0020 has committed.
--
-- See data-model.md § 4 (post-critique R2-E3): overdue derivation
-- runs lazily on list query and emits `invoice_overdue_detected` via
-- `INSERT ... ON CONFLICT DO NOTHING`. This partial unique index
-- drops concurrent duplicates on the same (tenant, invoice, day)
-- Bangkok-local so audit stays clean.

-- NOTE: audit_log uses `timestamp` column (not `created_at`) — F1's
-- original schema from 0000_high_firestar.sql. Spec data-model.md
-- § 4 said `created_at`; sync in Phase 10 docs pass.
CREATE UNIQUE INDEX IF NOT EXISTS "audit_log_overdue_once_per_day"
  ON "audit_log" (
    "tenant_id",
    ("payload"->>'invoice_id'),
    (("timestamp" AT TIME ZONE 'Asia/Bangkok')::date)
  )
  WHERE "event_type" = 'invoice_overdue_detected';

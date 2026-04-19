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
--
-- R7-W4 — non-CONCURRENTLY index build is acceptable HERE (same
-- pattern as F3 `0009_members_contacts.sql` pg_trgm index) because:
--
--   1. audit_log is small during Chamber-OS deploys (green-field
--      tenants, low-volume SaaS) — index build completes in < 1 s
--      and the implicit ACCESS EXCLUSIVE lock on audit_log is too
--      brief to block user-facing audit writes meaningfully.
--   2. CREATE UNIQUE INDEX CONCURRENTLY cannot run inside a
--      transaction, and drizzle-kit wraps every migration in a tx.
--      Moving this statement "outside" the tx requires a separate
--      deploy-time manual step — unjustified complexity at the
--      current scale.
--
-- When audit_log grows to a size where the non-concurrent lock is
-- visible in p95 latency (likely > 1M rows) OR a tenant with
-- pre-existing high audit volume is onboarded, the ops runbook
-- MUST reindex CONCURRENTLY outside the migration pipeline:
--
--   DROP INDEX CONCURRENTLY audit_log_overdue_once_per_day;
--   CREATE UNIQUE INDEX CONCURRENTLY audit_log_overdue_once_per_day ...
--
-- and mark this migration file as "reindexed concurrently" in the
-- ops log.
CREATE UNIQUE INDEX IF NOT EXISTS "audit_log_overdue_once_per_day"
  ON "audit_log" (
    "tenant_id",
    ("payload"->>'invoice_id'),
    (("timestamp" AT TIME ZONE 'Asia/Bangkok')::date)
  )
  WHERE "event_type" = 'invoice_overdue_detected';

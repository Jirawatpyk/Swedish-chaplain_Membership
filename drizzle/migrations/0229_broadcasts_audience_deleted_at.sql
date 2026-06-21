-- PR-2 Task 2 — audience cleanup tracking column.
--
-- Stamped by the audience-cleanup cron (Task 3/4) after it successfully
-- deletes the Resend audience for a terminal broadcast. NULL means the
-- audience has not yet been cleaned up (or the broadcast never had one).
-- Additive + idempotent (IF NOT EXISTS) — safe to replay on the shared
-- live Neon used by all branches; no RLS policy change needed (the column
-- inherits the broadcasts table's existing RLS+FORCE policies).
ALTER TABLE "broadcasts"
  ADD COLUMN IF NOT EXISTS "audience_deleted_at" TIMESTAMPTZ;

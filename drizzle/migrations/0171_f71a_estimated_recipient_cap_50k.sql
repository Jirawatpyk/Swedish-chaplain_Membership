-- ---------------------------------------------------------------------------
-- F7.1a US1 (Phase 3E.2 fix) — broadcasts.estimated_recipient_count
-- CHECK constraint raised from F7 MVP 5000 → F71A US1 50000.
--
-- FR-007 mandates: "The 50,000-recipient ceiling MUST be enforced at
-- BOTH submit boundary AND dispatch boundary (defence in depth)".
-- The F7 MVP CHECK `BETWEEN 0 AND 5000` (from migration 0064) was
-- the F7 MVP submit-cap. F71A US1 lifts the cap to 50k but migration
-- 0162 only added columns + didn't update the CHECK.
--
-- This migration drops the 5k CHECK and replaces it with a 50k CHECK
-- so F71A US1-eligible tenants can submit broadcasts targeting up to
-- 50,000 recipients. Application-layer enforcement remains: the
-- `submit-broadcast` use case still rejects > tenant's effective cap
-- per the F71A feature-flag (T061 — when F71A is off, submit returns
-- broadcast_audience_too_large at 5k boundary).
--
-- Backward compat: existing F7 MVP rows with estimated_recipient_count
-- ≤5000 remain valid (CHECK is monotonically widened, never narrowed).
-- ---------------------------------------------------------------------------

ALTER TABLE "broadcasts"
  DROP CONSTRAINT IF EXISTS "broadcasts_estimated_recipient_cap";
--> statement-breakpoint
ALTER TABLE "broadcasts"
  ADD CONSTRAINT "broadcasts_estimated_recipient_cap"
  CHECK ("estimated_recipient_count" BETWEEN 0 AND 50000);

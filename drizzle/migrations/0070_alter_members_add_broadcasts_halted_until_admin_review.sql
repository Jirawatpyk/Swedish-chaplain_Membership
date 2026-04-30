-- ---------------------------------------------------------------------------
-- F7 — ALTER members ADD broadcasts_halted_until_admin_review
-- (T017 per specs/010-email-broadcast/tasks.md).
--
-- Clarifications Q14 + SC-005 (b): per-broadcast complaint-rate auto-halt.
-- When a single broadcast triggers >5% complaint rate, F7's webhook handler
-- sets this column to TRUE for the originating member, blocking further
-- submissions until an admin reviews + clears via `setMemberHalt(memberId,
-- false)` (emits `broadcast_member_dispatch_resumed` audit).
--
-- Source of truth: specs/010-email-broadcast/data-model.md § 1.3a.
--
-- FR-002 precondition `e` extended: submission requires
-- `broadcasts_halted_until_admin_review = false` for the originating
-- member. Manager-role users CANNOT clear the flag (admin-only; same auth
-- pattern as approve/reject/cancel per FR-014).
--
-- Idempotent via `IF NOT EXISTS` to support re-runs (defensive only —
-- drizzle-kit's journal prevents re-application in normal operation).
-- ---------------------------------------------------------------------------

ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "broadcasts_halted_until_admin_review" boolean
    NOT NULL DEFAULT false;--> statement-breakpoint

-- Q14: fast list of halted members (admin queue red banner)
CREATE INDEX IF NOT EXISTS "members_tenant_broadcasts_halted_idx"
  ON "members" ("tenant_id")
  WHERE "broadcasts_halted_until_admin_review" = true;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Plan-change → billing remediation (Package A) — add one audit event type:
--   - member_plan_change_billing_effect : forensic record of the billing
--     consequence of a member's live plan diverging from a renewal cycle's
--     frozen plan. Owned by F3 members (F3AuditEventType union); emitted from
--     the F8 renewals seed seams via a narrow renewals-owned audit port.
--
-- Package A emits ONLY the `effect: 'seed_fallback_plan_unresolvable'` variant
-- (the seed rewire's cohort-E fallback: the member's live plan has no
-- catalogue row resolvable for the next cycle's fiscal year, so the next
-- cycle is seeded from the prior cycle's plan and the payment is NOT rolled
-- back). The full effect union (applied_to_open_cycle / deferred_* /
-- no_open_cycle / seed_fallback_plan_unresolvable) is documented on the
-- members audit-port union; the other variants are emitted by the members
-- change-plan operation (a later package).
--
-- 5-year default retention (append-only, Principle VIII) — this is NOT a
-- tax-document event, so the retention trigger is intentionally NOT touched.
--
-- Idempotent DO block — same pattern as 0258_staff_invitation_lifecycle_audit.
-- DO-block enum-value additions do NOT change schema.ts-inferred structure, so
-- `drizzle-kit generate` produces no snapshot JSON; the `_journal.json` entry +
-- this SQL file are sufficient for replay (drift covered by the live-Neon suite).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'member_plan_change_billing_effect'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'member_plan_change_billing_effect';
  END IF;
END$$;

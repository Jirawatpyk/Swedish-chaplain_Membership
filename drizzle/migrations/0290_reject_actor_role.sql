-- 016 post-ship follow-up (PR #331 residual, 2026-08-15) — persist the
-- rejecting admin's ROLE next to the async reject-with-refund marker.
--
-- WHY: the 0243 marker trio (reject_refund_initiated_at / reject_refund_id /
-- reject_actor_user_id) let the reconcile-pending cron replay the rejecting
-- ADMIN as the audit actor — but only the user id was persisted, so the
-- replay had to ASSUME actor_role='admin'. Post-Migration-C every human
-- admin is a super_admin, which made both replay emits stamp a role the
-- actor does not hold into append-only money-path audit rows (the B-1 class,
-- replay variant — documented as a KNOWN LIMIT in
-- reconcile-pending-reactivations.ts until this column).
--
-- Advisory/forensic like its 0243 siblings: nullable, no CHECK, left set on
-- the resulting cancelled row. NULL means "stamped before this migration" —
-- the replay falls back to 'admin' for those legacy rows (the pre-existing
-- assumption, now scoped to exactly the rows where nothing better exists).

ALTER TABLE renewal_cycles ADD COLUMN IF NOT EXISTS reject_actor_role text;

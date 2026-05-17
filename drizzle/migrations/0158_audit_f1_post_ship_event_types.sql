-- B5 (post-ship 2026-05-17) — three new F1 audit event types closing
-- silent-failure gaps identified in `specs/001-auth-rbac/reviews/
-- review-20260517-post-ship-hardening.md` § Critical+Important.
--
-- 1. `password_change_failed` (5y default retention)
--    Emitted by `change-password.ts` on the wrong-current-password
--    branch. Pre-B5 this branch only logged at warn-level + bumped
--    `authMetrics.passwordWeakRejected('same')` — an attacker with a
--    stolen session cookie probing the user's password to elevate to
--    admin via /change-password had ZERO audit-trail footprint. The
--    dedicated event lets SRE alert on the wrong-current rate per
--    user (anomalous spike = compromised session).
--
-- 2. `password_reset_email_failed` (5y default retention)
--    Emitted by `forgot-password.ts` after the Resend retry loop
--    exhausts. Pre-B5 the failure was logger.error only — the
--    `password_reset_requested` row already committed at that point,
--    so the audit trail read "request issued + presumed email sent"
--    when the email actually never went out. Operators investigating
--    "I never got the reset email" had no audit linkage.
--
-- 3. `password_malformed_hash_detected` (5y default retention)
--    Emitted by `sign-in.ts` when `argon2.verify` catches a
--    malformed-hash exception (corrupted row, legacy format, encoding
--    drift). Pre-B5 the catch path returned `false`, the sign-in flow
--    took the wrong-password branch, the user's failedSignInCount
--    incremented, and they eventually got `lockout_triggered` — an
--    audit trail that misleads operators into thinking the user kept
--    typing the wrong password. The dedicated event surfaces the
--    DB-corruption signal cleanly.

DO $$ BEGIN
  ALTER TYPE "audit_event_type" ADD VALUE 'password_change_failed';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "audit_event_type" ADD VALUE 'password_reset_email_failed';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "audit_event_type" ADD VALUE 'password_malformed_hash_detected';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

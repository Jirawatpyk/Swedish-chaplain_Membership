-- Pass 5: add the dedicated `password_reset_failed` audit event type.
--
-- Previously `reset-password.ts` reused `invitation_redemption_failed`
-- as a stand-in for failed password-reset attempts (token not-found,
-- expired, or already used). This worked at runtime because the
-- `summary` column disambiguated reset vs invitation failures, but it
-- muddied audit queries (the F9 admin audit viewer would have had to
-- grep the summary column to split the two flows) and contradicted
-- the one-event-type-per-business-action invariant documented in
-- data-model.md § 2.7.
--
-- This migration adds the new enum variant. Application code
-- (`src/modules/auth/application/reset-password.ts`) is updated in
-- the same commit to emit the new type. No backfill is needed —
-- existing audit rows with `invitation_redemption_failed` remain
-- semantically correct for invitation redemption failures, and
-- the few pre-pass-5 rows that this may cover were written during
-- the F1 dev run against test users.

ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'password_reset_failed';

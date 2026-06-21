-- COMP-1 US2a — Member Erasure F1 linked-user erasure: new audit_event_type.
--
-- `user_erased` is emitted by the auth `eraseUser` use-case after anonymising
-- the cross-tenant `users` row (email → sentinel, password_hash → NULL,
-- status → disabled) so a GDPR-Art.17/PDPA-§33-erased member can no longer
-- authenticate. ADD VALUE IF NOT EXISTS is idempotent (re-apply safe).
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'user_erased';

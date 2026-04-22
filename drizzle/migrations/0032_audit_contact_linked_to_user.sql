-- Hybrid A+B duplicate-email handling in `invite-user-for-member` —
-- adds `contact_linked_to_user` audit event type.
--
-- Emitted when an admin invites a portal user whose email matches an
-- existing unlinked contact on the SAME member in the SAME tenant. We
-- link the existing contact (preserving its first/last/phone/role)
-- instead of creating a new contact row or orphaning the F1 user on a
-- unique-constraint conflict. Distinct from `contact_created` so the
-- audit trail cleanly distinguishes net-new contacts from admin
-- link-only operations.

DO $$ BEGIN
  ALTER TYPE "audit_event_type" ADD VALUE 'contact_linked_to_user';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

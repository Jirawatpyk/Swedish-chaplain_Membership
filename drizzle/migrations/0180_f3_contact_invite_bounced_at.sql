-- Migration 0180 — F3 spec § Edge Cases: invitation-email bounce marker
--
-- Adds `contacts.invite_bounced_at` to record that the F1 invitation email to
-- a contact bounced (Resend `email.bounced`). The `invitations` table has no
-- failure state of its own, so this column is the canonical "invitation
-- failed" marker AND the anchor for the directory "invite bounced" warning
-- badge. NULL = no bounce recorded; set to the bounce time by the
-- `markInvitationBounced` use-case; cleared on re-send.
--
-- Closes the spec § Edge Cases requirement: "Silent bounce = data integrity
-- bug; this edge case MUST be covered by integration test." (was unimplemented
-- at F3 ship — caught by the retrospective review).
--
-- Nullable, no default, no backfill needed (existing rows = no bounce). The
-- contacts table holds table-level GRANT (SELECT/INSERT/UPDATE/DELETE) to
-- chamber_app (migration 0009 line 242), so the new column needs no extra
-- grant. RLS + FORCE on contacts already scopes writes per tenant.

ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "invite_bounced_at" timestamp with time zone;--> statement-breakpoint

-- Partial index keeps both the cross-tenant bounce resolver and the directory
-- "bounced badge" lookup cheap (only a handful of rows ever carry a bounce).
CREATE INDEX IF NOT EXISTS "contacts_invite_bounced_idx"
  ON "contacts" ("tenant_id", "member_id")
  WHERE "invite_bounced_at" IS NOT NULL;

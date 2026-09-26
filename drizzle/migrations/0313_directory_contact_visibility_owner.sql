-- ---------------------------------------------------------------------------
-- Migration 0313 — directory: bind the contact toggles to the person they
-- publish.
--
-- The directory E-Book / JSON render the LIVE primary contact's name and
-- email (`listPublishedInTx`) under the listing's `contact_name` /
-- `contact_email` toggles. Those toggles are now switchable by the primary
-- contact only (GDPR Art. 6 / PDPA §19, §24 — the basis for publishing
-- belongs to the data subject), and this column records WHICH contact made
-- that choice. When the member's primary contact changes, the published
-- output falls back to the defaults (name shown, email hidden) until the new
-- primary confirms (`effectiveContactVisibility`), so a successor's email is
-- never published under someone else's choice.
--
-- No FK: a mismatch (or a contact that no longer exists) simply means "not
-- chosen by the current primary" — the fail-safe defaults apply.
--
-- Backfill: existing rows are attributed to the member's current live
-- primary contact, which keeps today's published output unchanged. Legacy
-- toggles may have been set by a colleague — noted in the PR as a follow-up
-- for the RoPA review.
--
-- Numbered 0313, journal idx 314, `when` 1798544600000 — strictly after
-- 0312's 1798544500000 (a duplicate `when` makes db:migrate a silent no-op).
--
-- Rollback:
--   ALTER TABLE "directory_listings" DROP COLUMN "contact_visibility_set_by_contact_id";
-- ---------------------------------------------------------------------------

ALTER TABLE "directory_listings" ADD COLUMN IF NOT EXISTS "contact_visibility_set_by_contact_id" uuid;--> statement-breakpoint
UPDATE "directory_listings" dl
   SET "contact_visibility_set_by_contact_id" = c."contact_id"
  FROM "contacts" c
 WHERE c."tenant_id" = dl."tenant_id"
   AND c."member_id" = dl."member_id"
   AND c."is_primary" = true
   AND c."removed_at" IS NULL
   AND dl."contact_visibility_set_by_contact_id" IS NULL;

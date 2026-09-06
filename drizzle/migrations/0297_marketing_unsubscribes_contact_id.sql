-- 0297 — `marketing_unsubscribes.contact_id`: attribute an unsubscribe to the
-- CONTACT, not only the member (108 PR-C, FR-024 / US3 s7; data-model § 2.3,
-- research R11).
--
-- WHY. Once marketing reaches every contact of a member (FR-020), "who
-- unsubscribed?" has two answers — the member the address belongs to and the
-- specific person. `member_id` (nullable, no FK, kept since F7) carried the
-- first; nothing carried the second, so the member page could not show
-- "S1 unsubscribed" for a secondary contact. `contact_id` is resolved at
-- unsubscribe time through the F7→F3 bridge (`lookupContactEmailInTenant`);
-- the primary-contact lookup stays as the legacy fallback, so rows written
-- for an address that is a member's primary but not a contact row keep
-- `contact_id` NULL.
--
-- SHAPE. Nullable uuid, NO foreign key — deliberately like `member_id`: a
-- suppression row is never deleted (GDPR Art. 21 / PDPA §32: "we will never
-- contact this address again" must outlive the contact row), and COMP-1's
-- member erasure hard-deletes contacts. The erasure cascade nulls both
-- back-references instead (tasks T104); the email-keyed row survives.
--
-- INDEX. `(tenant_id, contact_id) WHERE contact_id IS NOT NULL` serves the
-- member-page / audience-page read "is THIS contact unsubscribed?" without a
-- lower(email) join, and the erasure cascade's "rows referencing these
-- contacts". Partial: most historical rows (and every webhook-written bounce
-- or complaint) have no contact attribution.
--
-- BACKFILL. None. Attribution is best-effort and forward-only; the
-- suppression itself stays keyed on (tenant_id, email_lower) and is
-- authoritative with or without it (FR-024 "honoured for that address on
-- every later send").
--
-- ROLLBACK. Column and index are unused when PR-C is reverted or the audience
-- flag is off; drop only via a new migration.

ALTER TABLE "marketing_unsubscribes"
  ADD COLUMN IF NOT EXISTS "contact_id" uuid;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "marketing_unsubscribes_contact_lookup_idx"
  ON "marketing_unsubscribes" USING btree ("tenant_id", "contact_id")
  WHERE contact_id IS NOT NULL;

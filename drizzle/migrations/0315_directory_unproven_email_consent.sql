-- ---------------------------------------------------------------------------
-- Migration 0315 — directory: hide every published email whose consent cannot
-- be demonstrated (GDPR Art. 7(1); PDPA §19).
--
-- Ruling 4 of the RoPA § F9 record (2026-10-06, maintainer on the DPO's
-- behalf): migration 0313 attributed every existing listing's contact toggles
-- to the primary contact of the day. For `contact_name` (legitimate interest)
-- that is acceptable. For `contact_email` (consent) it is not: a colleague may
-- have switched it on before #432, and nobody can show the person agreed.
--
-- This switches `contact_email` OFF in `field_visibility` on every listing
-- with it on, EXCEPT where the recorded chooser demonstrably changed the
-- contact toggles themselves under the #432 code: an audit row
-- `directory_listing_updated` for the member with
-- `contact_visibility_changed = true` (a #432-only key), whose actor is the
-- recorded chooser's linked user. A save that left the toggles unchanged is
-- NOT proof — the #432 form showed the backfilled email already ticked
-- (GDPR Recital 32: pre-ticked boxes are not consent).
--
-- Only the email is touched: the name toggle, and a person's objection to it,
-- are left exactly as stored (clearing the chooser instead would have
-- re-published names stored as off — Art. 21(3) / PDPA §32). The primary can
-- switch the email back on under the separate consent text, which then records
-- the choice with its notice version.
--
-- Residual: a primary who changed only the NAME toggle under #432 keeps a
-- backfilled email (RoPA § F9 residual risk 1).
--
-- Numbered 0315, journal idx 316, `when` 1798544800000 — strictly after
-- 0314's 1798544700000 (a duplicate `when` makes db:migrate a silent no-op).
--
-- Rollback: none by design — switching the emails back on would re-assert a
-- consent that cannot be shown. The primary opts in again on
-- /portal/profile/directory.
-- ---------------------------------------------------------------------------

UPDATE "directory_listings" dl
   SET "field_visibility" = dl."field_visibility" || '{"contact_email": false}'::jsonb
 WHERE dl."field_visibility"->>'contact_email' = 'true'
   AND NOT EXISTS (
     SELECT 1
       FROM "audit_log" a
       JOIN "contacts" c
         ON c."tenant_id" = dl."tenant_id"
        AND c."contact_id" = dl."contact_visibility_set_by_contact_id"
      WHERE a."tenant_id" = dl."tenant_id"
        AND a."event_type" = 'directory_listing_updated'
        AND a."payload"->>'subject_member_id' = dl."member_id"::text
        AND a."payload"->>'contact_visibility_changed' = 'true'
        AND c."linked_user_id" IS NOT NULL
        AND a."actor_user_id" = c."linked_user_id"::text
   );

-- 0295 — 108 PR-D (FR-053): two audit event types for the per-contact
-- marketing preference.
--
-- `contact_marketing_opted_out` / `contact_marketing_opted_in` are emitted by
-- `setContactMarketingOptOut` (members Application) in the same transaction as
-- the `contacts` UPDATE, once per ACTUAL change. The same state again is
-- `unchanged` and emits nothing, EXCEPT a self "off" over a staff "off"
-- (FR-025 AMENDMENT), which is recorded as the person's objection and emits
-- `_opted_out` again — two `_opted_out` rows with no `_in` between them is a
-- valid trail. Payload: `{ member_id | related_member_id,
-- contact_id, source: 'staff' | 'self', actor_role }` — ids only, never an
-- address (FR-053a). The member key depends on WHO acted: a contact changing
-- their OWN preference IS member activity, so that row carries `member_id`
-- and migration 0009's `last_activity_at` bump is wanted; a STAFF change is
-- not member activity and carries `related_member_id` (the 0292 key — the
-- member timeline COALESCEs both, the recency trigger fires on neither).
-- Actor role = the session role (check:actor-role-truth). Retention 5 years
-- (F3 default — not a tax-document event).
--
-- ENUM-ONLY FILE: `scripts/run-migrations.ts` extracts every
-- `ALTER TYPE … ADD VALUE` (all of them — research V3, T004) and replays each
-- in AUTOCOMMIT before the transactional migrate pass. Keep this file free of
-- any other DDL, one statement per line, each ending in `;`, none on a `--`
-- line.

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'contact_marketing_opted_out';
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'contact_marketing_opted_in';

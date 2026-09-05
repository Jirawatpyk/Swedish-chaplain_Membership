-- 0295 — 108 PR-D (FR-053): two audit event types for the per-contact
-- marketing preference.
--
-- `contact_marketing_opted_out` / `contact_marketing_opted_in` are emitted by
-- `setContactMarketingOptOut` (members Application) in the same transaction as
-- the `contacts` UPDATE, once per ACTUAL change (same-state calls are
-- `unchanged` and emit nothing). Payload: `{ member_id, contact_id, source:
-- 'staff' | 'self' }` — ids only, never an address (FR-053a). `member_id` is
-- deliberately the conventional key here (unlike 0292's
-- `related_member_id`): a person changing their marketing preference IS
-- member activity, so migration 0009's `last_activity_at` bump is wanted.
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

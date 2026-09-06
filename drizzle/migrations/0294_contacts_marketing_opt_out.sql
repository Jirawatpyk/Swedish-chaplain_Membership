-- 0294 — 108 PR-D (US4 / FR-027, FR-030, FR-032, FR-056): per-contact
-- marketing opt-out on `contacts`.
--
-- WHAT. Three nullable columns that record "this contact does not receive
-- marketing broadcasts, switched off by <staff | the contact themself> at
-- <when>". NULL on all three = receives marketing. No backfill: every existing
-- contact keeps receiving exactly as before (FR-027 — the preference is opt-out,
-- and the person's own unsubscribe lives elsewhere, in `marketing_unsubscribes`,
-- which always wins over anything written here — FR-025).
--
-- WHY THREE COLUMNS AND NOT A PREFERENCES TABLE. One boolean per contact with
-- an actor + timestamp is the whole model (plan § Constitution X). A separate
-- table would need its own RLS policy, FK, and erasure-cascade entry for one
-- row per contact that is almost always absent.
--
-- CORRELATED CHECK. The three columns are all null or all set, mirroring the
-- `is_primary ⇒ removed_at IS NULL` CHECK from 0009: a preference without an
-- actor, or an actor without a timestamp, is a row nobody can explain in an
-- audit. The Domain constructor `contactMarketing()` throws on the same shape;
-- this CHECK is the backstop for every writer that is not the app.
--
-- ACTOR COLUMN HAS NO FK. `marketing_opt_out_by_user_id` is a staff user or the
-- contact's own linked login. Users can be erased (COMP-1) and this row must
-- survive that — the audit row (`contact_marketing_opted_out` / `_in`, migration
-- 0295) is the authoritative record of who changed it; the column is a display
-- convenience for "changed by / at" on the member and audience pages.
--
-- PARTIAL INDEX. `contacts_marketing_recipients_idx (tenant_id, member_id,
-- contact_id) WHERE removed_at IS NULL AND marketing_opt_out_at IS NULL` is
-- added for PR-C's 1:N audience resolver ("every live, not-opted-out contact
-- of these members"). CORRECTION (staff review P1): PR-D's audience page CAN
-- plan against it. The `state=on` filter builds
-- `tenant_id = $1 AND removed_at IS NULL AND marketing_opt_out_at IS NULL` —
-- the partial predicate verbatim, with the index's leading column — and
-- `state=on` is half of the FR-027a pre-flight preset, not an obscure filter.
-- Only the DEFAULT (unfiltered) view does not imply it, and the dispatch
-- filter reads the complement. So: it is tiny (a partial over a mostly-NULL
-- column) and cheap on write, and PR-C MUST `EXPLAIN` **PR-D's `state=on`
-- count query** as well as its own resolver before considering a drop.
--
-- RLS. `tenant_isolation_on_contacts` (ENABLE + FORCE, 0009) covers the new
-- columns; no policy change. Erasure: the columns are classified KEPT in
-- `tests/unit/members/infrastructure/scrub-contacts-pii-column-coverage.test.ts`
-- — once the contact is scrubbed the preference carries no personal data.
--
-- REPLAYABLE: IF NOT EXISTS on the columns and the index; DROP CONSTRAINT IF
-- EXISTS before each ADD CONSTRAINT (ADD CONSTRAINT has no IF NOT EXISTS).
-- Adding NULLable columns without defaults is a catalog-only change on
-- Postgres — no table rewrite, no lock beyond the brief ACCESS EXCLUSIVE the
-- ALTER itself takes.

ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "marketing_opt_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "marketing_opt_out_source" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "marketing_opt_out_by_user_id" uuid;--> statement-breakpoint

-- Only the two sources the Domain union admits (data-model § 1).
ALTER TABLE "contacts" DROP CONSTRAINT IF EXISTS "contacts_marketing_opt_out_source_check";--> statement-breakpoint
ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_marketing_opt_out_source_check"
  CHECK ("marketing_opt_out_source" IS NULL OR "marketing_opt_out_source" IN ('staff', 'self'));--> statement-breakpoint

-- All null (receives) or all set (opted out) — never a partial preference.
ALTER TABLE "contacts" DROP CONSTRAINT IF EXISTS "contacts_marketing_opt_out_correlated";--> statement-breakpoint
ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_marketing_opt_out_correlated"
  CHECK (
    ("marketing_opt_out_at" IS NULL AND "marketing_opt_out_source" IS NULL AND "marketing_opt_out_by_user_id" IS NULL)
    OR
    ("marketing_opt_out_at" IS NOT NULL AND "marketing_opt_out_source" IS NOT NULL AND "marketing_opt_out_by_user_id" IS NOT NULL)
  );--> statement-breakpoint

-- For PR-C's audience resolver, and ALSO planned against by PR-D's `state=on`
-- filter — see the CORRECTION in the header before considering a drop.
CREATE INDEX IF NOT EXISTS "contacts_marketing_recipients_idx"
  ON "contacts" USING btree ("tenant_id", "member_id", "contact_id")
  WHERE removed_at IS NULL AND marketing_opt_out_at IS NULL;

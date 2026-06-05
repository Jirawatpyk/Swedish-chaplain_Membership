-- ---------------------------------------------------------------------------
-- Migration 0209 — Member Number: new tables, backfill, constraints
--
-- Creates:
--   - tenant_member_sequences  (per-tenant lifetime counter)
--   - tenant_member_settings   (per-tenant display prefix config)
--   - members.member_number    integer column (nullable -> backfill -> NOT NULL)
--
-- Backfill strategy:
--   PARTITION BY tenant_id is mandatory -- without it ROW_NUMBER() runs
--   globally across tenants (cross-tenant member-number collision bug).
--   Tie-break: ORDER BY created_at ASC, member_id ASC (deterministic).
--
-- Idempotency: single-shot ALTER TABLE for the column add (no IF NOT EXISTS
-- on column add -- mirrors migration 0094 idempotency comment lines 16-21:
-- a second pass must fail loudly instead of silently skipping the backfill +
-- SET NOT NULL steps). UNIQUE INDEX uses IF NOT EXISTS. Seeds use ON CONFLICT.
--
-- RLS: both new tables get ENABLE + FORCE + FOR ALL TO chamber_app policy --
-- pattern mirrors migration 0019 (tenant_document_sequences /
-- tenant_invoice_settings) and migration 0035 (tenant_payment_settings).
-- chamber_app is NOBYPASSRLS so the policy is the ONLY way rows are visible;
-- the TRUE second arg to current_setting() returns NULL when
-- app.current_tenant is unset -> zero rows visible (secure-by-default).
--
-- Tenant identity: there is no physical `tenants` table (tenant identity
-- lives in env `TENANT_SLUG` until F10 -- see 0019 / 0035 header notes).
-- The SweCham seed therefore uses the literal tenant_id 'swecham', matching
-- the F5 seed idiom in migration 0037. The SET LOCAL app.current_tenant must
-- sit in the SAME statement block as each seed INSERT (no statement-breakpoint
-- between them) because FORCE RLS subjects even the table owner to the policy
-- (migration 0037 header, lines 22-33).
--
-- Rollback: DROP TABLE CASCADE on 2 tables; ALTER TABLE members DROP
-- COLUMN member_number; or Neon PITR to pre-0209 snapshot.
-- ---------------------------------------------------------------------------

-- --- 1. tenant_member_sequences -------------------------------------------
-- Lifetime per-tenant counter. Distinct from F4 tenant_document_sequences
-- (which is keyed on (tenant_id, document_type, fiscal_year) and resets
-- yearly per RD §87). This counter never resets; gaps are acceptable
-- (no §87 sequential-numbering obligation for the internal member number).

CREATE TABLE "tenant_member_sequences" (
  "tenant_id"   text PRIMARY KEY,
  "last_number" integer NOT NULL DEFAULT 0
                  CHECK ("last_number" >= 0),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON TABLE "tenant_member_sequences" TO chamber_app;--> statement-breakpoint

ALTER TABLE "tenant_member_sequences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_member_sequences" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_tenant_member_sequences"
  ON "tenant_member_sequences"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- 2. tenant_member_settings --------------------------------------------
-- Per-tenant display prefix. Default 'M' applies for future tenants with no
-- explicit seed row. Prefix format ^[A-Z][A-Z0-9]{0,7}$ -- 1-8 chars,
-- leading uppercase alpha, then uppercase alpha + digits.

CREATE TABLE "tenant_member_settings" (
  "tenant_id"             text PRIMARY KEY,
  "member_number_prefix"  text NOT NULL DEFAULT 'M'
                            CHECK ("member_number_prefix" ~ '^[A-Z][A-Z0-9]{0,7}$'),
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "updated_at"            timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON TABLE "tenant_member_settings" TO chamber_app;--> statement-breakpoint

ALTER TABLE "tenant_member_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_member_settings" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_tenant_member_settings"
  ON "tenant_member_settings"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- 3. Seed SweCham prefix -------------------------------------------------
-- SET LOCAL + INSERT share one statement block (NO statement-breakpoint
-- between them) so FORCE RLS evaluates the WITH CHECK against the correct
-- tenant within the same implicit migration transaction. Pattern mirrors
-- migration 0037. There is no `tenants` table to look the slug up from
-- (see header) -- the literal 'swecham' tenant_id is authoritative.

SET LOCAL app.current_tenant = 'swecham';
INSERT INTO "tenant_member_settings" ("tenant_id", "member_number_prefix")
  VALUES ('swecham', 'SCCM')
  ON CONFLICT ("tenant_id") DO NOTHING;--> statement-breakpoint

-- --- 4. members.member_number column (single-shot, no IF NOT EXISTS) --------
-- Single-shot: no IF NOT EXISTS so a second pass fails loudly instead of
-- silently skipping the backfill + SET NOT NULL steps. See migration 0094
-- idempotency comment (lines 16-21) and design doc §6.

ALTER TABLE "members" ADD COLUMN "member_number" integer;--> statement-breakpoint

-- --- 5. Backfill: assign 1..N PER TENANT -----------------------------------
-- PARTITION BY tenant_id is mandatory -- without it ROW_NUMBER() runs
-- globally across tenants = cross-tenant member-number collision bug.
-- Deterministic tie-break: ORDER BY created_at ASC, member_id ASC.

UPDATE "members" m
SET    "member_number" = sub.rn
FROM (
  SELECT "tenant_id", "member_id",
         ROW_NUMBER() OVER (
           PARTITION BY "tenant_id"
           ORDER BY "created_at" ASC, "member_id" ASC
         ) AS rn
  FROM "members"
) sub
WHERE m."tenant_id" = sub."tenant_id"
  AND m."member_id" = sub."member_id";--> statement-breakpoint

-- --- 6. Loud-fail verification BEFORE SET NOT NULL -------------------------
-- Mirrors migration 0094 (Step 3, lines 87-97). Aborts the migration if any
-- row is still NULL so the SET NOT NULL below never runs on a partial backfill.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "members" WHERE "member_number" IS NULL) THEN
    RAISE EXCEPTION 'member_number backfill failed: % rows still NULL',
      (SELECT COUNT(*) FROM "members" WHERE "member_number" IS NULL);
  END IF;
END $$;--> statement-breakpoint

-- --- 7. Seed each tenant's counter to its current max ----------------------
-- next new member = last_number + 1 (allocator protocol, design doc §5).
-- SET LOCAL + INSERT share one statement block (see step 3 rationale).
-- ON CONFLICT DO UPDATE so a re-derived MAX after a partial run still
-- converges the counter to the true high-water mark.

SET LOCAL app.current_tenant = 'swecham';
INSERT INTO "tenant_member_sequences" ("tenant_id", "last_number")
  SELECT "tenant_id", MAX("member_number")
  FROM   "members"
  GROUP  BY "tenant_id"
  ON CONFLICT ("tenant_id")
    DO UPDATE SET "last_number" = EXCLUDED."last_number";--> statement-breakpoint

-- --- 8. Tighten column to NOT NULL -----------------------------------------

ALTER TABLE "members"
  ALTER COLUMN "member_number" SET NOT NULL;--> statement-breakpoint

-- --- 9. Unique index (IF NOT EXISTS safe -- no SET NOT NULL interaction) ----
-- Per-tenant uniqueness on the human-readable number.

CREATE UNIQUE INDEX IF NOT EXISTS "members_tenant_member_number_uniq"
  ON "members" USING btree ("tenant_id", "member_number");--> statement-breakpoint

-- --- 10. Positive check constraint -----------------------------------------

ALTER TABLE "members"
  ADD CONSTRAINT "members_member_number_positive"
    CHECK ("member_number" > 0);--> statement-breakpoint

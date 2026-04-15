-- ---------------------------------------------------------------------------
-- F3 — Members & Contacts tables + RLS + pg_trgm search + activity trigger
--
-- This migration ships the data-model.md authoritative schema for:
--   - members  — aggregate root
--   - contacts — child entity of member
--
-- It creates the `member_status` enum + both tables, then appends hand-written
-- SQL blocks that drizzle-kit cannot emit from a `pgTable()` definition:
--   1. pg_trgm extension + GIN trigram indexes (SC-002 substring search)
--   2. Composite FKs (contacts→members, members→membership_plans)
--   3. linked_user_id FK to users(id)
--   4. CHECK constraints for Domain invariants (tax_id format, archived_at
--      ⇔ status='archived', founded_year range, turnover non-negative)
--   5. chamber_app DML grants + member_status enum USAGE grant
--   6. RLS ENABLE + FORCE + tenant-isolation policies
--   7. audit_log trigger that updates members.last_activity_at in the
--      SAME transaction as the audit-log insert (R2-E3 — denormalized
--      field stays consistent without a runtime join)
--
-- The 23 new `audit_event_type` enum values land in migration 0010 because
-- Postgres forbids `ALTER TYPE ... ADD VALUE` inside a transaction block that
-- also uses the newly-added value — splitting keeps each migration atomic.
--
-- Index strategy: non-CONCURRENTLY CREATE INDEX is acceptable here because
-- both tables are empty at creation time. Subsequent large-table index
-- operations (if any) would use CREATE INDEX CONCURRENTLY outside a tx block
-- in a separate migration file.
-- ---------------------------------------------------------------------------

-- --- 1. New enum -----------------------------------------------------------

CREATE TYPE "public"."member_status" AS ENUM ('active', 'inactive', 'archived');--> statement-breakpoint

-- --- 2. members table ------------------------------------------------------

CREATE TABLE "members" (
	"tenant_id" text NOT NULL,
	"member_id" uuid NOT NULL,
	"company_name" text NOT NULL,
	"legal_entity_type" text,
	"country" char(2) NOT NULL,
	"tax_id" text,
	"website" text,
	"description" text,
	"founded_year" integer,
	"turnover_thb" bigint,
	"plan_id" text NOT NULL,
	"plan_year" integer NOT NULL,
	"registration_date" date DEFAULT now() NOT NULL,
	"registration_fee_paid" boolean DEFAULT false NOT NULL,
	"last_activity_at" timestamp with time zone,
	"notes" text,
	"status" "member_status" DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_pkey" PRIMARY KEY ("tenant_id","member_id")
);--> statement-breakpoint

-- --- 3. contacts table -----------------------------------------------------

CREATE TABLE "contacts" (
	"tenant_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"role_title" text,
	"preferred_language" char(2) DEFAULT 'en' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"date_of_birth" date,
	"linked_user_id" uuid,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_pkey" PRIMARY KEY ("tenant_id","contact_id")
);--> statement-breakpoint

-- --- 4. Standard btree indexes ---------------------------------------------

CREATE INDEX "members_tenant_status_plan_idx"   ON "members"  USING btree ("tenant_id","status","plan_id");--> statement-breakpoint
CREATE INDEX "members_tenant_year_idx"          ON "members"  USING btree ("tenant_id","plan_year");--> statement-breakpoint
CREATE INDEX "members_tenant_last_activity_idx" ON "members"  USING btree ("tenant_id","last_activity_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "contacts_tenant_member_idx"       ON "contacts" USING btree ("tenant_id","member_id") WHERE removed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_tenant_email_uniq"       ON "contacts" USING btree ("tenant_id", lower("email")) WHERE removed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_one_primary_per_member"  ON "contacts" USING btree ("tenant_id","member_id") WHERE is_primary = TRUE AND removed_at IS NULL;--> statement-breakpoint

-- --- 5. pg_trgm substring-search indexes (SC-002) --------------------------
--
-- pg_trgm ships with Neon but is not enabled by default. CREATE EXTENSION
-- IF NOT EXISTS is idempotent — safe to re-run.

CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint

CREATE INDEX "members_company_name_trgm_gin"
  ON "members" USING GIN ("company_name" gin_trgm_ops);--> statement-breakpoint

CREATE INDEX "contacts_name_trgm_gin"
  ON "contacts" USING GIN ((first_name || ' ' || last_name) gin_trgm_ops)
  WHERE removed_at IS NULL;--> statement-breakpoint

-- audit_log timeline accelerator — `payload->>'member_id'` lookup (US6)
CREATE INDEX "audit_log_member_id_idx"
  ON "audit_log" ((payload->>'member_id'))
  WHERE payload ? 'member_id';--> statement-breakpoint

-- --- 6. Foreign keys -------------------------------------------------------
--
-- Composite FK contacts (tenant_id, member_id) → members — ensures a contact
-- cannot float free of its parent, and cross-tenant FK violations are
-- rejected at the DB layer even if RLS is bypassed.

ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_member_tenant_fk"
  FOREIGN KEY ("tenant_id","member_id")
  REFERENCES "members" ("tenant_id","member_id")
  ON DELETE RESTRICT
  ON UPDATE NO ACTION;--> statement-breakpoint

-- Composite FK members (tenant_id, plan_id, plan_year) → membership_plans.
-- Enforces that a member's plan binding refers to a real year-versioned
-- plan record in the same tenant.

ALTER TABLE "members"
  ADD CONSTRAINT "members_plan_tenant_year_fk"
  FOREIGN KEY ("tenant_id","plan_id","plan_year")
  REFERENCES "membership_plans" ("tenant_id","plan_id","plan_year")
  ON DELETE RESTRICT
  ON UPDATE NO ACTION;--> statement-breakpoint

-- linked_user_id → users(id). Domain treats UserId as an opaque branded
-- type (plan E2) but the FK at the DB layer is a separate concern.

ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_linked_user_fk"
  FOREIGN KEY ("linked_user_id")
  REFERENCES "users" ("id")
  ON DELETE SET NULL
  ON UPDATE NO ACTION;--> statement-breakpoint

-- --- 7. CHECK constraints for Domain invariants ----------------------------
--
-- Double-guard at the DB layer so invariants hold even if a future seed
-- script or manual SQL edit bypasses the Domain validator.

ALTER TABLE "members"
  ADD CONSTRAINT "members_company_name_length"
  CHECK (char_length("company_name") BETWEEN 1 AND 200);--> statement-breakpoint

ALTER TABLE "members"
  ADD CONSTRAINT "members_legal_entity_type_length"
  CHECK ("legal_entity_type" IS NULL OR char_length("legal_entity_type") <= 100);--> statement-breakpoint

ALTER TABLE "members"
  ADD CONSTRAINT "members_tax_id_length"
  CHECK ("tax_id" IS NULL OR char_length("tax_id") <= 50);--> statement-breakpoint

ALTER TABLE "members"
  ADD CONSTRAINT "members_website_length"
  CHECK ("website" IS NULL OR char_length("website") <= 200);--> statement-breakpoint

ALTER TABLE "members"
  ADD CONSTRAINT "members_description_length"
  CHECK ("description" IS NULL OR char_length("description") <= 2000);--> statement-breakpoint

ALTER TABLE "members"
  ADD CONSTRAINT "members_notes_length"
  CHECK ("notes" IS NULL OR char_length("notes") <= 4000);--> statement-breakpoint

ALTER TABLE "members"
  ADD CONSTRAINT "members_founded_year_range"
  CHECK ("founded_year" IS NULL OR ("founded_year" >= 1800 AND "founded_year" <= EXTRACT(YEAR FROM CURRENT_DATE)::int));--> statement-breakpoint

ALTER TABLE "members"
  ADD CONSTRAINT "members_founded_year_vs_registration"
  CHECK ("founded_year" IS NULL OR "founded_year" <= EXTRACT(YEAR FROM "registration_date")::int);--> statement-breakpoint

ALTER TABLE "members"
  ADD CONSTRAINT "members_turnover_non_negative"
  CHECK ("turnover_thb" IS NULL OR "turnover_thb" >= 0);--> statement-breakpoint

ALTER TABLE "members"
  ADD CONSTRAINT "members_plan_year_range"
  CHECK ("plan_year" BETWEEN 2020 AND 2100);--> statement-breakpoint

-- archived_at non-NULL iff status = 'archived'
ALTER TABLE "members"
  ADD CONSTRAINT "members_archived_at_iff_archived"
  CHECK (
    ("status" = 'archived' AND "archived_at" IS NOT NULL)
    OR ("status" <> 'archived' AND "archived_at" IS NULL)
  );--> statement-breakpoint

-- Thai tax-id 13-digit format (checksum validated in Domain)
ALTER TABLE "members"
  ADD CONSTRAINT "members_th_tax_id_format"
  CHECK (
    "country" <> 'TH'
    OR "tax_id" IS NULL
    OR "tax_id" ~ '^[0-9]{13}$'
  );--> statement-breakpoint

ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_first_name_length"
  CHECK (char_length("first_name") BETWEEN 1 AND 100);--> statement-breakpoint

ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_last_name_length"
  CHECK (char_length("last_name") BETWEEN 1 AND 100);--> statement-breakpoint

ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_email_length"
  CHECK (char_length("email") <= 254);--> statement-breakpoint

ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_phone_length"
  CHECK ("phone" IS NULL OR char_length("phone") <= 20);--> statement-breakpoint

ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_role_title_length"
  CHECK ("role_title" IS NULL OR char_length("role_title") <= 100);--> statement-breakpoint

ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_preferred_language_enum"
  CHECK ("preferred_language" IN ('en','th','sv'));--> statement-breakpoint

-- A removed contact cannot be primary (Domain invariant, enforced at DB).
ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_primary_not_removed"
  CHECK (NOT ("is_primary" = TRUE AND "removed_at" IS NOT NULL));--> statement-breakpoint

-- --- 8. chamber_app grants (RLS prerequisite) ------------------------------
--
-- F2 established chamber_app as the NOBYPASSRLS role that app requests run as
-- (see migration 0006 for full rationale). F3 extends it with DML on the two
-- new tables + USAGE on the member_status enum.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "members"  TO chamber_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "contacts" TO chamber_app;--> statement-breakpoint
GRANT USAGE ON TYPE "public"."member_status" TO chamber_app;--> statement-breakpoint

-- --- 9. Row-Level Security (Constitution v1.4.0 Principle I clause 2) ------
--
-- ENABLE + FORCE on both tables; chamber_app's NOBYPASSRLS means the policies
-- are the ONLY way rows are visible. TRUE second arg to current_setting
-- returns NULL if `app.current_tenant` is unset → zero rows visible
-- (secure-by-default).

ALTER TABLE "members"  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "members"  FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_members"
  ON "members"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contacts" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_contacts"
  ON "contacts"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- 10. last_activity_at denorm trigger (T011, R2-E3) ---------------------
--
-- When an audit_log row lands, if it carries a `member_id` in payload, bump
-- `members.last_activity_at` to the audit row's timestamp in the SAME
-- transaction — directory ORDER BY stays correct without a runtime join.
-- The trigger must be SECURITY DEFINER so it bypasses RLS when audit_log
-- writes are made from a tenant context (audit_log permits NULL tenant_id
-- rows; members does not). `SET search_path = public, pg_catalog` prevents
-- search-path injection inside the SECURITY DEFINER body.

CREATE OR REPLACE FUNCTION public.members_audit_bump_last_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_member_id uuid;
BEGIN
  -- Extract member_id from the audit payload; skip if missing or malformed.
  IF NEW.payload IS NULL OR NOT (NEW.payload ? 'member_id') THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_member_id := (NEW.payload->>'member_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NEW;
  END;

  -- Update scoped to the audit row's tenant_id so we never bump a row in
  -- another tenant even if a forged payload sneaks past the app layer.
  -- NEW.tenant_id can legitimately be NULL for F1 identity events — those
  -- never carry member_id so we already returned above.
  UPDATE members
     SET last_activity_at = NEW."timestamp"
   WHERE member_id = v_member_id
     AND tenant_id = NEW.tenant_id;

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Grant EXECUTE to chamber_app; without it the INSERT on audit_log from an
-- app session cannot fire the AFTER trigger.
GRANT EXECUTE ON FUNCTION public.members_audit_bump_last_activity() TO chamber_app;--> statement-breakpoint

CREATE TRIGGER "audit_log_bump_member_last_activity"
  AFTER INSERT ON "audit_log"
  FOR EACH ROW
  EXECUTE FUNCTION public.members_audit_bump_last_activity();

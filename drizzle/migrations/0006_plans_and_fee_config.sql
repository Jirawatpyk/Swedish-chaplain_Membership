CREATE TYPE "public"."directory_ad_position" AS ENUM('pages_1_and_2', 'first_pages', 'first_10_pages');--> statement-breakpoint
CREATE TYPE "public"."directory_listing_size" AS ENUM('full_page', 'half_page', 'eighth_page');--> statement-breakpoint
CREATE TYPE "public"."event_discount_scope" AS ENUM('all_employees', 'one_ticket_per_event', 'none');--> statement-breakpoint
CREATE TYPE "public"."homepage_logo_category" AS ENUM('premium', 'large', 'regular', 'start_up');--> statement-breakpoint
CREATE TYPE "public"."member_type_scope" AS ENUM('company', 'individual', 'both');--> statement-breakpoint
CREATE TYPE "public"."plan_category" AS ENUM('corporate', 'partnership');--> statement-breakpoint
CREATE TYPE "public"."video_frequency_scope" AS ENUM('all_events', 'three_selected_events');--> statement-breakpoint
CREATE TYPE "public"."website_page_type" AS ENUM('member_news_update', 'smes_spotlight', 'student_intern_cv');--> statement-breakpoint
CREATE TABLE "membership_plans" (
	"tenant_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"plan_year" integer NOT NULL,
	"plan_name" jsonb NOT NULL,
	"description" jsonb DEFAULT '{"en":""}'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"plan_category" "plan_category" NOT NULL,
	"member_type_scope" "member_type_scope" NOT NULL,
	"annual_fee_minor_units" integer NOT NULL,
	"includes_corporate_plan_id" text,
	"min_turnover_minor_units" integer,
	"max_turnover_minor_units" integer,
	"max_duration_years" integer,
	"max_member_age" integer,
	"benefit_matrix" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "membership_plans_pkey" PRIMARY KEY("tenant_id","plan_id","plan_year")
);
--> statement-breakpoint
CREATE TABLE "tenant_fee_config" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"currency_code" text NOT NULL,
	"vat_rate" numeric(5, 4) NOT NULL,
	"registration_fee_minor_units" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "membership_plans" ADD CONSTRAINT "membership_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_plans" ADD CONSTRAINT "membership_plans_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_fee_config" ADD CONSTRAINT "tenant_fee_config_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "membership_plans_tenant_year_idx" ON "membership_plans" USING btree ("tenant_id","plan_year") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "membership_plans_tenant_category_idx" ON "membership_plans" USING btree ("tenant_id","plan_category") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "membership_plans_tenant_active_idx" ON "membership_plans" USING btree ("tenant_id","is_active") WHERE deleted_at IS NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- F2 integrity CHECK constraints (data-model.md § 3.2, § 3.3)
--
-- drizzle-kit does not emit CHECK constraints from the pgTable()
-- definition, so they are appended as a hand-written SQL block. A
-- forgotten CHECK is a data-integrity bug class, and having them at the
-- database layer means bad data never lands even if the Domain validator
-- is bypassed by a future seed script or manual SQL edit.
-- ---------------------------------------------------------------------------

ALTER TABLE "membership_plans"
  ADD CONSTRAINT "membership_plans_annual_fee_non_negative"
  CHECK ("annual_fee_minor_units" >= 0);--> statement-breakpoint
ALTER TABLE "membership_plans"
  ADD CONSTRAINT "membership_plans_min_turnover_non_negative"
  CHECK ("min_turnover_minor_units" IS NULL OR "min_turnover_minor_units" >= 0);--> statement-breakpoint
ALTER TABLE "membership_plans"
  ADD CONSTRAINT "membership_plans_max_turnover_non_negative"
  CHECK ("max_turnover_minor_units" IS NULL OR "max_turnover_minor_units" >= 0);--> statement-breakpoint
ALTER TABLE "membership_plans"
  ADD CONSTRAINT "membership_plans_max_duration_positive"
  CHECK ("max_duration_years" IS NULL OR "max_duration_years" > 0);--> statement-breakpoint
ALTER TABLE "membership_plans"
  ADD CONSTRAINT "membership_plans_max_age_range"
  CHECK ("max_member_age" IS NULL OR ("max_member_age" > 0 AND "max_member_age" < 200));--> statement-breakpoint
ALTER TABLE "membership_plans"
  ADD CONSTRAINT "membership_plans_partnership_bundles_corporate"
  CHECK (
    ("plan_category" = 'partnership' AND "includes_corporate_plan_id" IS NOT NULL)
    OR ("plan_category" = 'corporate' AND "includes_corporate_plan_id" IS NULL)
  );--> statement-breakpoint
ALTER TABLE "membership_plans"
  ADD CONSTRAINT "membership_plans_turnover_range_ordered"
  CHECK (
    "min_turnover_minor_units" IS NULL
    OR "max_turnover_minor_units" IS NULL
    OR "min_turnover_minor_units" < "max_turnover_minor_units"
  );--> statement-breakpoint

ALTER TABLE "tenant_fee_config"
  ADD CONSTRAINT "tenant_fee_config_vat_rate_range"
  CHECK ("vat_rate" >= 0 AND "vat_rate" < 1);--> statement-breakpoint
ALTER TABLE "tenant_fee_config"
  ADD CONSTRAINT "tenant_fee_config_registration_fee_non_negative"
  CHECK ("registration_fee_minor_units" >= 0);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- F2 Application role (`chamber_app`) — CRITICAL for RLS to actually fire
--
-- Neon's default integration role (`neondb_owner`) has `rolbypassrls = TRUE`,
-- which silently turns `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`
-- into a no-op. Verified empirically on Neon Singapore 2026-04-11 — see
-- specs/002-membership-plans/research.md § 2.4 "CRITICAL FINDING".
--
-- Fix: create a separate non-login role `chamber_app` with NOBYPASSRLS,
-- grant the owner membership in it, and require every runInTenant() call
-- to issue `SET LOCAL ROLE chamber_app` as its first statement. Only then
-- do the RLS policies defined below actually filter rows.
--
-- This role is ALSO the grant target for every F2 tenant-scoped table's
-- DML privileges — `chamber_app` has SELECT/INSERT/UPDATE/DELETE; it
-- does NOT have DDL (so drizzle-kit migrate continues to run as the owner).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chamber_app') THEN
    CREATE ROLE chamber_app NOLOGIN NOBYPASSRLS;
  END IF;
END$$;--> statement-breakpoint

-- Owner must be a member of chamber_app to be allowed to SET ROLE to it
-- from within runInTenant. Idempotent — the grant statement is a no-op
-- if the membership already exists.
GRANT chamber_app TO CURRENT_USER;--> statement-breakpoint

-- Grant DML to chamber_app on both F2 tables. DDL stays with the owner.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "membership_plans" TO chamber_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "tenant_fee_config" TO chamber_app;--> statement-breakpoint

-- USAGE on the 8 new F2 pgEnums is required for chamber_app to write
-- enum-typed columns (plan_category, member_type_scope, etc.). Without
-- these grants an INSERT with an enum value fails with a
-- "permission denied for type ..." error even though the table grant is fine.
GRANT USAGE ON TYPE "public"."plan_category" TO chamber_app;--> statement-breakpoint
GRANT USAGE ON TYPE "public"."member_type_scope" TO chamber_app;--> statement-breakpoint
GRANT USAGE ON TYPE "public"."directory_listing_size" TO chamber_app;--> statement-breakpoint
GRANT USAGE ON TYPE "public"."event_discount_scope" TO chamber_app;--> statement-breakpoint
GRANT USAGE ON TYPE "public"."website_page_type" TO chamber_app;--> statement-breakpoint
GRANT USAGE ON TYPE "public"."homepage_logo_category" TO chamber_app;--> statement-breakpoint
GRANT USAGE ON TYPE "public"."directory_ad_position" TO chamber_app;--> statement-breakpoint
GRANT USAGE ON TYPE "public"."video_frequency_scope" TO chamber_app;--> statement-breakpoint

-- chamber_app needs SELECT on `users` because membership_plans has an FK to
-- users(id) on `created_by` / `updated_by` and INSERT validates the FK.
-- Without this grant a runInTenant INSERT fails with "permission denied
-- for table users".
GRANT SELECT ON TABLE "users" TO chamber_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- F2 Row-Level Security policies (Constitution v1.4.0 Principle I clause 2)
--
-- Both tables enable RLS + FORCE RLS (FORCE makes the policy apply even to
-- the table owner — combined with chamber_app NOBYPASSRLS this is a
-- defence-in-depth layer that catches "I forgot SET LOCAL ROLE" bugs).
--
-- The policy reads from `current_setting('app.current_tenant', TRUE)` —
-- the TRUE second argument returns NULL instead of raising when the GUC
-- is unset, which combined with the `tenant_id = ...` comparison results
-- in ZERO visible rows (secure-by-default).
--
-- `WITH CHECK` applies to INSERT / UPDATE — an attempt to write a row
-- with a mismatched tenant_id is rejected at the database layer.
-- ---------------------------------------------------------------------------

ALTER TABLE "membership_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "membership_plans" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_membership_plans"
  ON "membership_plans"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

ALTER TABLE "tenant_fee_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_fee_config" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_fee_config"
  ON "tenant_fee_config"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));
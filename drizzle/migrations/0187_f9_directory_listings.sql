-- ---------------------------------------------------------------------------
-- F9 (T008) — directory_listings table (US5, ships dark in Foundational).
--
-- Source of truth: specs/015-admin-dashboard/data-model.md § 3 + spec FR-025.
--
-- One row per member: directory visibility + per-field exposure. DEFAULT
-- PRIVATE (listed=false), email default-hidden. Stores only directory-specific
-- metadata + toggles — name/tier/contact_name are sourced LIVE from
-- members/contacts (not duplicated). Published outputs (E-Book/JSON) include a
-- member only if listed=true and only fields with field_visibility[field]=true.
--
-- FK references the members composite PK (tenant_id, member_id). website is
-- scheme-restricted (http/https) and description is length-capped at the DB
-- layer as defence-in-depth (app layer validates too — data-model § 3).
--
-- Tenant isolation: RLS + FORCE + policy + chamber_app GRANT (Principle I).
--
-- Rollback:
--   DROP POLICY "tenant_isolation_on_directory_listings" ON "directory_listings";
--   DROP TABLE "directory_listings";
-- ---------------------------------------------------------------------------

CREATE TABLE "directory_listings" (
  "tenant_id"         text        NOT NULL,
  "member_id"         uuid        NOT NULL,
  "listed"            boolean     NOT NULL DEFAULT false,
  "field_visibility"  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "industry"          text,
  "description"       text,
  "website"           text,
  "logo_blob_key"     text,
  "location_city"     text,
  "location_country"  text,
  "updated_at"        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "directory_listings_pkey" PRIMARY KEY ("tenant_id", "member_id"),

  CONSTRAINT "directory_listings_member_fk"
    FOREIGN KEY ("tenant_id", "member_id")
    REFERENCES "members" ("tenant_id", "member_id")
    ON DELETE CASCADE,

  CONSTRAINT "directory_listings_website_scheme_check"
    CHECK ("website" IS NULL OR "website" ~* '^https?://'),

  CONSTRAINT "directory_listings_description_length_check"
    CHECK ("description" IS NULL OR length("description") <= 500)
);--> statement-breakpoint

ALTER TABLE "directory_listings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "directory_listings" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation_on_directory_listings"
  ON "directory_listings"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "directory_listings"
  TO chamber_app;

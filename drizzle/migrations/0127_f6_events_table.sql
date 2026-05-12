-- ---------------------------------------------------------------------------
-- F6 Phase 2 Foundational · T006 — events table.
--
-- One row per event imported from EventCreate (or future source).
-- Identified per tenant by (source, external_id) — see UNIQUE INDEX in
-- migration 0130.
--
-- Source of truth: specs/012-eventcreate-integration/data-model.md § 1.1.
--
-- Lifecycle:
--   - Created by webhook ingest (FR-010 last-write-wins upsert) or CSV import.
--   - `archived_at` set by admin archive action (FR-019a) — registrations
--     continue to flow but apply-quota-effect short-circuits to neutral.
--   - `metadata jsonb` preserves unknown EventCreate fields (FR-011a
--     forward-compat).
--
-- RLS+FORCE policies for this table live in migration 0133 (one combined
-- migration covering the first 3 F6 tables, per tasks.md T012 separation).
-- The 4th F6 table (eventcreate_idempotency_receipts) carries its own
-- RLS+FORCE inline in migration 0134.
--
-- Indexes: 4 non-unique partial indexes + 1 unique index live in migration
-- 0130 (separated per tasks.md T009). Non-CONCURRENTLY because the table
-- is empty at creation (F8 precedent 0100 documented the migrator
-- compatibility constraint).
-- ---------------------------------------------------------------------------

CREATE TABLE "events" (
  "tenant_id"          text NOT NULL,
  "event_id"           uuid NOT NULL DEFAULT gen_random_uuid(),

  -- Source identity (FR-001 schema-versioned, FR-010 upsert key).
  "source"             text NOT NULL DEFAULT 'eventcreate',
  "external_id"        text NOT NULL,

  -- Event metadata (last-write-wins on upsert per FR-010).
  "name"               text NOT NULL,
  "description"        text,
  "start_date"         timestamptz NOT NULL,
  "end_date"           timestamptz,
  "location"           text,
  "category"           text,
  "eventcreate_url"    text,

  -- Benefit-classification flags (admin-toggleable per FR-019).
  "is_partner_benefit" boolean NOT NULL DEFAULT false,
  "is_cultural_event"  boolean NOT NULL DEFAULT false,

  -- Lifecycle (FR-019a admin-archive). NULL = active.
  "archived_at"        timestamptz,

  -- Forward-compat (FR-011a) — preserves unknown payload fields verbatim.
  -- Default '{}'::jsonb so older code paths never see NULL.
  "metadata"           jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Audit timestamps.
  "imported_at"        timestamptz NOT NULL DEFAULT now(),
  "last_updated_at"    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "events_pk"
    PRIMARY KEY ("tenant_id", "event_id"),

  -- CHECK on source — extensible via future migration (e.g., 'eventbrite').
  CONSTRAINT "events_source_check"
    CHECK ("source" IN ('eventcreate'))
);--> statement-breakpoint

-- --- updated_at touch trigger (standard project pattern) --------------------
CREATE OR REPLACE FUNCTION events_set_last_updated_at_fn()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;--> statement-breakpoint

CREATE TRIGGER events_set_last_updated_at
  BEFORE UPDATE ON "events"
  FOR EACH ROW
  EXECUTE FUNCTION events_set_last_updated_at_fn();--> statement-breakpoint

-- --- Grants for chamber_app role --------------------------------------------
-- RLS+FORCE policy (migration 0133) enforces tenant isolation; the app
-- connects via chamber_app and never bypasses RLS.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "events"
  TO chamber_app;--> statement-breakpoint

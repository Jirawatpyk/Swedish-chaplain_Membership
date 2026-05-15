-- ---------------------------------------------------------------------------
-- F6.1 — CSV Import Records (Feature 013 · T003 · Phase 2 Foundational)
--
-- One row per CSV upload attempt — source-of-truth for the F6.1 import
-- history feature (FR-020 / FR-022) and back-reference target for the
-- error-CSV signed-URL download (FR-021).
--
-- Source of truth: specs/013-csv-import-eventcreate-format/data-model.md § 1.
--
-- Lifecycle:
--   1. INSERT placeholder row at start of import use-case
--      (outcome='unexpected_error' placeholder; updated at end).
--   2. UPDATE final outcome + counts + duration_ms.
--   3. If rows_failed > 0: separate use-case writes error rows to private
--      Vercel Blob, then UPDATE error_csv_blob_url + error_csv_expires_at
--      (uploaded_at + 30 days).
--   4. Daily TTL sweep cron deletes the Blob + NULLs error_csv_blob_url.
--   5. Row itself persists indefinitely (counts are low-PII; tenant
--      retention policy controls archival).
--
-- Indexes:
--   - tenant + uploaded_at DESC — history page reverse-chrono pagination
--   - tenant + event_id — per-event history filter
--   - error_csv_expires_at partial WHERE NOT NULL — TTL sweep cron query
--   - tenant + actor_user_id + uploaded_at DESC — admin own-history filter
--   - tenant + attendee_fingerprint + uploaded_at DESC partial WHERE NOT
--     NULL — FR-019b event-mismatch safety net query
--
-- RLS+FORCE pattern mirrors 0009_members_contacts.sql:252-268 — chamber_app
-- role with NOBYPASSRLS + tenant-isolation policy using
-- current_setting('app.current_tenant', TRUE) (TRUE second arg returns
-- NULL if unset → secure-by-default zero rows visible).
-- ---------------------------------------------------------------------------

CREATE TABLE "csv_import_records" (
  "record_id"                      uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"                      text NOT NULL,
  "actor_user_id"                  uuid NOT NULL,
  "event_id"                       uuid NOT NULL,
  "uploaded_at"                    timestamptz NOT NULL DEFAULT now(),

  -- Adapter detection result (FR-025 / R2). CHECK enforces closed set.
  "source_format"                  text NOT NULL,

  "original_filename"              text NOT NULL,
  "original_size_bytes"            integer NOT NULL,

  -- Row-count breakdown (FR-020 / FR-022 surface to history page).
  "rows_total"                     integer NOT NULL,
  "rows_processed"                 integer NOT NULL,
  "rows_already_imported"          integer NOT NULL,
  "rows_skipped"                   integer NOT NULL,
  "rows_failed"                    integer NOT NULL,

  -- Use-case discriminated-union outcome (data-model.md § 1).
  "outcome"                        text NOT NULL,

  "duration_ms"                    integer NOT NULL,

  -- Error-CSV blob lifecycle (FR-021 / Q4 — private bucket + 15-min signed
  -- URL + 30-day TTL). NULL until use-case writes error rows; NULLed
  -- again by daily TTL sweep.
  "error_csv_blob_url"             text,
  "error_csv_expires_at"           timestamptz,

  -- Adapter telemetry — captures unknown-column-names list (FR-012) and
  -- payment-status-unknown samples (R5) for product-team review of
  -- EventCreate schema evolution. NULL for generic_csv format.
  "eventcreate_adapter_metadata"   jsonb,

  -- FR-019a / X-R2-1 — attendee fingerprint for the event-mismatch
  -- safety net. SHA-256 truncated to 16 hex chars over the sorted,
  -- lowercased Attending-only email list. NULL only for legacy or
  -- migrated rows; new imports always populate.
  "attendee_fingerprint"           text,

  "created_at"                     timestamptz NOT NULL DEFAULT now(),
  "updated_at"                     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "csv_import_records_pk"
    PRIMARY KEY ("tenant_id", "record_id"),

  -- File-cap checks (Phase 7 5 MiB + 1k rows envelope retained).
  CONSTRAINT "csv_import_records_original_size_bytes_check"
    CHECK ("original_size_bytes" > 0 AND "original_size_bytes" <= 5242880),
  CONSTRAINT "csv_import_records_original_filename_length_check"
    CHECK (char_length("original_filename") <= 255),

  -- Non-negative count invariants.
  CONSTRAINT "csv_import_records_rows_total_check"
    CHECK ("rows_total" >= 0),
  CONSTRAINT "csv_import_records_rows_processed_check"
    CHECK ("rows_processed" >= 0),
  CONSTRAINT "csv_import_records_rows_already_imported_check"
    CHECK ("rows_already_imported" >= 0),
  CONSTRAINT "csv_import_records_rows_skipped_check"
    CHECK ("rows_skipped" >= 0),
  CONSTRAINT "csv_import_records_rows_failed_check"
    CHECK ("rows_failed" >= 0),
  CONSTRAINT "csv_import_records_duration_ms_check"
    CHECK ("duration_ms" >= 0),

  -- Closed-set enums (data-model.md § 1).
  CONSTRAINT "csv_import_records_source_format_check"
    CHECK ("source_format" IN ('eventcreate_csv','generic_csv')),
  CONSTRAINT "csv_import_records_outcome_check"
    CHECK ("outcome" IN (
      'completed','timeout','partial_failure','invalid_header',
      'event_not_found','event_not_owned_by_tenant','unexpected_error'
    )),

  -- FR-019a fingerprint is SHA-256 hex truncated to 16 chars — fixed
  -- length defends against accidental short-hash collisions in queries.
  CONSTRAINT "csv_import_records_attendee_fingerprint_length_check"
    CHECK ("attendee_fingerprint" IS NULL OR char_length("attendee_fingerprint") = 16),

  -- Composite FK to events (mirror event_registrations FK in 0128).
  -- ON DELETE RESTRICT — preserve audit trail; admins must archive
  -- import history before deleting an event (which is itself rare).
  CONSTRAINT "csv_import_records_event_fk"
    FOREIGN KEY ("tenant_id", "event_id")
    REFERENCES "events" ("tenant_id", "event_id")
    ON DELETE RESTRICT,

  CONSTRAINT "csv_import_records_actor_fk"
    FOREIGN KEY ("actor_user_id")
    REFERENCES "users" ("id")
    ON DELETE RESTRICT
);--> statement-breakpoint

-- --- Indexes (data-model.md § 1 — 5 indexes) -------------------------------

CREATE INDEX "idx_csv_import_records_tenant_uploaded_at_desc"
  ON "csv_import_records" ("tenant_id", "uploaded_at" DESC);--> statement-breakpoint

CREATE INDEX "idx_csv_import_records_tenant_event_id"
  ON "csv_import_records" ("tenant_id", "event_id");--> statement-breakpoint

CREATE INDEX "idx_csv_import_records_error_csv_expires_at"
  ON "csv_import_records" ("error_csv_expires_at")
  WHERE "error_csv_expires_at" IS NOT NULL;--> statement-breakpoint

CREATE INDEX "idx_csv_import_records_actor_uploaded_at_desc"
  ON "csv_import_records" ("tenant_id", "actor_user_id", "uploaded_at" DESC);--> statement-breakpoint

CREATE INDEX "idx_csv_import_records_tenant_fingerprint_uploaded_at"
  ON "csv_import_records" ("tenant_id", "attendee_fingerprint", "uploaded_at" DESC)
  WHERE "attendee_fingerprint" IS NOT NULL;--> statement-breakpoint

-- --- updated_at touch trigger (standard project pattern) -------------------

CREATE OR REPLACE FUNCTION csv_import_records_set_updated_at_fn()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;--> statement-breakpoint

CREATE TRIGGER csv_import_records_set_updated_at
  BEFORE UPDATE ON "csv_import_records"
  FOR EACH ROW
  EXECUTE FUNCTION csv_import_records_set_updated_at_fn();--> statement-breakpoint

-- --- Grants for chamber_app role -------------------------------------------
-- RLS+FORCE policy below enforces tenant isolation; the app connects via
-- chamber_app and never bypasses RLS.

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "csv_import_records"
  TO chamber_app;--> statement-breakpoint

-- --- Row-Level Security (Constitution v1.4.0 Principle I clause 2) ---------
--
-- ENABLE + FORCE + tenant-isolation policy. chamber_app's NOBYPASSRLS
-- means this policy is the ONLY way rows are visible. TRUE second arg to
-- current_setting returns NULL if `app.current_tenant` is unset → zero
-- rows visible (secure-by-default).

ALTER TABLE "csv_import_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "csv_import_records" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_csv_import_records"
  ON "csv_import_records"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

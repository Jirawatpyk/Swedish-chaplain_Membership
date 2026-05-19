-- ---------------------------------------------------------------------------
-- F6.1 — CSV-import audit event types (Feature 013 · T008 enum support)
--
-- Adds 3 new values to `audit_event_type` so the F6.1 surface can persist
-- audit rows for:
--
--   - csv_import_error_csv_downloaded     (info  — PII access trail per
--                                          Q4; fired by the signed-URL
--                                          route at US5 deferral surface)
--   - csv_import_cross_tenant_probe       (high  — Constitution Principle
--                                          I clause 4 high-severity event;
--                                          fired by the signed-URL route
--                                          when recordId belongs to
--                                          another tenant)
--   - csv_import_event_mismatch_overridden (warn  — FR-019c; fired by the
--                                          import use-case when admin
--                                          re-submits with
--                                          force_proceed=true to bypass
--                                          the event-mismatch safety net)
--
-- Idempotent DO-block — survives partial-replay (Postgres restriction:
-- enum extensions cannot live in the same tx as their first use). Same
-- pattern as 0132 + 0135 + 0137 + 0138.
-- ---------------------------------------------------------------------------

DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'csv_import_error_csv_downloaded'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'csv_import_cross_tenant_probe'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'csv_import_event_mismatch_overridden'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

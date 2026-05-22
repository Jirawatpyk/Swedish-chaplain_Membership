-- ---------------------------------------------------------------------------
-- F7.1a (Phase 3E.2 fix) — chamber_app GRANTs for F71A tables.
--
-- Migration 0166 added RLS+FORCE policies for the 4 new F71A tables
-- but FORGOT the matching GRANTs. Without GRANTs, the runtime
-- `chamber_app` role gets `permission denied for table …` when
-- attempting any INSERT/UPDATE/DELETE.
--
-- Discovered 2026-05-19 while wiring T037 lean integration test
-- (Phase 3E.2 verify-run fix cycle):
--   ERROR: permission denied for table broadcast_batch_manifests
--
-- Affected tables:
--   - broadcast_templates           (US7 + starter templates)
--   - broadcast_batch_manifests     (US1)
--   - tenant_image_source_allowlist (US2)
--   - tenant_broadcast_settings     (US1+US2 config)
--
-- Idempotent: GRANT is idempotent in Postgres (re-running is a no-op).
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "broadcast_templates"
  TO chamber_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "broadcast_batch_manifests"
  TO chamber_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "tenant_image_source_allowlist"
  TO chamber_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "tenant_broadcast_settings"
  TO chamber_app;

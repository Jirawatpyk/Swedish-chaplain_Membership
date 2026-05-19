-- ---------------------------------------------------------------------------
-- F7.1a (T017) — RLS + FORCE policies on 4 new F7.1a tables.
--
-- Constitution v1.4.0 Principle I sub-clause 2 (DB-layer tenant isolation,
-- NON-NEGOTIABLE): every tenant-scoped table MUST carry RLS + FORCE so the
-- Postgres storage layer rejects cross-tenant access even if Application
-- layer's `runInTenant(ctx, fn)` is bypassed.
--
-- Policy pattern matches F7 MVP's `tenant_isolation_on_broadcasts`
-- (migration 0064): role=chamber_app, FOR ALL, USING+WITH CHECK
-- `tenant_id = current_setting('app.current_tenant', TRUE)`. The TRUE
-- argument to current_setting means "return NULL on missing setting"
-- rather than raising — matches F7 MVP convention. App-layer runInTenant
-- always SETs the value before any tenant-scoped query.
--
-- Source of truth: specs/014-email-broadcast-advance/data-model.md § 5.
--
-- 4 RLS policies installed (3 new tables + 1 settings table):
--   - broadcast_templates             (US7)
--   - broadcast_batch_manifests       (US1)
--   - tenant_image_source_allowlist   (US2)
--   - tenant_broadcast_settings       (US1)
--
-- Cross-tenant probe integration tests land in Phase 3-5 per-US:
-- tests/integration/broadcasts/pagination-cross-tenant-probe.test.ts
-- (T036), image-allowlist-cross-tenant-probe.test.ts (T065),
-- template-cross-tenant-probe.test.ts (T093).
-- ---------------------------------------------------------------------------

-- --- broadcast_templates ----------------------------------------------------

ALTER TABLE "broadcast_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "broadcast_templates" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation_on_broadcast_templates"
  ON "broadcast_templates"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- broadcast_batch_manifests ----------------------------------------------

ALTER TABLE "broadcast_batch_manifests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "broadcast_batch_manifests" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation_on_broadcast_batch_manifests"
  ON "broadcast_batch_manifests"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- tenant_image_source_allowlist ------------------------------------------

ALTER TABLE "tenant_image_source_allowlist" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_image_source_allowlist" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation_on_tenant_image_source_allowlist"
  ON "tenant_image_source_allowlist"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- tenant_broadcast_settings ----------------------------------------------

ALTER TABLE "tenant_broadcast_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_broadcast_settings" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation_on_tenant_broadcast_settings"
  ON "tenant_broadcast_settings"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

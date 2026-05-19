-- ---------------------------------------------------------------------------
-- F6 Phase 2 Foundational · T012 — RLS + FORCE policies for 3 F6 tables.
--
-- Enables Row-Level Security + FORCE on `events`, `event_registrations`,
-- `tenant_webhook_configs` and installs the tenant-isolation policy on each.
-- Per Constitution v1.4.0 Principle I clause 2 (database-layer tenant
-- isolation, NON-NEGOTIABLE).
--
-- The 4th F6 table (eventcreate_idempotency_receipts) carries its own
-- RLS+FORCE inline in migration 0134 — kept separate because it lands
-- after this migration (T013 sequencing).
--
-- Policy shape mirrors F4 (migration 0019) + F8 (migration 0086) precedent:
--   FOR ALL TO chamber_app
--   USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
--   WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));
--
-- `chamber_app` is the role the application connects as (never BYPASS RLS).
-- `current_setting('app.current_tenant', TRUE)` is set via
-- `runInTenant(ctx, fn)` per request — TRUE = "missing_ok" so the function
-- returns NULL instead of raising, which naturally fails the comparison
-- and denies all rows when the tenant context is unset (deny-by-default).
--
-- The mandatory cross-tenant integration test
-- `tests/integration/events/tenant-isolation.test.ts` (T042 Phase 3) is a
-- Review-Gate blocker per Constitution v1.4.0 Principle I clause 3 — it
-- creates two tenants, seeds all 4 F6 tables, and asserts zero cross-tenant
-- visibility on SELECT/INSERT/UPDATE/DELETE.
-- ---------------------------------------------------------------------------

-- --- events ----------------------------------------------------------------
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "events" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_events"
  ON "events"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- event_registrations ---------------------------------------------------
ALTER TABLE "event_registrations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_registrations" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_event_registrations"
  ON "event_registrations"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- tenant_webhook_configs ------------------------------------------------
ALTER TABLE "tenant_webhook_configs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_webhook_configs" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_tenant_webhook_configs"
  ON "tenant_webhook_configs"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

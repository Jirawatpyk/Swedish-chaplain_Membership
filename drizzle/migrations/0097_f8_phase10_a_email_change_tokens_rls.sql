-- ---------------------------------------------------------------------------
-- F8 Phase 2 — Phase 10 backlog item A.1: enable RLS+FORCE on
-- `email_change_tokens` (F3 magic-link table).
--
-- Surfaced by `pnpm check:multi-tenant` at Wave C-7. F3 ships
-- application-layer tenant guards on read paths but the DB-level
-- defence-in-depth was missing — a misbehaving query bypassing the
-- application guard could read another tenant's token rows.
--
-- Pure schema add: no row mutation, no orphan rows on this table
-- (verified: zero rows with NULL tenant_id).
--
-- Mirrors the F2/F4/F7/F8 RLS template:
--   ENABLE + FORCE + tenant_isolation_on_<table> policy USING +
--   WITH CHECK referencing `app.current_tenant`.
-- ---------------------------------------------------------------------------

ALTER TABLE "email_change_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_change_tokens" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_email_change_tokens"
  ON "email_change_tokens"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

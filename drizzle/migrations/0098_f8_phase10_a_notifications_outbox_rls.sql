-- ---------------------------------------------------------------------------
-- F8 Phase 2 — Phase 10 backlog item A.2: clean orphans + enable RLS+FORCE
-- on `notifications_outbox` (F4 email outbox).
--
-- Surfaced by `pnpm check:multi-tenant` at Wave C-7:
--   * RLS not ENABLED + RLS not FORCED + no policy attached
--   * 10 rows with `tenant_id IS NULL` (orphan)
--
-- Triage: the 10 orphan rows are pre-launch test data from F4
-- development (dispatcher tests inserting outbox rows before the
-- tenant scoping was wired). All carry `created_at < 2026-04-01` and
-- have no live email-dispatcher dependents — safe to DELETE before
-- enabling RLS+FORCE.
--
-- Order matters: DELETE the orphans FIRST (while RLS is still off so
-- the owner role can see them) then enable RLS+FORCE. After this
-- migration, any future insert without a tenant context will fail
-- the WITH CHECK guard.
--
-- Production safety: the dispatcher cron + outbox-enqueue use-cases
-- all pass tenantId explicitly via `runInTenant(ctx, ...)`, so this
-- migration does NOT affect any code path. Application-layer
-- behaviour is unchanged; the change is purely defence-in-depth.
-- ---------------------------------------------------------------------------

-- 1. Delete pre-launch orphan rows (F4 dev artifacts).
DELETE FROM "notifications_outbox" WHERE "tenant_id" IS NULL;--> statement-breakpoint

-- 2. Enforce NOT NULL going forward — once orphans are gone we can
--    tighten the column so RLS can be relied on without falling back
--    to a NULL-row leak.
ALTER TABLE "notifications_outbox"
  ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint

-- 3. Enable RLS+FORCE + tenant-isolation policy.
ALTER TABLE "notifications_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications_outbox" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_notifications_outbox"
  ON "notifications_outbox"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

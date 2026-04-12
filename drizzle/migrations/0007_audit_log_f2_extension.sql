-- ---------------------------------------------------------------------------
-- F2 — audit_log extension (critique E10 + R2)
--
-- Three things in one migration (applied as independent top-level statements,
-- not inside a single BEGIN…COMMIT block, because Postgres forbids
-- `ALTER TYPE ... ADD VALUE` inside a transaction):
--
--   1. Extend the `audit_event_type` pgEnum with 10 new F2 values (each
--      wrapped in a `DO $$ ... IF NOT EXISTS ... ALTER TYPE ... ADD VALUE`
--      block for idempotency — re-running the migration is a no-op).
--   2. Add `payload jsonb` + `tenant_id text` nullable columns to audit_log.
--      F1 rows stay NULL; F2 rows populate them.
--   3. Enable RLS on audit_log with a PERMISSIVE policy that allows NULL
--      tenant_id rows (F1 cross-tenant identity events) to remain globally
--      visible while tenant-scoping F2 plan events.
--
-- NOTE: drizzle-kit cannot express the `ALTER TYPE ADD VALUE` pattern from
-- a pgTable definition, and it regenerates the type with the full value
-- list when you edit the enum in schema.ts. This hand-written SQL file is
-- the authoritative source for the F2 audit extension and MUST be applied
-- BEFORE the auth schema's widened enum is reflected in the codebase.
-- ---------------------------------------------------------------------------

-- --- 1. Widen audit_event_type enum with 10 new values ----------------------
--
-- Each ADD VALUE is wrapped in a DO block with a safety check against
-- pg_enum so re-running the migration is idempotent. `ALTER TYPE ADD VALUE
-- IF NOT EXISTS` was added in Postgres 12 but Neon sometimes ships older
-- runtimes, so we use the DO-block pattern for maximum compatibility.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'plan_created'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'plan_created';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'plan_updated'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'plan_updated';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'plan_cloned'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'plan_cloned';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'plan_activated'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'plan_activated';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'plan_deactivated'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'plan_deactivated';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'plan_soft_deleted'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'plan_soft_deleted';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'plan_undeleted'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'plan_undeleted';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'plan_not_found'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'plan_not_found';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'plan_cross_tenant_probe'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'plan_cross_tenant_probe';
  END IF;
END$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'fee_config_updated'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'fee_config_updated';
  END IF;
END$$;--> statement-breakpoint

-- --- 2. Add nullable columns to audit_log -----------------------------------

ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "payload" jsonb;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "tenant_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_tenant_id_idx" ON "audit_log" USING btree ("tenant_id");--> statement-breakpoint

-- --- 3. chamber_app grants on audit_log -------------------------------------
--
-- chamber_app must be able to INSERT F2 audit events and SELECT its own
-- tenant's events (read is used by the F2 list view for manager-role users
-- + by the integration test suite). The append-only trigger from migration
-- 0001 continues to apply.

GRANT SELECT, INSERT ON TABLE "audit_log" TO chamber_app;--> statement-breakpoint

-- --- 4. RLS on audit_log (permissive — F1 NULL tenant_id stays visible) -----

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Permissive policy: NULL tenant_id (F1 identity events) remain visible to
-- every tenant context, AND tenant-matched rows (F2 plan events) are visible
-- to their owning tenant. WITH CHECK prevents a tenant from forging the
-- tenant_id on a new row.
CREATE POLICY "audit_log_tenant_isolation"
  ON "audit_log"
  FOR ALL
  TO chamber_app
  USING (
    "tenant_id" IS NULL
    OR "tenant_id" = current_setting('app.current_tenant', TRUE)
  )
  WITH CHECK (
    "tenant_id" IS NULL
    OR "tenant_id" = current_setting('app.current_tenant', TRUE)
  );

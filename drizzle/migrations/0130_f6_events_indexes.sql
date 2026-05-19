-- ---------------------------------------------------------------------------
-- F6 Phase 2 Foundational · T009 — events indexes.
--
-- 4 indexes on `events`: 1 unique upsert key + 3 partial filtered indexes
-- supporting admin events-list filters.
--
-- Source of truth: specs/012-eventcreate-integration/data-model.md § 1.1.
--
-- IMPORTANT — non-CONCURRENTLY index creation:
--   The plan.md text says `CREATE INDEX CONCURRENTLY` outside-tx via
--   Drizzle `--no-transaction` header. The project precedent (F8 migration
--   0100, F3 migration 0009) DROPPED `CONCURRENTLY` because:
--     1. Drizzle's migration runner wraps every migration in BEGIN/COMMIT.
--     2. CREATE INDEX CONCURRENTLY is illegal inside a tx (PG error 25001).
--     3. New-table indexes are fast (empty table = sub-second
--        AccessExclusiveLock) so the migrator-compatibility trade is
--        worth the brief lock.
--   F6 follows this precedent. If a future production backfill needs a
--   non-blocking rebuild, the index can be dropped + recreated
--   CONCURRENTLY via an ops runbook step outside the migrator.
-- ---------------------------------------------------------------------------

-- UNIQUE upsert key (FR-010). Composite (tenant_id, source, external_id)
-- — the webhook receiver issues `INSERT … ON CONFLICT … DO UPDATE` against
-- this index to apply last-write-wins event metadata updates.
CREATE UNIQUE INDEX "events_tenant_source_external_unique"
  ON "events" ("tenant_id", "source", "external_id");--> statement-breakpoint

-- Default events-list ordering (FR-020) — admin list page renders events
-- newest-first. Partial index excluding archived rows keeps the index
-- small (archived events surface only on the archived-events page in
-- Phase 10 T109).
CREATE INDEX "events_tenant_start_active_idx"
  ON "events" ("tenant_id", "start_date" DESC)
  WHERE "archived_at" IS NULL;--> statement-breakpoint

-- Admin "partner-benefit only" filter (FR-019 / FR-020).
CREATE INDEX "events_tenant_partner_benefit_idx"
  ON "events" ("tenant_id", "is_partner_benefit")
  WHERE "archived_at" IS NULL;--> statement-breakpoint

-- Admin "cultural events only" filter (FR-019 / FR-020).
CREATE INDEX "events_tenant_cultural_event_idx"
  ON "events" ("tenant_id", "is_cultural_event")
  WHERE "archived_at" IS NULL;--> statement-breakpoint

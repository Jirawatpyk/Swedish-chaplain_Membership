-- ---------------------------------------------------------------------------
-- F9 (T011) — audit-viewer/activity-feed indexes + dashboard stale trigger.
--
-- Source of truth: data-model.md § 9 item 6 + research R1/R2-E1/R2-E4.
--
-- Part A — audit_log composite indexes to keep the audit viewer (FR-008,
-- p95 < 1 s @ 50k) and the live activity feed (FR-003) interactive:
--   - (tenant_id, event_type,     timestamp DESC)  — filter-by-type query
--   - (tenant_id, actor_user_id,  timestamp DESC)  — filter-by-actor query
--   - (tenant_id, timestamp DESC)                  — live activity-feed scan
--
-- Part B — event-triggered dashboard staleness (research R2-E1): an AFTER
-- INSERT trigger on audit_log flips dashboard_metrics_cache.stale = true for
-- the row's tenant when a KPI-affecting event is recorded. This avoids
-- app-layer cross-module coupling (no payments/broadcasts/members use-case
-- calls into insights — Principle III) by reusing the fact that all those
-- actions already write an audit row. The coordinator cron prioritises stale
-- rows. NO ordering dependency with 0191: the trigger keys off PRE-EXISTING
-- F3/F4/F5 event types, never the new F9 types (critique R2-L1).
--
-- Safety:
--   - Compares NEW.event_type::TEXT (not the enum) so a label not present in
--     the enum can never raise "invalid input value for enum" on an audit
--     INSERT (audit is a critical path — the trigger must never break it).
--   - SECURITY INVOKER (default): the UPDATE runs as the inserting role
--     (chamber_app) under RLS+FORCE, so it only ever touches the row for the
--     current tenant; audit inserts outside a tenant context match 0 rows
--     (silent, no error). Cold-start (no cache row yet) → 0 rows, fine.
--
-- Rollback (Critique E8):
--   DROP TRIGGER trg_f9_flag_dashboard_stale ON audit_log;
--   DROP FUNCTION f9_flag_dashboard_stale();
--   DROP INDEX audit_log_tenant_event_ts_idx, audit_log_tenant_actor_ts_idx,
--              audit_log_tenant_ts_idx;
-- ---------------------------------------------------------------------------

-- --- Part A: audit-query + activity-feed indexes ----------------------------

CREATE INDEX IF NOT EXISTS "audit_log_tenant_event_ts_idx"
  ON "audit_log" ("tenant_id", "event_type", "timestamp" DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "audit_log_tenant_actor_ts_idx"
  ON "audit_log" ("tenant_id", "actor_user_id", "timestamp" DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "audit_log_tenant_ts_idx"
  ON "audit_log" ("tenant_id", "timestamp" DESC);--> statement-breakpoint

-- --- Part B: dashboard stale trigger ----------------------------------------

CREATE OR REPLACE FUNCTION "f9_flag_dashboard_stale"()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."tenant_id" IS NOT NULL
     AND NEW."event_type"::text IN (
       -- membership counts
       'member_created',
       'member_status_changed',
       'member_archived',
       'member_plan_changed',
       -- YTD revenue + overdue resolution
       'payment_succeeded',
       -- needs-attention: broadcasts awaiting approval decreases
       'broadcast_approved'
     )
  THEN
    UPDATE "dashboard_metrics_cache"
       SET "stale" = true
     WHERE "tenant_id" = NEW."tenant_id";
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "trg_f9_flag_dashboard_stale"
  AFTER INSERT ON "audit_log"
  FOR EACH ROW
  EXECUTE FUNCTION "f9_flag_dashboard_stale"();

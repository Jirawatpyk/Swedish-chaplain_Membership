-- ---------------------------------------------------------------------------
-- F9 (T007) — smart_insight_dismissals table.
--
-- Source of truth: specs/015-admin-dashboard/data-model.md § 2 + research R9.
--
-- Per-tenant/user dismissal state for the fixed smart-insight catalogue. A
-- dismissal suppresses an insight for one CYCLE; the insight re-surfaces in a
-- new cycle. cycle_key semantics are PER-INSIGHT (Domain catalogue declares
-- granularity, critique L3): quota-based insights (`unused_eblast_quota`,
-- `underused_event_tickets`) use the membership year (calendar year, tenant
-- TZ); the recurring `at_risk_followup` insight uses the ISO week.
--
-- The unique (tenant_id, insight_key, scope_ref, cycle_key) makes dismissal
-- idempotent. scope_ref is NULLABLE (tenant-wide insights have no scope); note
-- Postgres treats NULLs as distinct in a UNIQUE index, so tenant-wide
-- dismissals rely on a sentinel scope_ref (e.g. '') at the application layer —
-- the Domain writes '' rather than NULL for tenant-wide scope so the unique
-- constraint actually dedupes. (Defence-in-depth: NULLS NOT DISTINCT could be
-- used on PG15+, but the '' sentinel keeps behaviour explicit + portable.)
--
-- Tenant isolation: RLS + FORCE + policy + chamber_app GRANT (Principle I).
--
-- Rollback:
--   DROP POLICY "tenant_isolation_on_smart_insight_dismissals" ON "smart_insight_dismissals";
--   DROP TABLE "smart_insight_dismissals";
-- ---------------------------------------------------------------------------

CREATE TABLE "smart_insight_dismissals" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"     text        NOT NULL,
  "insight_key"   text        NOT NULL,
  "scope_ref"     text        NOT NULL DEFAULT '',
  "dismissed_by"  uuid        NOT NULL,
  "dismissed_at"  timestamptz NOT NULL DEFAULT now(),
  "cycle_key"     text        NOT NULL,

  CONSTRAINT "smart_insight_dismissals_insight_key_check"
    CHECK ("insight_key" IN ('unused_eblast_quota', 'underused_event_tickets', 'at_risk_followup'))
);--> statement-breakpoint

CREATE UNIQUE INDEX "smart_insight_dismissals_idempotent_uniq"
  ON "smart_insight_dismissals" ("tenant_id", "insight_key", "scope_ref", "cycle_key");--> statement-breakpoint

ALTER TABLE "smart_insight_dismissals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "smart_insight_dismissals" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation_on_smart_insight_dismissals"
  ON "smart_insight_dismissals"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "smart_insight_dismissals"
  TO chamber_app;

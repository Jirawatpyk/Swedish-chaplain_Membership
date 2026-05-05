-- ---------------------------------------------------------------------------
-- F8 Phase 4 Wave I5 — extend audit_event_type pgEnum with the
-- `cron_dispatch_orchestrated` event.
--
-- Per the H1 audit-emitter convention "co-ship enum + emit site",
-- this enum value lands alongside the first concrete emit site:
--
--   * `cron_dispatch_orchestrated` — emitted by the daily reminder
--     dispatch coordinator (T103, /api/cron/renewals/dispatch-coordinator)
--     after fanning out to per-tenant endpoints. Payload carries
--     `{tenants_enqueued, tenants_succeeded, tenants_failed, duration_ms}`
--     for cron-pass observability.
--
-- Postgres requirement: `ALTER TYPE … ADD VALUE` cannot run inside a
-- transaction with other DDL — this single statement ships in its own
-- migration file (sequential after 0106 F1 webhook bounce_type).
-- ---------------------------------------------------------------------------

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'cron_dispatch_orchestrated';--> statement-breakpoint

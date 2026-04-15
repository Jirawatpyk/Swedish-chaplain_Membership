-- ---------------------------------------------------------------------------
-- F3 — notifications_outbox (US3.b.1 outbox foundation)
--
-- Transactional outbox for email sends. Written inside the F3 domain
-- transaction that mutates state (e.g. contact email change per FR-012a);
-- drained by a Vercel Cron every 60s that dispatches via Resend and flips
-- status. Covers F3 notification types today:
--   - member_invitation
--   - email_verification
--   - email_change_revert
--   - email_verification_resent
--
-- Retry policy (spec § Security 4.2): up to 5 attempts with exponential
-- backoff; on attempt 5 failure the row flips to `permanently_failed` and
-- the dispatcher emits an `email_dispatch_failed` audit event.
--
-- RLS: intentionally NOT enabled. The outbox is operational data (same
-- classification as email_delivery_events) — the cron dispatcher must
-- read rows across all tenants and cannot carry a tenant context. Tenant
-- scoping on read-paths from admin UIs is enforced in the application
-- layer via WHERE tenant_id = ctx.slug. Writes are always tenant-scoped
-- because the adapter runs inside a runInTenant() transaction that sets
-- app.current_tenant — the tenant_id column is populated from ctx.slug
-- in the adapter, not derived from the GUC.
--
-- Correction to research.md § 4 (2026-04-15): earlier research claimed
-- F1 already had this table. It did not. This migration creates it
-- fresh. F1 password-reset and invitation emails still dispatch via the
-- synchronous resend-client.ts; migrating them to the outbox is a
-- follow-up refactor.
-- ---------------------------------------------------------------------------

-- --- 1. Enums --------------------------------------------------------------

CREATE TYPE "public"."notification_type" AS ENUM (
  'member_invitation',
  'email_verification',
  'email_change_revert',
  'email_verification_resent'
);--> statement-breakpoint

CREATE TYPE "public"."outbox_status" AS ENUM (
  'pending',
  'sent',
  'permanently_failed'
);--> statement-breakpoint

-- --- 2. notifications_outbox table ----------------------------------------

CREATE TABLE "notifications_outbox" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"          text,
  "notification_type"  "notification_type" NOT NULL,
  "to_email"           text NOT NULL,
  "locale"             text NOT NULL,
  "context_data"       jsonb NOT NULL,
  "status"             "outbox_status" NOT NULL DEFAULT 'pending',
  "attempts"           integer NOT NULL DEFAULT 0,
  "next_retry_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "last_error"         text,
  "sent_message_id"    text,
  "created_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"         timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "outbox_attempts_nonneg" CHECK ("attempts" >= 0),
  CONSTRAINT "outbox_locale_valid" CHECK ("locale" IN ('en','th','sv'))
);--> statement-breakpoint

-- --- 3. Indexes ------------------------------------------------------------

-- Dispatcher drain query: pending + ready-to-retry, ordered by next_retry_at.
CREATE INDEX "outbox_dispatch_idx"
  ON "notifications_outbox" ("status", "next_retry_at");--> statement-breakpoint

-- Tenant-scoped operational queries from admin UIs.
CREATE INDEX "outbox_tenant_idx"
  ON "notifications_outbox" ("tenant_id");--> statement-breakpoint

-- --- 4. chamber_app grants -------------------------------------------------
--
-- No RLS policy (see header comment). chamber_app still needs DML grants
-- + USAGE on the two new enum types so the F3 adapters can INSERT and
-- the (future) dispatcher can UPDATE.

GRANT SELECT, INSERT, UPDATE ON TABLE "notifications_outbox" TO chamber_app;--> statement-breakpoint
GRANT USAGE ON TYPE "public"."notification_type" TO chamber_app;--> statement-breakpoint
GRANT USAGE ON TYPE "public"."outbox_status"     TO chamber_app;--> statement-breakpoint

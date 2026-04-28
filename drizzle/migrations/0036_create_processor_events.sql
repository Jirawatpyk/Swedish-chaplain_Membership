-- ---------------------------------------------------------------------------
-- F5 — processor_events table (T022 per specs/009-online-payment/tasks.md).
--
-- Append-only idempotency log for every Stripe webhook event processed.
-- PK = Stripe event id (evt_…), naturally unique → free idempotency
-- (FR-008). tenant_id NULLable during the pre-resolution window
-- (webhook hits before tenant is known); post-resolution UPDATE fills
-- it. DELETE is forbidden at the RLS layer.
--
-- Source of truth: specs/009-online-payment/data-model.md § 5.
-- Special RLS policies per § 5.4: 4 separate policies for SELECT /
-- INSERT / UPDATE / DELETE (not the usual single FOR ALL policy).
-- ---------------------------------------------------------------------------

CREATE TABLE "processor_events" (
  "id"                        text NOT NULL,
  "tenant_id"                 text,
  "event_type"                text NOT NULL,
  "api_version"               text NOT NULL,
  "livemode"                  boolean NOT NULL,
  "processor_account_id"      text NOT NULL,
  "received_at"               timestamp with time zone NOT NULL,
  "processed_at"              timestamp with time zone,
  "outcome"                   text NOT NULL,
  "payload_sha256"            text NOT NULL,
  "correlation_id"            text NOT NULL,
  "created_at"                timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "processor_events_pkey" PRIMARY KEY ("id")
);--> statement-breakpoint

-- --- Foreign keys -----------------------------------------------------------
--
-- No FK to `tenants(id)` — no physical `tenants` table until F10. See
-- 0019_invoicing_tables.sql header for the F2/F3/F4 convention rationale.

-- --- CHECK constraints (data-model.md § 5.3) --------------------------------

ALTER TABLE "processor_events"
  ADD CONSTRAINT "processor_events_outcome_enum"
  CHECK ("outcome" IN (
    'processed',
    'acknowledged_only',
    'rejected_signature',
    'rejected_environment_mismatch',
    'rejected_api_version_mismatch'
  ));--> statement-breakpoint

ALTER TABLE "processor_events"
  ADD CONSTRAINT "processor_events_payload_sha256_format"
  CHECK ("payload_sha256" ~ '^[a-f0-9]{64}$');--> statement-breakpoint

-- rejected_signature → tenant_id IS NULL (we never verified enough to
-- bind a tenant; NULL is definitive for signature failures).
--
-- Deliberately ONE-WAY implication, NOT biconditional (drizzle-migration-
-- reviewer Issue 2 → self-flagged Issue 6). Reason: the RLS INSERT policy
-- permits `tenant_id IS NULL` on EVERY outcome so the pre-resolution
-- webhook flow can write the row before the async resolver pins a tenant.
-- A biconditional `rejected_signature = (tenant_id IS NULL)` would reject
-- the normal insert for outcome='acknowledged_only' + tenant_id=NULL and
-- break the webhook receive path. The invariant we DO enforce:
-- rejected_signature rows NEVER get a tenant_id (even if one is later
-- resolvable, the resolver refuses to UPDATE a rejected-signature row).
ALTER TABLE "processor_events"
  ADD CONSTRAINT "processor_events_sig_reject_implies_null_tenant"
  CHECK (
    "outcome" <> 'rejected_signature'
    OR "tenant_id" IS NULL
  );--> statement-breakpoint

-- --- Indexes (data-model.md § 5.2) ------------------------------------------

-- Admin observability view — only tenant-resolved rows.
CREATE INDEX "processor_events_tenant_received_at_idx"
  ON "processor_events" USING btree ("tenant_id","received_at" DESC)
  WHERE "tenant_id" IS NOT NULL;--> statement-breakpoint

-- Debug/replay by account + livemode.
CREATE INDEX "processor_events_account_livemode_received_idx"
  ON "processor_events" USING btree ("processor_account_id","livemode","received_at" DESC);--> statement-breakpoint

-- Rejected-event audit view — excludes the hot path (processed rows).
CREATE INDEX "processor_events_outcome_received_idx"
  ON "processor_events" USING btree ("outcome","received_at" DESC)
  WHERE "outcome" <> 'processed';--> statement-breakpoint

-- --- chamber_app grants -----------------------------------------------------

-- Note: DELETE grant still added so the *database* role could delete;
-- the RLS policy below BLOCKS all deletes regardless. This matches
-- existing F4 convention of uniform GRANT lists + RLS as the effective
-- gate.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "processor_events" TO chamber_app;--> statement-breakpoint

-- --- Row-Level Security (data-model.md § 5.4 — special policies) ------------
--
-- SELECT: tenant_id must match current context (webhook reads are
--         always inside runInTenant post-resolution).
-- INSERT: allow NULL tenant_id (pre-resolution write) OR tenant match.
-- UPDATE: allow UPDATE from any row where tenant_id is NULL (pre-
--         resolution → resolution step) OR current tenant; WITH CHECK
--         forces the row's new tenant_id to the current tenant.
-- DELETE: forbidden — append-only idempotency log.

ALTER TABLE "processor_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "processor_events" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "processor_events_select"
  ON "processor_events"
  FOR SELECT
  TO chamber_app
  USING ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

CREATE POLICY "processor_events_insert"
  ON "processor_events"
  FOR INSERT
  TO chamber_app
  WITH CHECK (
    "tenant_id" IS NULL
    OR "tenant_id" = current_setting('app.current_tenant', TRUE)
  );--> statement-breakpoint

CREATE POLICY "processor_events_update"
  ON "processor_events"
  FOR UPDATE
  TO chamber_app
  USING (
    "tenant_id" IS NULL
    OR "tenant_id" = current_setting('app.current_tenant', TRUE)
  )
  WITH CHECK (
    "tenant_id" = current_setting('app.current_tenant', TRUE)
  );--> statement-breakpoint

CREATE POLICY "processor_events_no_delete"
  ON "processor_events"
  FOR DELETE
  TO chamber_app
  USING (false);--> statement-breakpoint

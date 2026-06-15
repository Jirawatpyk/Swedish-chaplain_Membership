-- ---------------------------------------------------------------------------
-- Migration 0218 — broadcast_batch_delivery_events (finding F7-SF-1).
--
-- The F7.1a batch webhook path (applyBatchWebhookEvent) increments
-- per-batch counters via an UNCONDITIONAL UPDATE
-- (broadcast_batch_manifests.<counter>_count + 1) with NO dedup on the
-- Resend event id. The webhook route has no upstream svix-id gate either
-- (the header comment's claim that email_delivery_events.svix_id dedups it
-- is false — that table is F1 transactional and is never written on the
-- batch path). So a Resend/Svix REDELIVERY of the same event (a normal
-- occurrence on slow-200 / network blips) double-counts
-- delivered/bounced/complained/unsubscribed — corrupting the batch
-- completion check, deliverability gauges, and the FR-027/SC-005b
-- complaint-rate auto-halt. The F7 MVP single-audience path does NOT have
-- this bug: it dedups via broadcast_deliveries.upsertByResendEventId.
--
-- This table is the batch-path equivalent: a per-event idempotency ledger
-- keyed (tenant_id, resend_event_id). The repo INSERTs ON CONFLICT DO
-- NOTHING in the SAME tx as the counter UPDATE, so a replay finds the row
-- present and skips the increment (mirrors FR-025 / spec line 334
-- "idempotent on Resend's unique event id").
--
-- FK to broadcast_batch_manifests(id) ON DELETE CASCADE (the manifest is
-- the parent; deleting it removes the ledger rows). RLS+FORCE +
-- tenant_isolation policy mirror broadcast_batch_manifests (0163 + 0166).
-- Idempotent for re-apply is not required (CREATE TABLE is one-shot) but
-- the table is additive + flag-gated (F7.1a US1 ships dark / SweCham 131
-- members never reach the >10k batch path).
-- ---------------------------------------------------------------------------

CREATE TABLE "broadcast_batch_delivery_events" (
  "tenant_id"         text NOT NULL,
  "resend_event_id"   text NOT NULL,
  "batch_manifest_id" uuid NOT NULL,
  "counter_field"     text NOT NULL,
  "recorded_at"       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "broadcast_batch_delivery_events_pkey"
    PRIMARY KEY ("tenant_id", "resend_event_id"),

  CONSTRAINT "broadcast_batch_delivery_events_batch_fkey"
    FOREIGN KEY ("batch_manifest_id")
    REFERENCES "broadcast_batch_manifests"("id")
    ON DELETE CASCADE
);--> statement-breakpoint

CREATE INDEX "broadcast_batch_delivery_events_batch_idx"
  ON "broadcast_batch_delivery_events" ("batch_manifest_id");--> statement-breakpoint

ALTER TABLE "broadcast_batch_delivery_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "broadcast_batch_delivery_events" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation_on_broadcast_batch_delivery_events"
  ON "broadcast_batch_delivery_events"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));

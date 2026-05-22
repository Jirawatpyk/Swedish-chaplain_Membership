-- ---------------------------------------------------------------------------
-- F7.1a US1 (Phase 3 Cluster 3C.4a) — broadcast_batch_manifests
-- `provider_broadcast_id` column.
--
-- T057 (Resend webhook per-batch counter ext) needs to look up which
-- batch_manifest corresponds to an incoming Resend webhook event. The
-- existing F7 MVP webhook handler looks up via
-- `broadcasts.resend_broadcast_id` (set by `dispatchScheduledBroadcast`
-- after `gateway.createBroadcast` returns). For F7.1a each batch
-- creates its OWN Resend broadcast resource via
-- `gateway.createBroadcast`, so each batch_manifest needs its own
-- `provider_broadcast_id` storage to make the same lookup path work.
--
-- Phase 2 schema (migration 0163) only stored `provider_audience_id`
-- — sufficient for dispatch but not for webhook event routing.
-- 0170 closes that gap.
--
-- Index is partial — only rows with a non-null `provider_broadcast_id`
-- are useful for webhook lookups (pending rows haven't dispatched yet
-- and have NULL). Same index-cardinality pattern as F4
-- `invoice_pdf_blob_url` lookup.
-- ---------------------------------------------------------------------------

ALTER TABLE "broadcast_batch_manifests"
  ADD COLUMN "provider_broadcast_id" TEXT;
--> statement-breakpoint
CREATE INDEX "broadcast_batch_manifests_provider_broadcast_id_idx"
  ON "broadcast_batch_manifests" ("provider_broadcast_id")
  WHERE "provider_broadcast_id" IS NOT NULL;

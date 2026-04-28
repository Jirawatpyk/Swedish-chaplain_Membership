-- T166-08 — F4 audit event type extension.
--
-- Two new event types for the async receipt-PDF pipeline:
--   - `receipt_rendered` — emitted by the worker once bytes land +
--     status flips to 'rendered'. Carries sha256 (10y retention,
--     tax-doc-touching).
--   - `pdf_render_permanently_failed` — emitted by reconciliation
--     cron when a row exhausts its 3-attempt retry budget. Pages
--     on-call via runbook (5y retention, ops event).
--
-- Pattern matches earlier audit-event extensions (0049, 0050, 0052,
-- 0053). `DO $$ BEGIN … EXCEPTION duplicate_object` makes the
-- statement idempotent across re-runs.

DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'receipt_rendered'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'pdf_render_permanently_failed'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Add `invoices_csv_exported` audit event type (F4 receipt-surface plan,
-- Phase 3 — CSV export of paid invoices for Thai VAT monthly filing).
-- Emitted by `exportPaidInvoicesCsv` after a successful CSV stream
-- generation — captures every export action by an admin so the bookkeeper
-- workflow has a forensic trail (who exported, what date range, how
-- many rows).
--
-- Operational / audit class — 5-year retention per Constitution
-- Principle VIII financial-record retention. NOT a tax-document touch
-- itself (the CSV is a derivative report, not a §86/§87 document); the
-- underlying invoice/receipt rows already carry their own 10y events.
--
-- Payload shape:
--   { from, to, row_count, actor_user_id, route: 'export-paid-invoices-csv' }

DO $$ BEGIN
  ALTER TYPE "audit_event_type" ADD VALUE 'invoices_csv_exported';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

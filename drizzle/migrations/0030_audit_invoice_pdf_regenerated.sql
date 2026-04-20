-- Add `invoice_pdf_regenerated` audit event type.
-- Emitted by the auto-rerender path (R3-E4) when Blob outage forces
-- re-render of a previously-issued invoice. Payload records original
-- + new sha256 so forensic review can determine whether regenerated
-- bytes are user-equivalent. Closes SC-003 / CP-5.2 Best Practice
-- decision (4-layer reproducibility — see retrospective.md).

DO $$ BEGIN
  ALTER TYPE "audit_event_type" ADD VALUE 'invoice_pdf_regenerated';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Migration 0326 — "Start over" on a locked admin credit-note attempt (task 68).
--
-- #728 (mig 0323) made an admin credit note idempotent per issue attempt: the
-- form keeps the attempt's key locked after an unknown outcome, because the
-- original request may still commit (up to the function's 300 s). The only
-- way out was "Try again", which issues the same amount. "Start over" now
-- closes the key on the server, under the invoice FOR UPDATE lock every issue
-- attempt takes:
--   - a note already issued under the key is returned instead;
--   - otherwise a row here (a tombstone) closes the key for good, and
--     issueCreditNote refuses any later request with it (`attempt_abandoned`).
--
-- 1. `credit_note_abandoned_attempts` — one row per closed key. Tenant-scoped,
--    RLS + FORCE. chamber_app gets SELECT + INSERT only: a tombstone is never
--    updated or deleted by the app (append-only by privilege). The invoice FK
--    cascades, so the only deletes are the invoice's own (test-tenant
--    cleanup; a paid invoice is never deleted in production).
-- 2. `audit_event_type += 'credit_note_attempt_abandoned'` (10 y, set by the
--    F4 emitter): it decides whether a §86/10 note will ever exist.
--
-- Safe before the code that uses it: a new table and an unused enum value.
-- Rollback: a forward-fix (stop reading the table, then drop it); an enum
-- value can't be dropped.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "credit_note_abandoned_attempts" (
  "tenant_id"             text        NOT NULL,
  "idempotency_key"       uuid        NOT NULL,
  "invoice_id"            uuid        NOT NULL,
  "abandoned_by_user_id"  uuid        NOT NULL,
  "abandoned_at"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "credit_note_abandoned_attempts_pkey" PRIMARY KEY ("tenant_id", "idempotency_key"),
  CONSTRAINT "credit_note_abandoned_attempts_invoice_fk"
    FOREIGN KEY ("tenant_id", "invoice_id")
    REFERENCES "invoices" ("tenant_id", "invoice_id")
    ON DELETE CASCADE
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "credit_note_abandoned_attempts_tenant_invoice_idx"
  ON "credit_note_abandoned_attempts" ("tenant_id", "invoice_id");--> statement-breakpoint

ALTER TABLE "credit_note_abandoned_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_note_abandoned_attempts" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'credit_note_abandoned_attempts'
      AND policyname = 'tenant_isolation_on_credit_note_abandoned_attempts'
  ) THEN
    CREATE POLICY "tenant_isolation_on_credit_note_abandoned_attempts"
      ON "credit_note_abandoned_attempts"
      FOR ALL
      TO chamber_app
      USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
      WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));
  END IF;
END$$;--> statement-breakpoint

GRANT SELECT, INSERT ON TABLE "credit_note_abandoned_attempts" TO chamber_app;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'credit_note_attempt_abandoned'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'credit_note_attempt_abandoned';
  END IF;
END$$;

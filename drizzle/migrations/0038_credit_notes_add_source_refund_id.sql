-- ---------------------------------------------------------------------------
-- F5 — credit_notes.source_refund_id (T024 per tasks.md).
--
-- Adds a nullable FK from F4 credit_notes → F5 refunds. NULL for
-- F4-manual credit notes; non-NULL for F5-origin (refund-triggered)
-- credit notes. Partial index accelerates the reverse lookup
-- "find credit note created by this refund".
--
-- Source: specs/009-online-payment/data-model.md § 6.
--
-- FK type: TEXT (matches refunds.id PK). Null-allowed: existing F4
-- rows remain NULL; nothing to backfill.
--
-- Atomicity: single transaction wraps ADD COLUMN + FK constraint +
-- partial index because all 3 operate on the same table. No data-
-- mutation step; purely additive schema change.
-- ---------------------------------------------------------------------------

ALTER TABLE "credit_notes"
  ADD COLUMN "source_refund_id" text;--> statement-breakpoint

-- FK to refunds(id). Single-column because refunds.id is a single-column
-- TEXT PK (F5's own ULID). Cross-tenant integrity is enforced by the
-- tenant_id column on both sides via RLS — a non-matching tenant_id
-- would fail at the RLS policy layer before the FK could link.
ALTER TABLE "credit_notes"
  ADD CONSTRAINT "credit_notes_source_refund_fk"
  FOREIGN KEY ("source_refund_id")
  REFERENCES "refunds" ("id")
  ON DELETE RESTRICT
  ON UPDATE NO ACTION;--> statement-breakpoint

-- Partial index — only F5-origin credit notes (source_refund_id IS NOT NULL).
-- F4-manual CNs have NULL; excluding them keeps the index small and fast.
CREATE INDEX "credit_notes_source_refund_id_idx"
  ON "credit_notes" USING btree ("source_refund_id")
  WHERE "source_refund_id" IS NOT NULL;--> statement-breakpoint

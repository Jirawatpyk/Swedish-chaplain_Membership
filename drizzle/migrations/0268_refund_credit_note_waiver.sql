-- money-remediation Task 7 / Track B — refunds that legitimately carry NO
-- §86/10 ใบลดหนี้.
--
-- Two states made a refund impossible through the product even though the
-- member was owed the money: a VOIDED invoice (void is irreversible and writes
-- nothing to payments) and a §105 receipt (no credit note was ever possible,
-- and F4's own credit-note screen tells the admin to use a direct refund —
-- which the refund pre-flight then refused). This adds the recording mechanism
-- that lets those refunds complete without pretending a credit note exists.
--
-- Numbering: 0267 is taken by `fix/money-remediation-task-4`
-- (`payment_settlement_rolled_back`), so this takes 0268.
--
-- Production blast radius: ZERO. `refunds` has 0 rows, `payments` 0,
-- `credit_notes` 0 (verified read-only against prod before writing this).
-- The DDL rewrites no data.

-- 1. Waiver INTENT (pinned at the Phase-A insert, while the row is 'pending')
--    and waiver COMPLETION (stamped on the succeeded flip). They are separate
--    columns for the reason spelled out at constraint 3 below.
ALTER TABLE "refunds"
  ADD COLUMN "credit_note_waiver_reason" TEXT,
  ADD COLUMN "credit_note_waived_at" TIMESTAMPTZ;--> statement-breakpoint

-- 2. Closed vocabulary, mirroring `CreditNoteWaiverReason` in
--    src/modules/invoicing/domain/refund-credit-note-requirement.ts.
--    These strings are a storage contract: renaming one needs a migration.
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_waiver_reason_enum"
  CHECK ("credit_note_waiver_reason" IS NULL
         OR "credit_note_waiver_reason" IN ('invoice_voided','section_105_receipt'));--> statement-breakpoint

-- 3. THE RISKIEST STATEMENT IN THIS CHANGE. Replace the old completeness
--    biconditional (0034) with one that accepts a documented waiver.
--
--    COMPLETION IS KEYED ON `credit_note_waived_at`, NEVER ON
--    `credit_note_waiver_reason`. This is load-bearing, not stylistic:
--
--      * the reason is written at INSERT while status is still 'pending'. If
--        the right-hand side keyed on it, then attaching `processor_refund_id`
--        to that still-'pending' row would make the RHS TRUE while the LHS is
--        FALSE — a CHECK violation thrown AFTER Stripe has already moved the
--        money.
--      * the FAILED path also writes `processor_refund_id`. With reason-keying
--        that row evaluates FALSE = TRUE, so the webhook transaction aborts,
--        never marks the event processed, Stripe retries, and it aborts again.
--        The row is then stuck 'pending' forever — and a pending row blocks
--        every future refund on that payment. Money out, no way back.
--
--    With timestamp-keying every intermediate state evaluates FALSE = FALSE.
--
--    The invariant is STRENGTHENED, not weakened: "succeeded ⟺ has a credit
--    note" becomes "succeeded ⟺ DOCUMENTED, by a credit note or by an
--    enumerated waiver". There is no state in which a succeeded refund carries
--    neither.
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_succeeded_iff_complete";--> statement-breakpoint
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_succeeded_iff_documented"
  CHECK (
    ("status" = 'succeeded') = (
      "processor_refund_id" IS NOT NULL
      AND ("credit_note_id" IS NOT NULL OR "credit_note_waived_at" IS NOT NULL)
    )
  );--> statement-breakpoint

-- 4. A refund is documented by exactly ONE instrument, never both. Without
--    this, a bug could book a credit note AND record a waiver, and the ledger
--    would double-count the reversal.
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_cn_xor_waived"
  CHECK ("credit_note_id" IS NULL OR "credit_note_waived_at" IS NULL);--> statement-breakpoint

-- 5. A completed waiver must always name its ground. A waived_at with no
--    reason is an unexplainable hole in the tax trail.
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_waived_at_requires_reason"
  CHECK ("credit_note_waived_at" IS NULL OR "credit_note_waiver_reason" IS NOT NULL);--> statement-breakpoint

-- 6. The accountant's ledger query: "which refunds this period returned money
--    without a credit note, and on what ground?" Partial, because the
--    overwhelming majority of refunds DO carry a credit note.
CREATE INDEX "refunds_credit_note_waived_at_idx"
  ON "refunds" USING btree ("tenant_id","credit_note_waived_at")
  WHERE "credit_note_waived_at" IS NOT NULL;--> statement-breakpoint

-- 7. Forensic event, emitted in Phase A where the invoice facts are still in
--    hand. 10-year retention (Thai RD §87/3) because it is tax evidence: it is
--    the only record that money was returned with no §86/10 against it.
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'refund_credit_note_waived';

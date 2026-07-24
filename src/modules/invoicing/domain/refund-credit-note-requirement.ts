/**
 * Does a refund require a §86/10 ใบลดหนี้ — and if one is required, can it be
 * issued right now?
 *
 * WHY THIS LIVES IN F4 DOMAIN
 * It encodes F4's §86/10 rules, so it belongs beside `document-kind.ts` for the
 * same reason that file exists: the moment two modules answer a tax question
 * independently, they drift. F5's refund pre-flight consumes this through the
 * `@/modules/invoicing` barrel and never re-derives the rules.
 *
 * WHY IT EXISTS AT ALL
 * The pre-fix refund pre-flight asked "can F4 issue a credit note?" and refused
 * the refund whenever the answer was no. For two states that is the wrong
 * question, and the wrong answer:
 *
 *   - a VOIDED invoice — void is irreversible and `void-invoice` writes nothing
 *     to payments, so a settled payment could never be returned through the
 *     product again;
 *   - a §105 receipt — no credit note was ever possible, and F4's own
 *     credit-note screen tells the admin to "use a direct refund instead",
 *     which the pre-flight then refused. A closed loop with no runbook behind
 *     it, and the member's money inside it.
 *
 * The question that produces correct behaviour is whether a credit note is
 * OWED. When none is owed the refund proceeds and the waiver is recorded on the
 * refund row; when one is owed but cannot be issued the refund is refused, and
 * the block reason carries HOW it clears so the copy can say something true.
 *
 * PURE DOMAIN: no framework, ORM, or IO imports (Principle III).
 */
import type { InvoiceStatus } from './invoice';

/**
 * Reasons a refund legitimately carries NO §86/10 ใบลดหนี้.
 *
 * Persisted verbatim on `refunds.credit_note_waiver_reason`, so these strings
 * are a storage contract — renaming one needs a migration, not just an edit.
 */
export type CreditNoteWaiverReason = 'invoice_voided' | 'section_105_receipt';

export const CREDIT_NOTE_WAIVER_REASONS = [
  'invoice_voided',
  'section_105_receipt',
] as const satisfies readonly CreditNoteWaiverReason[];

/**
 * HOW a blocked gate clears. This — not the raw PDF column — is what copy,
 * telemetry and the F8 refund bridge branch on.
 *
 *   'transient' — self-healing, no human. Say "wait", and mean it.
 *   'operator'  — a human must act before it can clear. Say who and what.
 *   'permanent' — nothing clears it. Never say "retry".
 *
 * Carrying this in the type is what stops the C2 defect returning: a single
 * `receipt_not_rendered` code once told every admin to "try again in a few
 * minutes", which was true for one of four database states.
 */
export type CreditNoteBlockRetryability = 'transient' | 'operator' | 'permanent';

export type RefundCreditNoteBlockReason =
  | {
      readonly code: 'invoice_not_creditable';
      readonly retryability: 'permanent';
      /** `credited` (already fully reversed) or `draft`/`issued` (an anomaly). */
      readonly status: Exclude<
        InvoiceStatus,
        'paid' | 'partially_credited' | 'void'
      >;
    }
  | {
      /**
       * The invoice carries no buyer identity snapshot. The schema requires
       * one (`member_identity_snapshot IS NOT NULL`), so absence is CORRUPTION,
       * not a legitimate state.
       *
       * This arm exists because the §105 discriminator is fail-closed:
       * `resolveBuyerIsVatRegistrant` returns "not a registrant" for a missing
       * or key-less snapshot, which for an event invoice yields `isSection105`.
       * Without this guard a corrupt row would take the WAIVE path — money out,
       * credit note recorded as not owed, and an output-VAT obligation nobody
       * knows was created. Blocking keeps the pre-fix safety direction for the
       * one input where "fail closed" and "waive" point opposite ways.
       */
      readonly code: 'identity_snapshot_missing';
      readonly retryability: 'permanent';
    }
  | {
      /**
       * `receipt_pdf_status = 'pending'`. The reconcile cron re-enqueues
       * stuck-pending rows, so this genuinely self-heals — the only receipt
       * state where telling the admin to wait is honest.
       */
      readonly code: 'receipt_render_pending';
      readonly retryability: 'transient';
    }
  | {
      /**
       * `receipt_pdf_status = 'failed'`. Deliberately OPERATOR, not transient.
       * The cron may re-enqueue it, but `receipt_pdf_render_attempts` is RESET
       * to 0 on every re-enqueue, so no column on the row distinguishes "will
       * retry" from "already abandoned and paged". The asymmetry decides it: a
       * false escalate costs one self-resolving ticket, a false "wait" costs
       * the member their refund indefinitely with nobody alerted.
       */
      readonly code: 'receipt_render_failed';
      readonly retryability: 'operator';
    }
  | {
      /**
       * `receipt_pdf_status IS NULL`. The reconcile cron's scan matches only
       * `failed` OR stale `pending`, and SQL NULL compares equal to neither, so
       * these rows are swept by nobody, ever.
       *
       * A distinct code from `receipt_render_failed` for TELEMETRY only — a
       * NULL spike means a broken enqueue path, not a broken renderer. Both
       * share one route code and one copy string, because the remedy is
       * identical.
       */
      readonly code: 'receipt_render_not_started';
      readonly retryability: 'operator';
    };

export type RefundCreditNoteRequirement =
  /** A §86/10 ใบลดหนี้ is required AND issuable. The normal path, unchanged. */
  | { readonly kind: 'issue' }
  /** A §86/10 is required and F4 cannot issue it. Refuse the refund. */
  | { readonly kind: 'blocked'; readonly reason: RefundCreditNoteBlockReason }
  /**
   * NO §86/10 is owed at all. ALLOW the refund and record the waiver.
   *
   * `invoiceStatus` is pinned here so the success envelope can report the
   * invoice's real status without a second read — the status lookup used on the
   * normal path rejects exactly `paid` and `void`, which are the two statuses
   * this arm produces.
   */
  | {
      readonly kind: 'waive';
      readonly reason: CreditNoteWaiverReason;
      readonly invoiceStatus: InvoiceStatus;
    };

/**
 * Gate ORDER mirrors `issue-credit-note.ts` (status → §105 → receipt), with two
 * deliberate insertions: the `void` carve-out hoisted ABOVE the status gate,
 * and the snapshot-integrity guard placed immediately before the §105 arm it
 * protects.
 *
 * `isSection105` is supplied by the CALLER rather than derived here, so the
 * adapter keeps using the same `inferEventDocumentKind ∘
 * resolveBuyerIsVatRegistrant` composition F4's own credit gate uses.
 * Re-deriving it from TIN presence is exactly the lockstep divergence
 * `document-kind.ts` exists to prevent (059 / PR-A Task 6a).
 *
 * IF YOU ADD A GATE TO `issue-credit-note.ts`, ADD AN ARM HERE. The two are
 * mirrors, and the whole cost of them drifting is paid in money.
 */
export function resolveRefundCreditNoteRequirement(input: {
  readonly status: InvoiceStatus;
  readonly isSection105: boolean;
  /**
   * Whether the invoice carries a buyer identity snapshot. Absence is a corrupt
   * row (the schema requires one), and it makes the §105 discriminator
   * fail-closed in the direction that would WAIVE — see
   * `identity_snapshot_missing`.
   */
  readonly hasIdentitySnapshot: boolean;
  readonly receiptPdfStatus: 'pending' | 'rendered' | 'failed' | null;
}): RefundCreditNoteRequirement {
  // 1. VOID — the void stamp IS the tax reversal. `void-invoice` re-renders and
  //    VOID-stamps both blobs and emits `invoice_voided`, so no live §86/4
  //    remains for a §86/10 to reduce, and F4's status gate would refuse one
  //    forever. Void is irreversible, so refusing the refund here strands
  //    settled member money permanently.
  //
  //    ABOVE the status gate on purpose, and above the snapshot guard too: the
  //    void verdict consults neither the snapshot nor the receipt, and a void
  //    creates no new output-VAT obligation, so neither guard applies.
  if (input.status === 'void') {
    return {
      kind: 'waive',
      reason: 'invoice_voided',
      invoiceStatus: input.status,
    };
  }

  // 2. STATUS — the allow-list MUST stay `paid | partially_credited`. F4 flips
  //    an invoice to `partially_credited` after the first partial refund's
  //    credit note, so narrowing this to `=== 'paid'` looks equivalent and
  //    breaks every SECOND partial refund.
  //
  //    Reported BEFORE snapshot integrity when both are wrong: a status the
  //    admin can see on the invoice is more actionable than a corruption code.
  if (input.status !== 'paid' && input.status !== 'partially_credited') {
    return {
      kind: 'blocked',
      reason: {
        code: 'invoice_not_creditable',
        retryability: 'permanent',
        status: input.status,
      },
    };
  }

  // 3. SNAPSHOT INTEGRITY — guards the §105 arm below, and only that arm.
  //    A missing snapshot makes `isSection105` fail-closed to TRUE for an event
  //    invoice, which under this design means WAIVE. Same value, inverted
  //    safety direction: the pre-fix code refused such a row, and refusing is
  //    right, because waiving moves money AND silently creates an output-VAT
  //    obligation with no credit note recording it.
  if (!input.hasIdentitySnapshot) {
    return {
      kind: 'blocked',
      reason: { code: 'identity_snapshot_missing', retryability: 'permanent' },
    };
  }

  // 4. §105 — the buyer was issued a ใบเสร็จรับเงิน under §105, never a §86/4
  //    ใบกำกับภาษี. §86/10 วรรคสอง requires a ใบลดหนี้ to carry the NUMBER AND
  //    DATE of the original ใบกำกับภาษี, and there is none to cite, so no credit
  //    note is owed or possible.
  //
  //    THE RULE IS SELLER-SIDE. §86/10 binds the VAT-registered SELLER that
  //    issued the original tax invoice; it imposes no condition on the buyer.
  //    Do NOT restate this as "the buyer has no input VAT to reverse" — that
  //    framing is wrong and, applied consistently, would break the membership
  //    path, which issues valid §86/4 documents (and therefore valid credit
  //    notes) to non-registrant buyers under the 066 relax.
  //
  //    The receipt-render axis is deliberately NOT consulted: no credit note
  //    will ever be issued here, so whether a PDF materialised cannot gate the
  //    money.
  //
  //    NOTE FOR WHOEVER OWNS THE FILING: "no credit note" does NOT mean "no VAT
  //    adjustment". Output VAT already remitted on a refunded §105 sale still
  //    has to be adjusted for that tax month by another instrument. This
  //    function records the waiver so that adjustment is discoverable; it does
  //    not perform it. See docs/runbooks/refund-without-credit-note.md.
  if (input.isSection105) {
    return {
      kind: 'waive',
      reason: 'section_105_receipt',
      invoiceStatus: input.status,
    };
  }

  // 5. RECEIPT — a §86/10 can only adjust a document that exists as bytes.
  //    Split by REMEDY, on the status column alone. NOT on
  //    `receipt_pdf_render_attempts`: the reconcile cron resets that counter to
  //    0 on every re-enqueue, so it oscillates and cannot distinguish "will
  //    retry" from "gave up".
  switch (input.receiptPdfStatus) {
    case 'rendered':
      return { kind: 'issue' };
    case 'pending':
      return {
        kind: 'blocked',
        reason: { code: 'receipt_render_pending', retryability: 'transient' },
      };
    case 'failed':
      return {
        kind: 'blocked',
        reason: { code: 'receipt_render_failed', retryability: 'operator' },
      };
    case null:
      return {
        kind: 'blocked',
        reason: {
          code: 'receipt_render_not_started',
          retryability: 'operator',
        },
      };
  }
}

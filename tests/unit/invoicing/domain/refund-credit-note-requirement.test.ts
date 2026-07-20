/**
 * F4 Domain — "does this refund require a §86/10 ใบลดหนี้?"
 *
 * The pre-fix refund pre-flight asked the WRONG question: "can F4 issue a
 * credit note?" It then refused the refund whenever the answer was no. For two
 * states that produced a dead end — a voided invoice and a §105 receipt — the
 * member's money could not come back through the product at all, and F4's own
 * credit-note screen was simultaneously telling the admin to "use a direct
 * refund instead".
 *
 * The right question is whether a credit note is OWED. When one is not, the
 * refund proceeds and the waiver is recorded; when one is owed but cannot be
 * issued, the refund is refused and the copy says how the block clears.
 *
 * Domain requires 100% line coverage (Principle II), so every arm is exercised.
 */
import { describe, expect, it } from 'vitest';

import {
  resolveRefundCreditNoteRequirement,
  type RefundCreditNoteRequirement,
} from '@/modules/invoicing';

const base = {
  status: 'paid',
  isSection105: false,
  hasIdentitySnapshot: true,
  receiptPdfStatus: 'rendered',
} as const;

function resolve(
  over: Partial<Parameters<typeof resolveRefundCreditNoteRequirement>[0]>,
): RefundCreditNoteRequirement {
  return resolveRefundCreditNoteRequirement({ ...base, ...over });
}

describe('resolveRefundCreditNoteRequirement — waive arms', () => {
  it('void invoice → waive(invoice_voided), and the void carve-out outranks every other axis', () => {
    // The void stamp IS the tax reversal: `void-invoice` re-renders and
    // VOID-stamps both blobs, so no live §86/4 remains for a §86/10 to reduce.
    // Void is irreversible, so refusing here strands settled member money
    // permanently — the C1 dead end.
    //
    // `receiptPdfStatus: null` is set deliberately: the carve-out must sit
    // ABOVE the receipt axis, or a voided invoice whose receipt never rendered
    // would be blocked by the wrong gate and the money would still be stuck.
    expect(resolve({ status: 'void', receiptPdfStatus: null })).toEqual({
      kind: 'waive',
      reason: 'invoice_voided',
      invoiceStatus: 'void',
    });
  });

  it('§105 receipt → waive(section_105_receipt), without consulting the render axis', () => {
    // No credit note will ever be issued for this buyer, so whether the PDF
    // materialised cannot gate the money. `receiptPdfStatus: 'failed'` proves
    // the §105 arm returns before the receipt switch.
    expect(
      resolve({ isSection105: true, receiptPdfStatus: 'failed' }),
    ).toEqual({
      kind: 'waive',
      reason: 'section_105_receipt',
      invoiceStatus: 'paid',
    });
  });

  it('a voided invoice waives even with no identity snapshot', () => {
    // The snapshot guard exists to stop a CORRUPT row driving the §105
    // verdict. The void verdict does not consult the snapshot at all, and a
    // void creates no new tax obligation, so blocking here would strand money
    // for a reason that does not apply.
    expect(
      resolve({ status: 'void', hasIdentitySnapshot: false }),
    ).toEqual({
      kind: 'waive',
      reason: 'invoice_voided',
      invoiceStatus: 'void',
    });
  });
});

describe('resolveRefundCreditNoteRequirement — blocked arms', () => {
  for (const status of ['credited', 'issued', 'draft'] as const) {
    it(`${status} invoice → blocked(invoice_not_creditable), permanent`, () => {
      expect(resolve({ status })).toEqual({
        kind: 'blocked',
        reason: {
          code: 'invoice_not_creditable',
          retryability: 'permanent',
          status,
        },
      });
    });
  }

  it('missing identity snapshot → blocked(identity_snapshot_missing), and does NOT waive', () => {
    // THE point of this arm. `resolveBuyerIsVatRegistrant` is fail-closed: a
    // NULL or key-less snapshot resolves to "not a registrant", which for an
    // event invoice makes `isSection105` true. Without this guard a CORRUPT
    // row would take the §105 waive path — money out, credit note recorded as
    // not owed, and a ภ.พ.30 obligation nobody knows about.
    //
    // The schema requires `member_identity_snapshot IS NOT NULL`, so absence
    // is corruption, not a legitimate state. Permanent: no retry repairs a row.
    expect(
      resolve({ isSection105: true, hasIdentitySnapshot: false }),
    ).toEqual({
      kind: 'blocked',
      reason: {
        code: 'identity_snapshot_missing',
        retryability: 'permanent',
      },
    });
  });

  it('status is reported before snapshot integrity when both are wrong', () => {
    // Both gates would refuse. `invoice_not_creditable` is the more actionable
    // report — it names a state the admin can see on the invoice — so it must
    // win. Pinning the precedence stops a future reorder from silently
    // degrading the error an operator receives.
    expect(
      resolve({ status: 'credited', hasIdentitySnapshot: false }),
    ).toEqual({
      kind: 'blocked',
      reason: {
        code: 'invoice_not_creditable',
        retryability: 'permanent',
        status: 'credited',
      },
    });
  });

  it('receipt pending → blocked(receipt_render_pending), TRANSIENT', () => {
    // The reconcile cron re-enqueues stuck `pending` rows, so this is the one
    // receipt state that genuinely self-heals and the one where "wait" is true.
    expect(resolve({ receiptPdfStatus: 'pending' })).toEqual({
      kind: 'blocked',
      reason: { code: 'receipt_render_pending', retryability: 'transient' },
    });
  });

  it('receipt failed → blocked(receipt_render_failed), OPERATOR not transient', () => {
    // The cron may re-enqueue it, but it RESETS `receipt_pdf_render_attempts`
    // to 0 every cycle, so no column distinguishes "will retry" from "already
    // abandoned and paged". A false escalate costs one self-resolving ticket;
    // a false "wait a few minutes" costs the member their refund indefinitely.
    expect(resolve({ receiptPdfStatus: 'failed' })).toEqual({
      kind: 'blocked',
      reason: { code: 'receipt_render_failed', retryability: 'operator' },
    });
  });

  it('receipt status NULL → blocked(receipt_render_not_started), OPERATOR', () => {
    // The cron's scan predicate is `= 'failed' OR (= 'pending' AND stuck)`, and
    // SQL NULL compares equal to neither — these rows are swept by nobody,
    // ever. A separate code from `receipt_render_failed` for TELEMETRY (a NULL
    // spike means a broken enqueue path, not a broken renderer); both share one
    // route code and one copy, because the remedy is identical.
    expect(resolve({ receiptPdfStatus: null })).toEqual({
      kind: 'blocked',
      reason: { code: 'receipt_render_not_started', retryability: 'operator' },
    });
  });
});

describe('resolveRefundCreditNoteRequirement — issue arm', () => {
  it('paid + rendered → issue', () => {
    expect(resolve({})).toEqual({ kind: 'issue' });
  });

  it('partially_credited + rendered → issue (the second-partial-refund pin)', () => {
    // F4 flips an invoice to `partially_credited` after the first partial
    // refund's credit note. Narrowing the allow-list to `=== 'paid'` looks
    // equivalent and breaks every SECOND partial refund — a live regression
    // strictly worse than the bug this resolver exists to fix.
    expect(resolve({ status: 'partially_credited' })).toEqual({
      kind: 'issue',
    });
  });
});

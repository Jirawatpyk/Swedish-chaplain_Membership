/**
 * Unit tests for `computeIssueReviewModel` — 088 T017a / FR-027, re-pointed by
 * 059 / PR-A Task 3.
 *
 * The pre-issue review dialog surfaces the consequential §86/4 fields before
 * the admin pins an IMMUTABLE tax snapshot. This pure model decides:
 *   - the Head-Office / Branch line that WILL print, gated on the RECORDED
 *     `members.is_vat_registered` flag (ประกาศอธิบดีฯ ฉบับที่ 199);
 *   - the non-blocking WARNINGS the dialog raises (FR-027):
 *     (a) the bill will render with NO payment path, and
 *     (b) no §86/4 branch line prints because the buyer is not a recorded VAT
 *         registrant — otherwise silent post-cutover.
 *
 * This model USED to take `legalEntityType: string | null` and re-implement the
 * discriminator by hand (`norm === 'individual'`), independently of the adapter
 * that produces the snapshot the PDF actually renders. Two copies of one rule is
 * how a preview comes to contradict the document. There is no third state now:
 * with a recorded boolean, `unset` and `individual` collapse into
 * `not_registrant`.
 *
 * Pure — no framework/DB/network — so every branch is exercised here.
 */
import { describe, expect, it } from 'vitest';
import { computeIssueReviewModel } from '@/app/(staff)/admin/invoices/_lib/issue-review';

describe('computeIssueReviewModel (FR-027)', () => {
  it('a VAT registrant previews the head-office line', () => {
    const m = computeIssueReviewModel({ buyerIsVatRegistrant: true });
    expect(m.branchLine).toEqual({ kind: 'head_office' });
    expect(m.warnings).not.toContain('no_branch_line_not_vat_registrant');
  });

  it('a non-registrant previews NO line, and says why', () => {
    const m = computeIssueReviewModel({ buyerIsVatRegistrant: false });
    expect(m.branchLine).toEqual({ kind: 'none', reason: 'not_registrant' });
    expect(m.warnings).toContain('no_branch_line_not_vat_registrant');
  });

  it('a registrant with a payment path raises NO warnings at all', () => {
    expect(
      computeIssueReviewModel({ buyerIsVatRegistrant: true }).warnings,
    ).toEqual([]);
  });

  it('WARN(a) no_payment_path fires only when hasNoPaymentPath === true', () => {
    expect(
      computeIssueReviewModel({
        buyerIsVatRegistrant: true,
        hasNoPaymentPath: true,
      }).warnings,
    ).toContain('no_payment_path');
    // Undefined (caller cannot determine yet — US5 bank block unbuilt) → dormant.
    expect(
      computeIssueReviewModel({ buyerIsVatRegistrant: true }).warnings,
    ).not.toContain('no_payment_path');
    // Explicit false (payment path present) → no warn.
    expect(
      computeIssueReviewModel({
        buyerIsVatRegistrant: true,
        hasNoPaymentPath: false,
      }).warnings,
    ).not.toContain('no_payment_path');
  });

  it('both warnings compose (non-registrant AND no payment path)', () => {
    const m = computeIssueReviewModel({
      buyerIsVatRegistrant: false,
      hasNoPaymentPath: true,
    });
    expect(m.warnings).toContain('no_branch_line_not_vat_registrant');
    expect(m.warnings).toContain('no_payment_path');
    expect(m.warnings).toHaveLength(2);
  });
});

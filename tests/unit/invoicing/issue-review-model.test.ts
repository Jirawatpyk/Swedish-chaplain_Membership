/**
 * Unit tests for `computeIssueReviewModel` — 088 T017a / FR-027.
 *
 * The pre-issue review dialog surfaces the consequential §86/4 fields before
 * the admin pins an IMMUTABLE tax snapshot. This pure model decides:
 *   - the Head-Office / Branch line that will print (fail-closed on a
 *     NULL/unset `legal_entity_type` — US3 rule: individual/NULL → no line);
 *   - the non-blocking WARNINGS the dialog must raise (FR-027):
 *     (a) the bill will render with NO payment path, and
 *     (b) no §86/4 branch line prints because the buyer's legal_entity_type
 *         is UNSET (null) — silent post-cutover otherwise.
 *
 * Pure — no framework/DB/network — so every branch is exercised here.
 */
import { describe, expect, it } from 'vitest';
import { computeIssueReviewModel } from '@/app/(staff)/admin/invoices/_lib/issue-review';

describe('computeIssueReviewModel (FR-027)', () => {
  it('juristic (non-individual, non-null) buyer → head-office branch line, VAT-registrant, no warnings', () => {
    const m = computeIssueReviewModel({ legalEntityType: 'company_limited' });
    expect(m.branchLine.kind).toBe('head_office');
    expect(m.buyerIsVatRegistrantJuristic).toBe(true);
    expect(m.warnings).toEqual([]);
  });

  it('individual buyer → no branch line (not a warning), not VAT-registrant juristic', () => {
    const m = computeIssueReviewModel({ legalEntityType: 'individual' });
    expect(m.branchLine.kind).toBe('none');
    if (m.branchLine.kind === 'none') {
      expect(m.branchLine.reason).toBe('individual');
    }
    expect(m.buyerIsVatRegistrantJuristic).toBe(false);
    // Individual with no branch line is expected/legal — NOT warned.
    expect(m.warnings).not.toContain('no_branch_line_null_entity_type');
  });

  it('individual is matched case-insensitively / trimmed', () => {
    const m = computeIssueReviewModel({ legalEntityType: '  Individual ' });
    expect(m.branchLine.kind).toBe('none');
    expect(m.warnings).not.toContain('no_branch_line_null_entity_type');
  });

  it('NULL legal_entity_type → no branch line + WARN(b) (fail-closed, unset)', () => {
    const m = computeIssueReviewModel({ legalEntityType: null });
    expect(m.branchLine.kind).toBe('none');
    if (m.branchLine.kind === 'none') {
      expect(m.branchLine.reason).toBe('unset');
    }
    expect(m.buyerIsVatRegistrantJuristic).toBe(false);
    expect(m.warnings).toContain('no_branch_line_null_entity_type');
  });

  it('empty-string legal_entity_type is treated as unset → WARN(b)', () => {
    const m = computeIssueReviewModel({ legalEntityType: '   ' });
    expect(m.branchLine.kind).toBe('none');
    expect(m.warnings).toContain('no_branch_line_null_entity_type');
  });

  it('WARN(a) no_payment_path fires only when hasNoPaymentPath === true', () => {
    expect(
      computeIssueReviewModel({ legalEntityType: 'company_limited', hasNoPaymentPath: true }).warnings,
    ).toContain('no_payment_path');
    // Undefined (caller cannot determine yet — US5 bank block unbuilt) → dormant.
    expect(
      computeIssueReviewModel({ legalEntityType: 'company_limited' }).warnings,
    ).not.toContain('no_payment_path');
    // Explicit false (payment path present) → no warn.
    expect(
      computeIssueReviewModel({ legalEntityType: 'company_limited', hasNoPaymentPath: false }).warnings,
    ).not.toContain('no_payment_path');
  });

  it('both warnings compose (null entity type AND no payment path)', () => {
    const m = computeIssueReviewModel({ legalEntityType: null, hasNoPaymentPath: true });
    expect(m.warnings).toContain('no_branch_line_null_entity_type');
    expect(m.warnings).toContain('no_payment_path');
    expect(m.warnings).toHaveLength(2);
  });
});

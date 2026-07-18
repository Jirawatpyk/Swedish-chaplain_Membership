/**
 * 107-auto-invoice Task 14 — unit tests for `routeIssueAutoDraftError` +
 * `routeDiscardAutoDraftError`.
 *
 * The load-bearing invariant: the 3 real refusal reasons
 * (`plan_year_drift` / `member_terminated` / `duplicate_live_bill`) route
 * to the SAME `reasonKey` values Task 13's `<AutoRenewalQueueBadges>`
 * already renders via `admin.invoices.list.queue.refusalReason.*` — never a
 * separately-worded duplicate that could drift.
 *
 * Pure — no framework/DB/network.
 */
import { describe, expect, it } from 'vitest';
import {
  routeDiscardAutoDraftError,
  routeIssueAutoDraftError,
} from '@/app/(staff)/admin/invoices/_components/issue-auto-draft-error-routing';

describe('routeIssueAutoDraftError', () => {
  it('duplicate_live_bill → refusal_reason:duplicateLiveBill, carries conflictingInvoiceId', () => {
    expect(
      routeIssueAutoDraftError({
        code: 'duplicate_live_bill',
        conflicting_invoice_id: 'inv-conflict-1',
      }),
    ).toEqual({
      kind: 'refusal_reason',
      reasonKey: 'duplicateLiveBill',
      conflictingInvoiceId: 'inv-conflict-1',
    });
  });

  it('duplicate_live_bill without a conflicting id still routes (defensive)', () => {
    expect(routeIssueAutoDraftError({ code: 'duplicate_live_bill' })).toEqual({
      kind: 'refusal_reason',
      reasonKey: 'duplicateLiveBill',
    });
  });

  it('member_terminated → refusal_reason:memberTerminated', () => {
    expect(routeIssueAutoDraftError({ code: 'member_terminated' })).toEqual({
      kind: 'refusal_reason',
      reasonKey: 'memberTerminated',
    });
  });

  it('invalid_draft{reason:plan_year_drift} → refusal_reason:planYearDrift', () => {
    expect(
      routeIssueAutoDraftError({ code: 'invalid_draft', reason: 'plan_year_drift' }),
    ).toEqual({ kind: 'refusal_reason', reasonKey: 'planYearDrift' });
  });

  it('invalid_draft with a DIFFERENT reason (not_auto_renewal / not_draft / member_mismatch) is generic, NOT a fabricated refusal reason', () => {
    for (const reason of ['not_auto_renewal', 'not_draft', 'member_mismatch']) {
      expect(routeIssueAutoDraftError({ code: 'invalid_draft', reason })).toEqual({
        kind: 'generic',
        messageKey: 'invalidDraft',
      });
    }
  });

  it('draft_not_found / cycle_not_found → generic draftNotFound', () => {
    expect(routeIssueAutoDraftError({ code: 'draft_not_found' })).toEqual({
      kind: 'generic',
      messageKey: 'draftNotFound',
    });
    expect(routeIssueAutoDraftError({ code: 'cycle_not_found' })).toEqual({
      kind: 'generic',
      messageKey: 'draftNotFound',
    });
  });

  it('issue_failed → generic issueFailed (the F4 errorCode detail is withheld, not surfaced as a fabricated reason)', () => {
    expect(routeIssueAutoDraftError({ code: 'issue_failed' })).toEqual({
      kind: 'generic',
      messageKey: 'issueFailed',
    });
  });

  it('an unrecognised or missing code falls back to the generic issueFailed copy', () => {
    expect(routeIssueAutoDraftError({ code: 'something_new' })).toEqual({
      kind: 'generic',
      messageKey: 'issueFailed',
    });
    expect(routeIssueAutoDraftError(undefined)).toEqual({
      kind: 'generic',
      messageKey: 'issueFailed',
    });
    expect(routeIssueAutoDraftError(null)).toEqual({
      kind: 'generic',
      messageKey: 'issueFailed',
    });
  });
});

describe('routeDiscardAutoDraftError', () => {
  it('not_draft → discardNotDraft', () => {
    expect(routeDiscardAutoDraftError('not_draft')).toBe('discardNotDraft');
  });

  it('not_found → draftNotFound (shares copy with the issue router\'s not-found case)', () => {
    expect(routeDiscardAutoDraftError('not_found')).toBe('draftNotFound');
  });

  it('an unrecognised or missing code falls back to discardFailed', () => {
    expect(routeDiscardAutoDraftError('something_else')).toBe('discardFailed');
    expect(routeDiscardAutoDraftError(undefined)).toBe('discardFailed');
    expect(routeDiscardAutoDraftError(null)).toBe('discardFailed');
  });
});

/**
 * Unit tests for `routeCreditNoteError` — 088 T021a / FR-032.
 *
 * A credit note mints a §87 tax-document number in-tx, so a credit FAILURE is
 * surfaced INLINE (focused role=alert), never a transient toast. This pure
 * router classifies the credit-note route's error codes into:
 *   - `concurrent` — a stale-write 409 (`invalid_status`,
 *     `concurrent_state_change`, `credit_exceeds_remainder`) → inline
 *     "already credited/voided — refresh";
 *   - `failure`   — a dedicated operator-actionable message
 *     (`receipt_not_creditable`), a codeFallback carrying the raw code, or the
 *     generic unknown copy.
 *
 * Pure — no framework/DB/network.
 */
import { describe, expect, it } from 'vitest';
import { routeCreditNoteError } from '@/app/(staff)/admin/invoices/[invoiceId]/credit-notes/new/_components/credit-note-error-routing';

describe('routeCreditNoteError (FR-032)', () => {
  it('classifies the three 409 stale-write codes as concurrent (refresh, not error)', () => {
    expect(routeCreditNoteError('invalid_status')).toEqual({ kind: 'concurrent' });
    expect(routeCreditNoteError('concurrent_state_change')).toEqual({ kind: 'concurrent' });
    // The creditable remainder shrank because a concurrent credit note landed —
    // a refresh, not a red error, so the admin picks up the new remainder.
    expect(routeCreditNoteError('credit_exceeds_remainder')).toEqual({ kind: 'concurrent' });
  });

  it('maps receipt_not_creditable to the existing dedicated inline message key', () => {
    expect(routeCreditNoteError('receipt_not_creditable')).toEqual({
      kind: 'failure',
      messageKey: 'errors.receiptNotCreditable',
    });
  });

  it('maps receipt_not_rendered to a dedicated "still generating — retry" message, NOT the raw codeFallback', () => {
    // 088 whole-feature review — the async §86/4 receipt PDF is still pending
    // (or failed) so a §86/10 note can't cite a rendered receipt. Give the admin
    // the actionable retry/re-render guidance instead of "Error code: receipt_not_rendered".
    expect(routeCreditNoteError('receipt_not_rendered')).toEqual({
      kind: 'failure',
      messageKey: 'errors.receiptNotRendered',
    });
  });

  it('maps membership_effect_required to a dedicated inline message (F-2, 2026-07-08)', () => {
    expect(routeCreditNoteError('membership_effect_required')).toEqual({
      kind: 'failure',
      messageKey: 'errors.membershipEffectRequired',
    });
  });

  it('an unrecognised but present code falls back to codeFallback with the raw code', () => {
    expect(routeCreditNoteError('overflow')).toEqual({
      kind: 'failure',
      messageKey: 'errors.codeFallback',
      codeArg: 'overflow',
    });
    expect(routeCreditNoteError('blob_upload_failed')).toEqual({
      kind: 'failure',
      messageKey: 'errors.codeFallback',
      codeArg: 'blob_upload_failed',
    });
  });

  it('a missing code falls back to the generic unknown message', () => {
    expect(routeCreditNoteError(undefined)).toEqual({ kind: 'failure', messageKey: 'errors.unknown' });
    expect(routeCreditNoteError(null)).toEqual({ kind: 'failure', messageKey: 'errors.unknown' });
  });
});

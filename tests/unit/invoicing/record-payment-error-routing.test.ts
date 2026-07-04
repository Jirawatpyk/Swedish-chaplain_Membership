/**
 * Unit tests for `routeRecordPaymentError` — 088 T018a / FR-028 + FR-032.
 *
 * Recording a payment MINTS the §87 `RC` tax number in-tx and cannot be rolled
 * back client-side, so its money-mutation modal must NOT use a transient toast
 * on failure. This pure router classifies the pay route's error codes into:
 *   - `concurrent` — a stale-write 409 (already paid / changed elsewhere) →
 *     the modal shows an inline "already paid — refresh" message (NOT an error);
 *   - `failure`   — an irreversible §87-mint failure → an inline role=alert
 *     (focused) with a dedicated message, a codeFallback, or the generic
 *     unknown copy.
 *
 * Pure — no framework/DB/network — so both the classification AND the i18n key
 * selection are locked here.
 */
import { describe, expect, it } from 'vitest';
import { routeRecordPaymentError } from '@/app/(staff)/admin/invoices/_components/record-payment-error-routing';

describe('routeRecordPaymentError (FR-028/FR-032)', () => {
  it('classifies concurrent stale-write codes as concurrent (refresh, not error)', () => {
    expect(routeRecordPaymentError('invalid_status')).toEqual({ kind: 'concurrent' });
    expect(routeRecordPaymentError('concurrent_state_change')).toEqual({ kind: 'concurrent' });
  });

  it('maps dedicated codes to their own inline message key', () => {
    expect(routeRecordPaymentError('legacy_no_tin_event_needs_remediation')).toEqual({
      kind: 'failure',
      messageKey: 'errors.legacy_no_tin_event_needs_remediation',
    });
    expect(routeRecordPaymentError('legacy_invoice_needs_reissue')).toEqual({
      kind: 'failure',
      messageKey: 'errors.legacy_invoice_needs_reissue',
    });
    expect(routeRecordPaymentError('new_flow_bill_requires_flag_on')).toEqual({
      kind: 'failure',
      messageKey: 'errors.new_flow_bill_requires_flag_on',
    });
  });

  it('an unrecognised but present code falls back to codeFallback carrying the raw code', () => {
    expect(routeRecordPaymentError('overflow')).toEqual({
      kind: 'failure',
      messageKey: 'errors.codeFallback',
      codeArg: 'overflow',
    });
    expect(routeRecordPaymentError('pdf_render_failed')).toEqual({
      kind: 'failure',
      messageKey: 'errors.codeFallback',
      codeArg: 'pdf_render_failed',
    });
  });

  it('a missing code (undefined/null) falls back to the generic unknown message', () => {
    expect(routeRecordPaymentError(undefined)).toEqual({ kind: 'failure', messageKey: 'errors.unknown' });
    expect(routeRecordPaymentError(null)).toEqual({ kind: 'failure', messageKey: 'errors.unknown' });
  });
});

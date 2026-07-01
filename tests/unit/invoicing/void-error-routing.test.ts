/**
 * Unit tests for `routeVoidError` — 088 T021a / FR-032.
 *
 * Voiding retires the §87 document number (irreversible-in-effect), so a void
 * FAILURE is surfaced INLINE (focused role=alert), never a transient toast.
 * This pure router classifies the void route's error codes into:
 *   - `concurrent` — a stale-write 409 (`invalid_status`,
 *     `concurrent_state_change`) → inline "already voided — refresh";
 *   - `failure`   — a codeFallback carrying the raw code, or the generic
 *     unknown copy (void has no dedicated operator-actionable message codes).
 *
 * Pure — no framework/DB/network.
 */
import { describe, expect, it } from 'vitest';
import { routeVoidError } from '@/app/(staff)/admin/invoices/[invoiceId]/void/_components/void-error-routing';

describe('routeVoidError (FR-032)', () => {
  it('classifies the 409 stale-write codes as concurrent (refresh, not error)', () => {
    expect(routeVoidError('invalid_status')).toEqual({ kind: 'concurrent' });
    expect(routeVoidError('concurrent_state_change')).toEqual({ kind: 'concurrent' });
  });

  it('every non-concurrent typed code falls back to codeFallback with the raw code', () => {
    for (const code of [
      'invoice_not_found',
      'settings_missing',
      'no_snapshot_on_invoice',
      'pdf_render_failed',
    ]) {
      expect(routeVoidError(code)).toEqual({
        kind: 'failure',
        messageKey: 'errors.codeFallback',
        codeArg: code,
      });
    }
  });

  it('a missing code falls back to the generic unknown message', () => {
    expect(routeVoidError(undefined)).toEqual({ kind: 'failure', messageKey: 'errors.unknown' });
    expect(routeVoidError(null)).toEqual({ kind: 'failure', messageKey: 'errors.unknown' });
  });
});

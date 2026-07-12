/**
 * Unit tests for `routeIssueError` — 088 T021a / FR-032.
 *
 * Issuing pins an IMMUTABLE §86/4 snapshot, so an issue FAILURE is surfaced
 * INLINE (focused role=alert), never a transient toast. This pure router
 * classifies the issue route's error codes into:
 *   - `concurrent` — a stale-write 409 (`invoice_already_issued`) → inline
 *     "already issued — refresh";
 *   - `failure`   — a dedicated operator-actionable message, a codeFallback
 *     carrying the raw code, or the generic unknown copy.
 *
 * Pure — no framework/DB/network.
 */
import { describe, expect, it } from 'vitest';
import { routeIssueError } from '@/app/(staff)/admin/invoices/_components/issue-error-routing';

describe('routeIssueError (FR-032)', () => {
  it('an already-issued 409 is classified as concurrent (refresh, not error)', () => {
    expect(routeIssueError('invoice_already_issued')).toEqual({ kind: 'concurrent' });
  });

  it('maps dedicated codes to their own inline message key', () => {
    expect(routeIssueError('event_no_tin_requires_paid_issue')).toEqual({
      kind: 'failure',
      messageKey: 'errors.event_no_tin_requires_paid_issue',
    });
    expect(routeIssueError('registration_refunded')).toEqual({
      kind: 'failure',
      messageKey: 'errors.registration_refunded',
    });
  });

  // Cluster 5 (Finding 4) — the irreversible §86/4 issue path no longer dumps a
  // raw code for reachable business rejects; each gets actionable inline copy.
  it('maps reachable business rejects to dedicated actionable copy (not a raw code)', () => {
    for (const code of [
      'settings_missing',
      'member_archived',
      'member_not_found',
      'no_buyer_snapshot',
      'invalid_lines',
    ] as const) {
      expect(routeIssueError(code)).toEqual({
        kind: 'failure',
        messageKey: `errors.${code}`,
      });
    }
  });

  // Cluster 5 (Finding 4) — infra faults (rollback happened, nothing issued) map
  // to one generic "temporary problem — retry", never a raw code.
  it('maps infra faults to the generic temporary-retry message', () => {
    for (const code of ['pdf_render_failed', 'blob_upload_failed', 'overflow'] as const) {
      expect(routeIssueError(code)).toEqual({
        kind: 'failure',
        messageKey: 'errors.temporary',
      });
    }
  });

  it('an unrecognised but present code falls back to codeFallback with the raw code', () => {
    // Zero-rate fail-closed codes stay on codeFallback (crafted-request-only —
    // the form fail-closes on them before POST).
    expect(routeIssueError('membership_cannot_be_zero_rated')).toEqual({
      kind: 'failure',
      messageKey: 'errors.codeFallback',
      codeArg: 'membership_cannot_be_zero_rated',
    });
  });

  it('a missing code falls back to the generic unknown message', () => {
    expect(routeIssueError(undefined)).toEqual({ kind: 'failure', messageKey: 'errors.unknown' });
    expect(routeIssueError(null)).toEqual({ kind: 'failure', messageKey: 'errors.unknown' });
  });
});

/**
 * 065 review follow-up [Sev 6, item 2c] — pure unit pin for the shared
 * issuance-route HTTP-status helpers in `src/app/api/invoices/_serialise.ts`
 * (wave-4 S16 `issueErrorStatus` + 065 M-4 `isIssuanceServerFault`).
 *
 * Pins:
 *   1. the FULL base map (exact equality — a silently added/removed/renumbered
 *      code fails here, not in production),
 *   2. the deliberate ABSENCE of `registration_lookup_failed` from the base
 *      map (internal verification error → the 500 DEFAULT arm; see the
 *      rationale comment on the map). `not.toHaveProperty` is the only way
 *      to pin this semantic — via `issueErrorStatus` alone, "absent" and
 *      "mapped to 500" are behaviourally identical,
 *   3. the default-500 arm for unknown codes,
 *   4. override precedence: route override > base map > default 500,
 *   5. `isIssuanceServerFault` — exactly {overflow, pdf_render_failed,
 *      blob_upload_failed} drive route-level ERROR logging; everything else
 *      (incl. registration_lookup_failed, whose diagnostic ERROR is emitted
 *      by the use-case itself with full context) stays WARN at the route.
 */
import { describe, expect, it } from 'vitest';
import {
  ISSUE_ERROR_STATUS_BASE,
  isIssuanceServerFault,
  issueErrorStatus,
} from '@/app/api/invoices/_serialise';

describe('issueErrorStatus — shared issuance-route status map (wave-4 S16)', () => {
  it('pins the FULL base map exactly (any drift is a deliberate, reviewed change)', () => {
    expect(ISSUE_ERROR_STATUS_BASE).toEqual({
      invoice_not_found: 404,
      member_not_found: 404,
      invoice_already_issued: 409,
      member_archived: 409,
      settings_missing: 409,
      registration_refunded: 422,
      invalid_lines: 422,
      no_buyer_snapshot: 422,
      overflow: 422,
      pdf_render_failed: 500,
      blob_upload_failed: 500,
    });
  });

  it('registration_lookup_failed is DELIBERATELY absent from the base map (falls to the 500 default)', () => {
    // Internal verification error — never operator-fixable, so it must not
    // gain a 4xx mapping by accident. Absence (not an explicit 500 entry)
    // is the documented semantic on the map's rationale comment.
    expect(ISSUE_ERROR_STATUS_BASE).not.toHaveProperty('registration_lookup_failed');
    expect(issueErrorStatus('registration_lookup_failed')).toBe(500);
  });

  it('resolves every base-map code through issueErrorStatus unchanged', () => {
    for (const [code, status] of Object.entries(ISSUE_ERROR_STATUS_BASE)) {
      expect(issueErrorStatus(code)).toBe(status);
    }
  });

  it('defaults unknown codes to 500', () => {
    expect(issueErrorStatus('some_future_code_nobody_mapped')).toBe(500);
  });

  it('override precedence: override beats the base map', () => {
    // A route-local override wins even when the base map carries the code.
    expect(issueErrorStatus('invoice_not_found', { invoice_not_found: 410 })).toBe(410);
  });

  it('override supplies route-only codes missing from the base map', () => {
    // The /issue-as-paid route's own override surface (route-only codes).
    expect(issueErrorStatus('not_event_subject', { not_event_subject: 422 })).toBe(422);
    expect(issueErrorStatus('payment_date_future', { payment_date_future: 422 })).toBe(422);
    expect(issueErrorStatus('payment_date_too_old', { payment_date_too_old: 422 })).toBe(422);
  });

  it('non-matching override falls through to the base map, then the default', () => {
    expect(issueErrorStatus('invoice_not_found', { not_event_subject: 422 })).toBe(404);
    expect(issueErrorStatus('unmapped_code', { not_event_subject: 422 })).toBe(500);
  });
});

describe('isIssuanceServerFault — 065 M-4 route-level log-severity split', () => {
  it('exactly the three infra/exhaustion codes are server faults (ERROR at the route)', () => {
    expect(isIssuanceServerFault('overflow')).toBe(true);
    expect(isIssuanceServerFault('pdf_render_failed')).toBe(true);
    expect(isIssuanceServerFault('blob_upload_failed')).toBe(true);
  });

  it('registration_lookup_failed is NOT a route-level server fault (use-case already ERROR-logs it with full context)', () => {
    expect(isIssuanceServerFault('registration_lookup_failed')).toBe(false);
  });

  it('business rejects stay WARN', () => {
    for (const code of [
      'invoice_not_found',
      'member_not_found',
      'invoice_already_issued',
      'member_archived',
      'settings_missing',
      'registration_refunded',
      'invalid_lines',
      'no_buyer_snapshot',
      'not_event_subject',
      'payment_date_future',
      'payment_date_too_old',
    ]) {
      expect(isIssuanceServerFault(code)).toBe(false);
    }
  });
});

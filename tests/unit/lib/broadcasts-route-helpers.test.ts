/**
 * F7.1-T3 — Exhaustive coverage of `httpStatusForBroadcastError` map.
 *
 * Adding a new code to the `F7RouteErrorCode` union without a status
 * mapping is already a TS2741 compile error (the `Record<F7RouteErrorCode, number>`
 * map enforces this). This test pins the *runtime* values so a typo in
 * the map (e.g. `broadcast_subject_too_long: 500` instead of `422`)
 * cannot ship undetected.
 */
import { describe, expect, it } from 'vitest';
import {
  httpStatusForBroadcastError,
  messagesFor,
  type F7RouteErrorCode,
} from '@/lib/broadcasts-route-helpers';

const EXPECTED: Record<F7RouteErrorCode, number> = {
  // Submit preconditions (FR-002 a-k + FR-016a)
  broadcast_member_halted_pending_review: 422,
  // 059-membership-suspension Task 5/8/15 — suspended/terminated member
  // blocked from spending E-Blast quota (policy reject, not infra fault).
  broadcast_membership_suspended_blocked: 422,
  broadcast_rate_limit_exceeded: 429,
  broadcast_not_in_plan: 422,
  broadcast_quota_blocked: 422,
  broadcast_member_missing_primary_contact_email: 422,
  broadcast_subject_too_long: 422,
  broadcast_subject_empty: 422,
  broadcast_body_too_large: 422,
  broadcast_body_unsafe_html: 422,
  // F7.1a US2 (FR-011, AS2 closure 2026-05-20)
  broadcast_body_image_source_unsafe: 422,
  broadcast_custom_recipient_unknown: 422,
  broadcast_custom_recipient_invalid_format: 422,
  broadcast_custom_recipient_empty: 422,
  broadcast_custom_recipient_too_many: 422,
  broadcast_empty_segment_blocked: 422,
  broadcast_audience_too_large: 422,
  // State-machine + lifecycle
  broadcast_immutable_after_submit: 409,
  broadcast_not_found: 404,
  broadcast_invalid_state_transition: 409,
  broadcast_concurrent_action_blocked: 409,
  broadcast_cancel_too_late: 409,
  broadcast_schedule_too_soon: 422,
  broadcast_rejection_reason_required: 400,
  broadcast_rejection_reason_too_long: 400,
  broadcast_cancel_reason_too_long: 400,
  broadcast_member_not_found: 404,
  // COMP-1 PR-review (FIX C) — proxied member is GDPR-Art.17/PDPA-§33 erased
  // (409 existed-then-erased terminal state, vs 404 never-existed).
  broadcast_member_erased: 409,
  // F7.1a US1 — admin retry + partial-delivery
  broadcast_manual_retry_budget_exhausted: 409,
  broadcast_already_retrying_in_progress: 409,
  broadcast_partial_delivery_reason_too_long: 400,
  // Generic HTTP-shape codes
  invalid_body: 400,
  forbidden: 403,
  feature_disabled: 503,
  // R3.6 L-1 — typed 401 code for unauthenticated member-facing
  // routes (was stringly-typed 'no-session' in templates GET route
  // pre-R3.6).
  no_session: 401,
  // R4.2 H-1 — typed 400 code for invalid `locale` query parameter
  // on GET /api/broadcasts/templates (was stringly-typed pre-R4.2).
  invalid_locale: 400,
  internal_error: 500,
};

describe('httpStatusForBroadcastError', () => {
  for (const [code, expectedStatus] of Object.entries(EXPECTED) as Array<
    [F7RouteErrorCode, number]
  >) {
    it(`maps ${code} → ${expectedStatus}`, () => {
      const result = httpStatusForBroadcastError(code);
      expect(result.status).toBe(expectedStatus);
      expect(result.code).toBe(code);
    });
  }

  it('unknown kind falls through to 500 internal_error', () => {
    const result = httpStatusForBroadcastError('not_a_real_code');
    expect(result.status).toBe(500);
    expect(result.code).toBe('internal_error');
  });

  it('empty string falls through to 500 internal_error', () => {
    const result = httpStatusForBroadcastError('');
    expect(result.status).toBe(500);
    expect(result.code).toBe('internal_error');
  });
});

// 059-membership-suspension bug fix — `submitBroadcast` has correctly
// returned this kind since Task 8, but the HTTP route mapper never learned
// about it, so `isF7RouteErrorCode` fell through and every suspended-member
// submit surfaced as a generic 500 instead of the intended 422. This is the
// route-mapping test Task 5 skipped (it only covered the Application
// use-case). Non-vacuous: pins the exact status + bilingual copy, not just
// "is defined".
describe('broadcast_membership_suspended_blocked route mapping', () => {
  it('maps to 422, not the 500 fallback', () => {
    const result = httpStatusForBroadcastError(
      'broadcast_membership_suspended_blocked',
    );
    expect(result.status).toBe(422);
    expect(result.code).toBe('broadcast_membership_suspended_blocked');
  });

  it('resolves a bilingual message telling the member to complete payment', () => {
    const { message, messageThai } = messagesFor(
      'broadcast_membership_suspended_blocked',
    );
    expect(message).toBe(
      'Your membership benefits are suspended. Please complete payment to resume sending E-Blasts.',
    );
    expect(messageThai).toBe(
      'สิทธิประโยชน์สมาชิกภาพของคุณถูกระงับ กรุณาชำระเงินเพื่อกลับมาส่ง E-Blast ได้อีกครั้ง',
    );
  });
});

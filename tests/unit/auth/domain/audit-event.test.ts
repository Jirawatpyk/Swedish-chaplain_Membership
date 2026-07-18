import { describe, expect, it } from 'vitest';
import {
  AUDIT_EVENT_TYPES,
  AUDIT_SUMMARY_MAX_LENGTH,
  isAuditEventType,
} from '@/modules/auth/domain/audit-event';

describe('AUDIT_EVENT_TYPES', () => {
  it('contains 36 event types (17 F1 + 10 F5 route-level + 3 F1 post-ship B5 + 1 go-live SAGA + 1 go-live P3 refund rate-limit + 1 COMP-1 US2a user_erased + 3 staff invitation lifecycle)', () => {
    // F5 route-level events live on F1's audit-repo because they fire
    // BEFORE a tenant tx is established (Group D Architect rationale).
    // Composition by migration:
    //   0043 (Group F)  : webhook_signature_rejected,
    //                     payment_environment_mismatch,
    //                     webhook_api_version_mismatch,
    //                     payment_initiate_rate_limited,
    //                     payment_cancel_rate_limited                 (5)
    //   0046 (audit)    : webhook_unknown_intent,
    //                     webhook_payment_already_canceled            (2)
    //   0047 (Rev I-14) : payment_processor_retrieve_failed           (1)
    //   0048 (Rev S5)   : payment_invoice_not_found                   (1)
    //   0151 (F5R2-C2)  : webhook_dispatch_permanent_failure          (1)
    //   0158 (B5)       : password_change_failed,
    //                     password_reset_email_failed,
    //                     password_malformed_hash_detected            (3)
    //   0198 (#12-13)   : account_creation_compensated                (1)
    //   0199 (P3 n24)   : refund_initiate_rate_limited                (1)
    //                                                                 ──
    //                                                                 15
    // Tenant-scoped payment lifecycle events (payment_initiated /
    // payment_succeeded etc.) do NOT go through this repo — they use
    // the F5 AuditPort with retention_years per data-model.md § 7.1.
    //
    //   0222 (COMP-1 US2a) : user_erased                              (+1)
    // `user_erased` IS an F1 audit-taxonomy event (emitted by the
    // `eraseUser` use-case after anonymising the linked login row), so
    // it lives on this array — unlike `member_number_assigned` /
    // `member_erased` which are F3 events on the shared pg enum only.
    expect(AUDIT_EVENT_TYPES).toHaveLength(36);
  });

  it('includes the COMP-1 US2a F1 linked-user erasure event (migration 0222)', () => {
    expect(AUDIT_EVENT_TYPES).toContain('user_erased');
    expect(AUDIT_EVENT_TYPES).toContain('invitation_reissued');
    expect(AUDIT_EVENT_TYPES).toContain('invitation_revoked');
    expect(AUDIT_EVENT_TYPES).toContain('invitation_expired');
  });

  it('includes the go-live P3 refund rate-limit event (migration 0199, n24)', () => {
    expect(AUDIT_EVENT_TYPES).toContain('refund_initiate_rate_limited');
  });

  it('includes the go-live SAGA compensation event (migration 0198, #12-13)', () => {
    expect(AUDIT_EVENT_TYPES).toContain('account_creation_compensated');
  });

  it('includes expected F1 events', () => {
    expect(AUDIT_EVENT_TYPES).toContain('sign_in_success');
    expect(AUDIT_EVENT_TYPES).toContain('sign_in_failure');
    expect(AUDIT_EVENT_TYPES).toContain('password_reset_failed');
    expect(AUDIT_EVENT_TYPES).toContain('invitation_redemption_failed');
  });

  it('includes F5 Group F webhook + rate-limit events (migration 0043)', () => {
    expect(AUDIT_EVENT_TYPES).toContain('webhook_signature_rejected');
    expect(AUDIT_EVENT_TYPES).toContain('payment_environment_mismatch');
    expect(AUDIT_EVENT_TYPES).toContain('webhook_api_version_mismatch');
    expect(AUDIT_EVENT_TYPES).toContain('payment_initiate_rate_limited');
    expect(AUDIT_EVENT_TYPES).toContain('payment_cancel_rate_limited');
  });

  it('includes F5 webhook ops-visibility events (migration 0046)', () => {
    expect(AUDIT_EVENT_TYPES).toContain('webhook_unknown_intent');
    expect(AUDIT_EVENT_TYPES).toContain('webhook_payment_already_canceled');
  });

  it('includes F5 confirmPayment failure-trail events (migrations 0047/0048)', () => {
    expect(AUDIT_EVENT_TYPES).toContain('payment_processor_retrieve_failed');
    expect(AUDIT_EVENT_TYPES).toContain('payment_invoice_not_found');
  });

  it('includes F1 post-ship B5 events (migration 0158, G7 enumeration)', () => {
    // Pre-G7 the count-only assertion at the top of this file could
    // pass even if one of these names was renamed and a new one added
    // — the count would stay 30. Enumerating the names here makes a
    // rename or removal a CI failure.
    expect(AUDIT_EVENT_TYPES).toContain('password_change_failed');
    expect(AUDIT_EVENT_TYPES).toContain('password_reset_email_failed');
    expect(AUDIT_EVENT_TYPES).toContain('password_malformed_hash_detected');
  });
});

describe('AUDIT_SUMMARY_MAX_LENGTH', () => {
  it('is 500', () => {
    expect(AUDIT_SUMMARY_MAX_LENGTH).toBe(500);
  });
});

describe('isAuditEventType', () => {
  it('accepts every defined event type', () => {
    for (const type of AUDIT_EVENT_TYPES) {
      expect(isAuditEventType(type)).toBe(true);
    }
  });

  it('rejects unknown strings', () => {
    expect(isAuditEventType('login_success')).toBe(false);
    expect(isAuditEventType('')).toBe(false);
    expect(isAuditEventType('SIGN_IN_SUCCESS')).toBe(false);
  });
});

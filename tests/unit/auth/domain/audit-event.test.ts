import { describe, expect, it } from 'vitest';
import {
  AUDIT_EVENT_TYPES,
  AUDIT_SUMMARY_MAX_LENGTH,
  isAuditEventType,
} from '@/modules/auth/domain/audit-event';

describe('AUDIT_EVENT_TYPES', () => {
  it('contains 22 event types (17 F1 original + 5 F5 Group F extensions)', () => {
    // Group F (2026-04-24) extended the union with 3 webhook-reject events
    // (webhook_signature_rejected, payment_environment_mismatch,
    // webhook_api_version_mismatch) + 2 rate-limit events
    // (payment_initiate_rate_limited, payment_cancel_rate_limited) — see
    // commit 74cb37c + migration 0043. These pre-tenant-transaction
    // events live on F1's audit-repo because they fire before a tenant tx
    // is established (Group D Architect review rationale).
    expect(AUDIT_EVENT_TYPES).toHaveLength(22);
  });

  it('includes expected F1 events', () => {
    expect(AUDIT_EVENT_TYPES).toContain('sign_in_success');
    expect(AUDIT_EVENT_TYPES).toContain('sign_in_failure');
    expect(AUDIT_EVENT_TYPES).toContain('password_reset_failed');
    expect(AUDIT_EVENT_TYPES).toContain('invitation_redemption_failed');
  });

  it('includes F5 Group F webhook + rate-limit events', () => {
    expect(AUDIT_EVENT_TYPES).toContain('webhook_signature_rejected');
    expect(AUDIT_EVENT_TYPES).toContain('payment_environment_mismatch');
    expect(AUDIT_EVENT_TYPES).toContain('webhook_api_version_mismatch');
    expect(AUDIT_EVENT_TYPES).toContain('payment_initiate_rate_limited');
    expect(AUDIT_EVENT_TYPES).toContain('payment_cancel_rate_limited');
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

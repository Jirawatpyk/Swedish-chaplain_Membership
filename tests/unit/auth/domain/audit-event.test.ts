import { describe, expect, it } from 'vitest';
import {
  AUDIT_EVENT_TYPES,
  AUDIT_SUMMARY_MAX_LENGTH,
  isAuditEventType,
} from '@/modules/auth/domain/audit-event';

describe('AUDIT_EVENT_TYPES', () => {
  it('contains 17 event types', () => {
    expect(AUDIT_EVENT_TYPES).toHaveLength(17);
  });

  it('includes expected events', () => {
    expect(AUDIT_EVENT_TYPES).toContain('sign_in_success');
    expect(AUDIT_EVENT_TYPES).toContain('sign_in_failure');
    expect(AUDIT_EVENT_TYPES).toContain('password_reset_failed');
    expect(AUDIT_EVENT_TYPES).toContain('invitation_redemption_failed');
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

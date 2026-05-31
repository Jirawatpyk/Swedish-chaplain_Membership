/**
 * F9 US2 (FR-011) — audit-viewer payload redaction map unit test.
 *
 * Pins the objectively-testable per-event-type deny-list: admin sees the full
 * payload; manager has internal-only annotation fields (override reasons, staff
 * notes) stripped. Actor identity is a top-level row field, NOT payload, so it
 * is out of scope here (verified visible-to-manager at the use-case layer).
 */
import { describe, expect, it } from 'vitest';
import {
  GLOBAL_SENSITIVE_PAYLOAD_FIELDS,
  SENSITIVE_PAYLOAD_FIELDS,
  redactPayloadForRole,
  redactSummaryForRole,
} from '@/modules/insights/application/audit-redaction';

describe('redactPayloadForRole', () => {
  it('returns null unchanged (no payload → nothing to redact)', () => {
    expect(redactPayloadForRole('role_changed', null, 'admin')).toBeNull();
    expect(redactPayloadForRole('role_changed', null, 'manager')).toBeNull();
  });

  it('admin sees the FULL payload (no redaction)', () => {
    const payload = { from: 'member', to: 'manager', reason: 'promoted by board' };
    expect(redactPayloadForRole('role_changed', payload, 'admin')).toEqual(payload);
  });

  it('manager has the per-event-type sensitive field stripped', () => {
    const payload = { from: 'member', to: 'manager', reason: 'promoted by board' };
    const out = redactPayloadForRole('role_changed', payload, 'manager');
    expect(out).toEqual({ from: 'member', to: 'manager' });
    expect(out).not.toHaveProperty('reason');
  });

  it('manager has GLOBAL annotation field names stripped even for an unmapped event type', () => {
    // `some_future_event` is not in SENSITIVE_PAYLOAD_FIELDS, but `staff_note`
    // is a global annotation name → deny-by-default for the manager projection.
    const payload = { count: 3, staff_note: 'internal only', note: 'x' };
    const out = redactPayloadForRole('some_future_event', payload, 'manager');
    expect(out).toEqual({ count: 3 });
  });

  it('manager keeps non-sensitive payload fields', () => {
    const payload = { applied_filters: ['eventType'], result_count: 42 };
    expect(redactPayloadForRole('audit_log_queried', payload, 'manager')).toEqual(payload);
  });

  it('strips the whole member_updated `diff` for managers, keeps fields_changed — admin sees diff (PDPA §19)', () => {
    const payload = {
      member_id: 'm-1',
      fields_changed: ['taxId', 'notes'],
      diff: { taxId: { old: '0105...', new: '0107...' }, notes: { old: 'a', new: 'b' } },
    };
    // manager: diff (carrying old/new PII values) gone; accountability fields kept
    expect(redactPayloadForRole('member_updated', payload, 'manager')).toEqual({
      member_id: 'm-1',
      fields_changed: ['taxId', 'notes'],
    });
    // admin: full payload incl. diff
    expect(redactPayloadForRole('member_updated', payload, 'admin')).toEqual(payload);
  });

  it('manager has third-party member PII (email/phone) stripped — admin keeps it (PDPA §19)', () => {
    const payload = { invitee_email: 'x@swecham.test', new_email: 'y@swecham.test', count: 1 };
    // admin: full
    expect(redactPayloadForRole('member_invitation_sent', payload, 'admin')).toEqual(payload);
    // manager: email fields gone, non-PII kept
    expect(redactPayloadForRole('member_invitation_sent', payload, 'manager')).toEqual({ count: 1 });
    // generic `email`/`phone` stripped for an unmapped event too (deny-by-default)
    expect(
      redactPayloadForRole('some_event', { email: 'a@b.c', phone: '123', n: 2 }, 'manager'),
    ).toEqual({ n: 2 });
  });

  it('does not mutate the input payload', () => {
    const payload = { reason: 'x', keep: 1 };
    redactPayloadForRole('role_changed', payload, 'manager');
    expect(payload).toEqual({ reason: 'x', keep: 1 });
  });

  it('exposes a non-empty global deny-list and a per-type map (FR-011 defined map)', () => {
    expect(GLOBAL_SENSITIVE_PAYLOAD_FIELDS.length).toBeGreaterThan(0);
    expect(Object.keys(SENSITIVE_PAYLOAD_FIELDS).length).toBeGreaterThan(0);
  });
});

describe('redactSummaryForRole (staff-review R001)', () => {
  it('admin sees the full summary verbatim (incl email)', () => {
    expect(redactSummaryForRole('disabled manager user@example.com', 'admin')).toBe(
      'disabled manager user@example.com',
    );
  });

  it('manager: email tokens replaced with [email redacted]', () => {
    expect(redactSummaryForRole('disabled manager user@example.com', 'manager')).toBe(
      'disabled manager [email redacted]',
    );
    expect(redactSummaryForRole('invited admin a.b+x@sub.example.co.uk', 'manager')).toBe(
      'invited admin [email redacted]',
    );
  });

  it('manager: a summary with no email is unchanged', () => {
    expect(redactSummaryForRole('3 session(s) revoked on account disable', 'manager')).toBe(
      '3 session(s) revoked on account disable',
    );
  });
});

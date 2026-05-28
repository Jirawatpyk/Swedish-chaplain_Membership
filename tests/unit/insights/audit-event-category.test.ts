/**
 * `auditEventCategory` unit test (F9 US2 — grouped event-type filter).
 *
 * Pins the fragile ordering invariant: F9 read events that share the `member_`
 * prefix (e.g. `member_benefit_viewed`) MUST be categorised as 'dashboard', NOT
 * 'members' — the F9 arm is checked before the generic prefix arms. A branch
 * reorder or a new `member_`-prefixed F9 event without the explicit guard would
 * silently mis-group the filter dropdown with zero failure otherwise.
 */
import { describe, expect, it } from 'vitest';
import { auditEventCategory } from '@/lib/audit-event-label';

describe('auditEventCategory', () => {
  it.each([
    // F9 read/oversight — incl. the member_-prefixed one (ordering trap)
    ['dashboard_viewed', 'dashboard'],
    ['member_benefit_viewed', 'dashboard'],
    ['member_timeline_viewed', 'dashboard'],
    ['audit_log_exported', 'dashboard'],
    ['smart_insight_dismissed', 'dashboard'],
    ['directory_ebook_generated', 'dashboard'],
    ['data_export_requested', 'dashboard'],
    ['insights_cross_tenant_probe', 'dashboard'],
    // members (generic member_ prefix)
    ['member_created', 'members'],
    ['member_updated', 'members'],
    // billing
    ['invoice_issued', 'billing'],
    ['payment_succeeded', 'billing'],
    ['refund_succeeded', 'billing'],
    ['plan_created', 'billing'],
    ['fee_config_updated', 'billing'],
    ['webhook_signature_rejected', 'billing'],
    // broadcasts
    ['broadcast_approved', 'broadcasts'],
    // authentication
    ['sign_in_success', 'authentication'],
    ['password_changed', 'authentication'],
    ['role_changed', 'authentication'],
    ['account_disabled', 'authentication'],
    ['invitation_redemption_failed', 'authentication'],
    // fallback
    ['something_unmapped', 'other'],
  ] as const)('%s → %s', (code, expected) => {
    expect(auditEventCategory(code)).toBe(expected);
  });
});

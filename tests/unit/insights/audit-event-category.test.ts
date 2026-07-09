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
import {
  auditEventCategory,
  resolveEventLabel,
  humanizeEventType,
  type EventLabelTranslator,
} from '@/lib/audit-event-label';

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
    ['members_backup_exported', 'dashboard'],
    // members (generic member_ prefix)
    ['member_created', 'members'],
    ['member_updated', 'members'],
    // F6 EventCreate family (incl. the pii_ attendee-erasure lifecycle)
    ['attendee_matched_member_fuzzy', 'events'],
    ['csv_import_completed', 'events'],
    ['quota_partnership_decremented', 'events'],
    ['event_created', 'events'],
    ['event_buyer_pii_redacted', 'events'],
    ['registration_cross_tenant_probe', 'events'],
    ['ingest_disabled_tenant_admin', 'events'],
    ['wizard_privacy_notice_acknowledged', 'events'],
    ['pii_erasure_completed', 'events'],
    // F8 renewals family — incl. the member_-prefixed ordering trap
    ['renewal_reminder_sent', 'renewals'],
    ['tier_upgrade_suggested', 'renewals'],
    ['at_risk_score_recomputed', 'renewals'],
    ['escalation_task_created', 'renewals'],
    ['lapsed_member_admin_reactivated', 'renewals'],
    // hyphenated F8 reminder-ladder values (only non-[a-z0-9_] enum values)
    ['lapsed_member_admin_reactivation_reminder_t-7', 'renewals'],
    ['member_auto_reactivation_blocked', 'renewals'],
    ['manual_outreach_required', 'renewals'],
    ['f8_role_violation_blocked', 'renewals'],
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

/** Build a fake next-intl-shaped translator over a static label map. */
function fakeT(map: Readonly<Record<string, string>>): EventLabelTranslator {
  const fn = ((key: string) => map[key] ?? key) as EventLabelTranslator;
  fn.has = (key: string) => key in map;
  return fn;
}

describe('resolveEventLabel (viewer/feed → timeline-catalogue fallback)', () => {
  // Primary = sparse viewer namespace; fallback = the richer `audit.eventType`
  // timeline catalogue (localised). Mirrors the audit viewer/feed wiring.
  const primary = fakeT({ member_created: 'Member created' });
  const fallback = fakeT({ member_created: 'สร้างสมาชิก', member_plan_changed: 'Plan changed' });

  it('prefers the primary translator when it has the key', () => {
    expect(resolveEventLabel(primary, 'member_created', fallback)).toBe('Member created');
  });

  it('falls back to the timeline catalogue when the primary lacks the key', () => {
    // Localised label reused from the timeline namespace instead of humanising.
    expect(resolveEventLabel(primary, 'member_plan_changed', fallback)).toBe('Plan changed');
  });

  it('humanises when neither catalogue has the key', () => {
    expect(resolveEventLabel(primary, 'webhook_signature_rejected', fallback)).toBe(
      'Webhook signature rejected',
    );
  });

  it('back-compat: humanises when no fallback translator is provided', () => {
    expect(resolveEventLabel(primary, 'lockout_triggered')).toBe(
      humanizeEventType('lockout_triggered'),
    );
    expect(resolveEventLabel(primary, 'lockout_triggered')).toBe('Lockout triggered');
  });
});

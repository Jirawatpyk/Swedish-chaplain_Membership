/**
 * Shared audit-event label helpers (F9 — activity feed FR-003 + audit viewer
 * FR-009/011). A single source of truth for turning a raw `audit_event_type`
 * code into a localised, human-readable label, with a deterministic humanised
 * fallback for codes not yet in the i18n catalogue.
 *
 * The translator is the next-intl `t` scoped to `admin.dashboard.activity.events`
 * — both the server `getTranslations(...)` and the client `useTranslations(...)`
 * return this shape (a callable with a `.has` guard), so the same helper serves
 * the server-rendered table and the client filter dropdown.
 */

/** next-intl translator scoped to a namespace (callable + `.has` guard). */
export type EventLabelTranslator = ((key: string) => string) & {
  has: (key: string) => boolean;
};

/** Deterministic fallback: `member_created` → `Member created`. */
export function humanizeEventType(eventType: string): string {
  const words = eventType.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Localised label for an event code.
 *
 * Resolution order: the primary translator (`admin.dashboard.activity.events`,
 * which carries the viewer-context phrasing for the common events) → an optional
 * `tFallback` (the `audit.eventType` timeline catalogue, ~99 events with EN/TH/SV)
 * → the deterministic humanised form. The fallback lets the audit viewer + activity
 * feed reuse the timeline's localised labels for events not in their own namespace
 * (so a TH/SV admin sees a localised label instead of the English humanised form),
 * without duplicating ~90 keys. Truly-internal/rare events (in neither catalogue)
 * still humanise gracefully. (code-review deferred-item: audit-label localisation.)
 */
export function resolveEventLabel(
  t: EventLabelTranslator,
  eventType: string,
  tFallback?: EventLabelTranslator,
): string {
  if (t.has(eventType)) return t(eventType);
  if (tFallback?.has(eventType)) return tFallback(eventType);
  return humanizeEventType(eventType);
}

/**
 * Coarse category for an `audit_event_type` — used to GROUP the ~310-option
 * event-type filter so it stays keyboard/SR-navigable (a flat list with many
 * shared prefixes is hard to traverse). Order matters: F9-specific events are
 * matched before the generic `member_`/`account_` prefixes that would
 * otherwise capture them, and the F8 `member_auto_reactivation_*` arm before
 * the generic `member_` arm.
 */
export type AuditEventCategory =
  | 'dashboard'
  | 'authentication'
  | 'members'
  | 'events'
  | 'renewals'
  | 'billing'
  | 'broadcasts'
  | 'other';

export function auditEventCategory(eventType: string): AuditEventCategory {
  // F9 read/oversight events first (some start with `member_`/`data_`).
  if (
    eventType === 'dashboard_viewed' ||
    eventType === 'member_benefit_viewed' ||
    eventType === 'member_timeline_viewed' ||
    eventType === 'members_backup_exported' ||
    eventType.startsWith('audit_log_') ||
    eventType.startsWith('smart_insight_') ||
    eventType.startsWith('directory_') ||
    eventType.startsWith('data_export_') ||
    eventType.startsWith('insights_')
  ) {
    return 'dashboard';
  }
  // F6 EventCreate family (attendee import / CSV / benefit quota / webhook-ingest
  // enable-disable / attendee-PII erasure). BEFORE the generic `event*`-adjacent
  // billing arms; `pii_*` here is the F6 attendee-PII lifecycle (COMP-1 member
  // erasure emits `member_erased`/`user_erased`, which stay under members/other).
  // NOTE: the F6 `webhook_*` ingest events are NOT matched here — they share the
  // `webhook_` prefix with F5 payment webhooks (billing arm), and splitting the
  // two would need a per-value table; they intentionally group under billing
  // (accepted cosmetic compromise, see docs/Bug/2026-07-09-audit-log-i18n-*).
  if (
    eventType.startsWith('attendee_') ||
    eventType.startsWith('csv_import_') ||
    eventType.startsWith('quota_') ||
    eventType.startsWith('event_') ||
    eventType.startsWith('registration_') ||
    eventType.startsWith('ingest_disabled_') ||
    eventType.startsWith('wizard_') ||
    eventType.startsWith('pii_')
  ) {
    return 'events';
  }
  // F8 renewal-pipeline family — incl. the `member_`-prefixed auto-reactivation
  // pair (ordering trap: must precede the generic `member_` arm) and the
  // `lapsed_member_*` admin-reactivation events.
  if (
    eventType.startsWith('renewal_') ||
    eventType.startsWith('tier_upgrade_') ||
    eventType.startsWith('at_risk_') ||
    eventType.startsWith('escalation_task_') ||
    eventType.startsWith('lapsed_member_') ||
    eventType.startsWith('member_auto_reactivation_') ||
    eventType === 'manual_outreach_required' ||
    eventType === 'f8_role_violation_blocked'
  ) {
    return 'renewals';
  }
  if (eventType.startsWith('member_')) return 'members';
  if (eventType.startsWith('broadcast_')) return 'broadcasts';
  if (
    eventType.startsWith('invoice_') ||
    eventType.startsWith('credit_note_') ||
    eventType.startsWith('payment_') ||
    eventType.startsWith('refund_') ||
    eventType.startsWith('plan_') ||
    eventType.startsWith('fee_') ||
    eventType.startsWith('webhook_') ||
    eventType.startsWith('out_of_band_') ||
    // 088 L1 — the §86/4 tax-receipt lifecycle events (`tax_receipt_issued`,
    // `receipt_rendered`, `receipt_pdf_downloaded`, …) are billing/tax-document
    // events; without this guard they fell through to 'other' in the audit
    // viewer's grouped event-type filter.
    eventType.startsWith('tax_') ||
    eventType.startsWith('receipt_')
  ) {
    return 'billing';
  }
  if (
    eventType.startsWith('sign_in') ||
    eventType.startsWith('sign_out') ||
    eventType.startsWith('password') ||
    eventType.startsWith('account_') ||
    eventType.startsWith('role_') ||
    eventType.startsWith('lockout_') ||
    eventType.startsWith('session_') ||
    eventType.startsWith('concurrent_') ||
    eventType.startsWith('manager_denied') ||
    eventType.startsWith('invitation_')
  ) {
    return 'authentication';
  }
  return 'other';
}

/** Category render order for grouped pickers. */
export const AUDIT_EVENT_CATEGORY_ORDER: readonly AuditEventCategory[] = [
  'dashboard',
  'authentication',
  'members',
  'events',
  'renewals',
  'billing',
  'broadcasts',
  'other',
];

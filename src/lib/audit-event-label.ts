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
 * Coarse category for an `audit_event_type` — used to GROUP the ~44-option
 * event-type filter so it stays keyboard/SR-navigable (a flat list of 44 with
 * many shared prefixes is hard to traverse). Order matters: F9-specific events
 * are matched before the generic `member_`/`account_` prefixes that would
 * otherwise capture them.
 */
export type AuditEventCategory =
  | 'dashboard'
  | 'authentication'
  | 'members'
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
  'billing',
  'broadcasts',
  'other',
];

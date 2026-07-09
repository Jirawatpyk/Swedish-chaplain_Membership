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
 * shared prefixes is hard to traverse). `AUDIT_CATEGORY_OVERRIDES` resolves the
 * cross-feature prefix collisions first; then a prefix heuristic. Order matters:
 * F9-specific events are matched before the generic `member_`/`account_`
 * prefixes that would otherwise capture them, and the F8
 * `member_auto_reactivation_*` arm before the generic `member_` arm.
 *
 * Categories only affect the dropdown GROUP HEADING — the filter value is the
 * event type itself, so a mis-grouping never hides an event, and a genuinely
 * shared value is left in a sensible default rather than mislabelled.
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

/**
 * Exact-value overrides for events whose owning feature does NOT match what the
 * prefix heuristic below would assign — resolved by verified emit-site module
 * (2026-07-09 self-review). Checked FIRST. Only cross-feature *collisions* live
 * here; genuinely ambiguous values shared by two features (`webhook_signature_rejected`
 * = F5 payments + F6 events; `cron_bearer_auth_rejected` = the shared
 * `src/lib/cron-auth.ts` gate used by every feature's cron routes) are
 * deliberately absent — they keep their prefix/default category rather than
 * being forced into one feature's group.
 */
const AUDIT_CATEGORY_OVERRIDES: ReadonlyMap<string, AuditEventCategory> = new Map([
  // F6 EventCreate webhook-ingest events share the `webhook_` prefix with F5
  // payment webhooks (billing arm) — these 12 are events-owned.
  ['webhook_receipt_verified', 'events'],
  ['webhook_replay_rejected', 'events'],
  ['webhook_duplicate_rejected', 'events'],
  ['webhook_malformed_rejected', 'events'],
  ['webhook_rolled_back', 'events'],
  ['webhook_ingest_precondition_failed', 'events'],
  ['webhook_rate_limit_exceeded', 'events'],
  ['webhook_test_invoked', 'events'],
  ['webhook_secret_generated', 'events'],
  ['webhook_secret_rotated', 'events'],
  ['webhook_secret_grace_used', 'events'],
  ['webhook_secret_force_expired', 'events'],
  // F4/088 invoicing events whose `event_`/`registration_` prefix the events
  // arm would otherwise steal — billing-owned.
  ['event_buyer_pii_redacted', 'billing'],
  ['registration_cross_tenant_probe', 'billing'],
  // F8 renewals cron dispatch — no renewals-family prefix.
  ['cron_dispatch_orchestrated', 'renewals'],
  // F7 broadcast consent event carries a `member_` prefix.
  ['member_acknowledged_broadcasts_terms', 'broadcasts'],
] as const);

export function auditEventCategory(eventType: string): AuditEventCategory {
  const override = AUDIT_CATEGORY_OVERRIDES.get(eventType);
  if (override) return override;
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
  // The two invoicing values that share the `event_`/`registration_` prefix are
  // steered back to billing by AUDIT_CATEGORY_OVERRIDES above; the F6 `webhook_*`
  // ingest events are steered INTO events there (they share `webhook_` with F5).
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
  // `lapsed_member_*` admin-reactivation events. (`cron_dispatch_orchestrated`
  // is steered in via AUDIT_CATEGORY_OVERRIDES — it has no renewals prefix.)
  if (
    eventType.startsWith('renewal_') ||
    eventType.startsWith('tier_upgrade_') ||
    eventType.startsWith('at_risk_') ||
    eventType.startsWith('escalation_task_') ||
    eventType.startsWith('lapsed_member_') ||
    eventType.startsWith('member_auto_reactivation_') ||
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

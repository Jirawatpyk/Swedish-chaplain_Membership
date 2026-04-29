/**
 * T028 — `AuditPort` Application port (F7).
 *
 * 37 F7 audit event types as a const tuple + discriminated union for
 * compile-time safety on emit sites. Mirror of F4 audit-port pattern,
 * but ALL F7 events default to **5-year retention** (no tax-document
 * overlap; F7 is operational + marketing-consent + privacy events).
 *
 * The retention column on `audit_log` (Constitution v1.4.0 trigger
 * 0063) defaults to 5 unless the emitter sets it explicitly. F7
 * emitters MUST call `f7RetentionFor(eventType)` to be defensive
 * against future spec amendments that promote an F7 event to 10y
 * (none currently).
 *
 * Event taxonomy:
 *   - Draft / submission (US1): 15 events
 *   - Admin review (US2): 11 events
 *   - Cross-tenant probes: 2 events
 *   - Unsubscribe + suppression (US4): 4 events
 *   - Webhook (US5): 1 event
 *   - Plan-expiry edge (US6): 1 event
 *   - Clarifications session 5 (Q14 + Q15): 3 events
 *   = 37 total
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

export const F7_AUDIT_EVENT_TYPES = [
  // --- Draft / submission (US1) — 15 events --------------------------
  'broadcast_drafted',
  'broadcast_submitted',
  'broadcast_quota_blocked',
  'broadcast_empty_segment_blocked',
  'broadcast_rate_limit_exceeded',
  'broadcast_not_in_plan',
  'broadcast_immutable_after_submit',
  'broadcast_subject_too_long',
  'broadcast_body_too_large',
  'broadcast_body_unsafe_html',
  'broadcast_audience_too_large',
  'broadcast_custom_recipient_unknown',
  'broadcast_member_missing_primary_contact_email',
  'member_missing_primary_contact',
  'broadcast_member_halted_pending_review', // R3-NEW-1

  // --- Admin review (US2) — 11 events --------------------------------
  'broadcast_approved',
  'broadcast_rejected',
  'broadcast_cancelled',
  'broadcast_cancel_too_late',
  'broadcast_send_started',
  'broadcast_send_timeout_completed',
  'broadcast_sent',
  'broadcast_quota_consumed',
  'broadcast_failed_to_dispatch',
  'broadcast_resend_resource_missing', // R2-NEW-3
  'broadcast_concurrent_action_blocked',

  // --- Cross-tenant probes (Constitution Principle I) — 2 events ----
  'broadcast_cross_member_probe',
  'broadcast_cross_tenant_probe',

  // --- Unsubscribe + suppression (US4) — 4 events --------------------
  'broadcast_unsubscribed',
  'broadcast_unsubscribe_token_invalid',
  'broadcast_suppression_applied',
  'broadcast_complaint_received',

  // --- Webhook (US5) — 1 event ---------------------------------------
  'broadcast_webhook_signature_rejected',

  // --- Plan-expiry edge (US6) — 1 event ------------------------------
  'broadcast_sent_with_expired_member_plan',

  // --- Clarifications session 5 (Q14 + Q15) — 3 events ---------------
  'broadcast_complaint_rate_per_broadcast_breach', // Q14 / SC-005 (b)
  'broadcast_member_dispatch_resumed',             // Q14 admin clear-halt
  'member_acknowledged_broadcasts_terms',          // Q15 GDPR Art. 7
] as const;

/**
 * Static assertion: count matches the declared 37. Catches drift if a
 * spec amendment adds an event without updating this file. The check
 * lives at type level; if the count is wrong, TypeScript errors here
 * with "Type '38' is not assignable to type '37'" (or similar).
 */
type _AssertF7AuditEventCount = (typeof F7_AUDIT_EVENT_TYPES)['length'] extends 37
  ? true
  : never;
const _assertF7AuditEventCount: _AssertF7AuditEventCount = true;

export type F7AuditEventType = (typeof F7_AUDIT_EVENT_TYPES)[number];

/**
 * Retention-year mapping for F7 audit events (data-model § 6).
 *
 * All F7 events default to **5y** — F7 has NO tax-document touchpoint.
 * Member-acknowledged broadcasts terms (Q15) is GDPR Art. 7
 * "demonstrable consent" evidence; 5y retention covers the audit
 * window. Suppression rows (`marketing_unsubscribes`) are retained
 * INDEFINITELY at the row level — that's a separate data-retention
 * policy, not an audit-log retention.
 */
export const F7_AUDIT_RETENTION_YEARS: Record<F7AuditEventType, 5> =
  Object.fromEntries(
    F7_AUDIT_EVENT_TYPES.map((eventType) => [eventType, 5 as const]),
  ) as Record<F7AuditEventType, 5>;

/** Single-source helper — call at every F7 emit site. */
export function f7RetentionFor(eventType: F7AuditEventType): 5 {
  return F7_AUDIT_RETENTION_YEARS[eventType];
}

/**
 * F7 audit event payload contract. F7 emit sites populate `payload`
 * with event-specific fields per data-model.md § 6 (e.g.,
 * `broadcast_submitted` carries `broadcastId`, `segmentType`,
 * `estimatedRecipientCount`, etc.). Strict per-event payload typing
 * is deferred to Phase 3+ (per-story emit sites).
 */
export interface F7AuditEvent {
  readonly eventType: F7AuditEventType;
  readonly actorUserId: string;
  readonly summary: string;
  readonly payload: Record<string, unknown>;
}

export interface AuditEmitInput extends F7AuditEvent {
  readonly tenantId: string;
  readonly requestId: string | null;
}

/**
 * Audit emitter interface.
 *
 * `tx` semantics (mirrors F4 + F5):
 *   - **Mutation path**: pass the Drizzle tx handle. Audit row lands
 *     in the same transaction (Constitution Principle I clause 3
 *     atomicity).
 *   - **Read-path probe** (cross-tenant-probe audits): pass `null`.
 *     Adapter writes on auto-commit; probe loss is best-effort.
 */
export interface AuditPort {
  emit(tx: unknown, event: AuditEmitInput): Promise<void>;
}

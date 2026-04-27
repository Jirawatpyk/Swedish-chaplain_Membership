/**
 * T054 — F5 Audit port.
 *
 * 17 F5 audit event types per data-model.md § 7. Discriminated union so
 * callers cannot emit an unknown event_type.
 *
 * `tx` semantics mirror F4's AuditPort:
 *   - mutation path (initiate / confirm / fail / cancel): pass tx handle
 *     → audit commits atomically with the state change.
 *   - best-effort / probe path: pass `null` → auto-commit write; failure
 *     logs but never masks the primary operation error.
 */

/**
 * The 17 event types below are the authoritative F5 audit catalogue
 * (data-model.md § 7). Not all are wired to a use-case in Group D —
 * the following fire from later-phase surfaces and are declared up-
 * front so the enum matches the DB migration 0040 exactly and
 * `check:audit-events` drift-check (scripts/check-audit-event-count.ts)
 * stays truthful:
 *   - `payment_auto_refunded_concurrent_manual_mark` → emitted by a
 *     future admin manual-mark path that races a webhook's
 *     `payment_intent.succeeded` (out of MVP scope; reliability
 *     guardian D-02, tracked, not a bug).
 *   - `refund_*` / `dispute_created` / `tenant_payment_settings_updated`
 *     → Phase 6 (refunds US4), Phase 6 (disputes), admin settings
 *     surface (Group F / Phase 9 respectively).
 */
export type F5AuditEventType =
  | 'payment_initiated'
  | 'payment_succeeded'
  | 'payment_failed'
  | 'payment_canceled'
  // Migration 0049 — distinct from `payment_canceled` (which means
  // user-abandon / sweep-cron / explicit cancel). Method-switch is
  // a different forensic class: the user did NOT abandon — they
  // continued to a different rail. Distinguishing these makes
  // audit-log queries unambiguous (Constitution Principle I sub-
  // clause #4).
  | 'payment_method_switched'
  | 'payment_auto_refunded_stale_invoice'
  | 'payment_auto_refunded_concurrent_manual_mark'
  | 'payment_environment_mismatch'
  | 'payment_cross_tenant_probe'
  | 'refund_initiated'
  | 'refund_succeeded'
  | 'refund_failed'
  | 'out_of_band_refund_detected'
  | 'webhook_signature_rejected'
  | 'webhook_api_version_mismatch'
  | 'tenant_payment_settings_updated'
  | 'online_payment_toggled'
  | 'dispute_created'
  // Migration 0046 (audit 2026-04-25 findings #10 + #13) — webhook
  // ops-visibility events. Both fire from `processWebhookEvent`
  // dispatch on no-op outcomes so ops can see Stripe-side mis-routing
  // / replay patterns instead of silent `ok({ kind: '...' })` returns.
  | 'webhook_unknown_intent'
  | 'webhook_payment_already_canceled'
  // Migration 0047 (Review I-14) — emitted from confirmPayment step 6
  // when retrievePaymentIntent fails. Tx rolls back so payment row
  // stays pending; Stripe retries on its own schedule. Audit row gives
  // ops a forensic trail for mid-webhook Stripe outages.
  | 'payment_processor_retrieve_failed'
  // Migration 0048 (Review S5) — emitted from confirmPayment step 2
  // when the invoice referenced by the PaymentIntent does not exist
  // (cross-tenant mis-route, data-migration gap, or Stripe test-mode
  // replay against a clean DB). markProcessed folds atomically; ops
  // get the forensic trail without 5xx-ing Stripe.
  | 'payment_invoice_not_found'
  // T130a — emitted by `sweepStalePendingRefunds` when a refund row
  // remains in `pending` status longer than the sweep threshold (24h
  // default). Indicates the issueRefund Phase B finalisation never
  // ran AND the Phase B catch's failure-finalise tx also failed
  // (Postgres double-fault). Sweep flips the row to `failed` so a
  // subsequent admin-initiated refund is not blocked by the
  // `refund_in_progress` guard. Stripe + F4 may have already
  // succeeded — ops cross-checks via the runbook
  // `docs/runbooks/stale-pending-refund-sweep.md`. 10-year retention
  // because the row touches the F4 credit-note tax-document lineage.
  | 'stale_pending_refund_detected';

export interface F5AuditEvent {
  readonly tenantId: string | null;        // NULL for pre-resolution webhook rejects
  readonly requestId: string | null;
  readonly eventType: F5AuditEventType;
  readonly actorUserId: string;            // system actor UUID for webhook paths
  readonly summary: string;
  readonly payload: Record<string, unknown>;
  /** Retention policy (data-model § 7.1). */
  readonly retentionYears: 5 | 10;
}

export interface AuditPort {
  /**
   * Emit one audit row.
   *
   * `tx: unknown` carries the caller's Drizzle transaction handle on
   * mutation paths so the audit row commits atomically with the state
   * change. Pass `null` for forensic / best-effort emits that must
   * survive the caller's tx rollback (e.g. cross-tenant probe rejects
   * before any state change). Type is `unknown` (not Drizzle's `tx`)
   * because Application MUST stay ORM-free per Constitution Principle
   * III; the Infrastructure adapter narrows it.
   *
   * M-7 (review 2026-04-27): documented `tx` semantics inline so
   * future implementers see the contract at the type definition.
   */
  emit(tx: unknown, event: F5AuditEvent): Promise<void>;
}

/**
 * Retention-year mapping for all F5 audit event types — single source of
 * truth (data-model.md § 7.1, Thai RD §87/3 + §86/10). Adding a new event
 * type to `F5AuditEventType` forces this map to grow in lockstep
 * (Record<...> exhaustiveness).
 *
 *   10y — events that create or modify a tax-document-adjacent record.
 *    5y — operational / probe / environment / config events.
 */
export const F5_AUDIT_RETENTION_YEARS: Record<F5AuditEventType, 5 | 10> = {
  payment_initiated: 10,
  payment_succeeded: 10,
  payment_failed: 10,
  payment_canceled: 10,
  payment_method_switched: 10,
  payment_auto_refunded_stale_invoice: 10,
  payment_auto_refunded_concurrent_manual_mark: 10,
  refund_initiated: 10,
  refund_succeeded: 10,
  refund_failed: 10,
  out_of_band_refund_detected: 10,
  stale_pending_refund_detected: 10,
  dispute_created: 10,

  payment_environment_mismatch: 5,
  payment_cross_tenant_probe: 5,
  webhook_signature_rejected: 5,
  webhook_api_version_mismatch: 5,
  tenant_payment_settings_updated: 5,
  online_payment_toggled: 5,
  webhook_unknown_intent: 5,
  webhook_payment_already_canceled: 5,
  payment_processor_retrieve_failed: 5,
  payment_invoice_not_found: 5,
};

/**
 * R3 C-1 helper: returns the canonical retention from
 * `F5_AUDIT_RETENTION_YEARS`. Use at every emit call site instead of
 * hardcoding `5` or `10` so the map remains the single source of truth.
 */
export function retentionFor(eventType: F5AuditEventType): 5 | 10 {
  return F5_AUDIT_RETENTION_YEARS[eventType];
}

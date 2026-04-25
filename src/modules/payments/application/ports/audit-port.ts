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
  | 'payment_invoice_not_found';

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
  emit(tx: unknown, event: F5AuditEvent): Promise<void>;
}

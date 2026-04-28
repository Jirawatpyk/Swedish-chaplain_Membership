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
  | 'stale_pending_refund_detected'
  // Migration 0052 (H-11 review 2026-04-27) — emitted from
  // confirmPayment when the state machine acknowledges a permanent
  // terminal-state mismatch (illegal_transition or duplicate-
  // succeeded invariant). Replaces the prior reuse of
  // `payment_processor_retrieve_failed` (which is reserved for
  // mid-webhook Stripe SDK outages). Distinct event so audit-log
  // queries unambiguously separate "Stripe blip" from "permanent
  // state acknowledgement" forensic classes.
  | 'payment_acknowledged_terminal_state';

/**
 * R2 TD-13 (2026-04-27): typed payload shape per event type.
 *
 * Each entry pins the JSON-serialisable fields the audit row's `payload`
 * column carries. The map is intentionally permissive (`Record<string,
 * unknown>` for low-stakes ops events) so this can be adopted
 * incrementally without breaking existing emit sites — opt into stricter
 * typing by importing `F5AuditEventTyped<T>` at a specific call site.
 *
 * Why two-tier: the high-traffic financial events (initiated / succeeded /
 * failed / refunds / probes) carry tax-relevant fields that ops queries
 * depend on; pinning them stops typo-class drift (`subjet_tenant_id` →
 * compile error). The webhook-ops events (signature rejected, api
 * version mismatch, etc.) carry forensic blobs whose shape evolves with
 * Stripe SDK updates; over-pinning here adds churn without forensic
 * value.
 *
 * Migration plan: tighten one event-type per fix-it batch. Drift
 * detection: `tests/unit/payments/audit-port-payload-shapes.test.ts`
 * (post-ship) asserts the pinned shapes match the actual emit calls.
 */
export interface F5AuditPayloadByType {
  payment_initiated: {
    payment_id: string;
    invoice_id: string;
    method: 'card' | 'promptpay';
    amount_satang: string;
    processor_payment_intent_id: string;
    attempt_seq: number;
  };
  payment_succeeded: {
    payment_id: string;
    invoice_id: string;
    method: 'card' | 'promptpay';
    amount_satang: string;
    processor_charge_id: string | null;
    completed_at: string;
    /** Card metadata only present on `method='card'` succeeded payments. */
    card_brand?: string;
    card_last4?: string;
  };
  payment_failed: {
    payment_id: string;
    invoice_id: string;
    failure_reason_code: string;
  };
  payment_canceled: {
    payment_id: string;
    invoice_id: string;
    actor_type: 'member' | 'webhook' | 'admin';
    /** Set on Stripe-failure path (cancel-payment.ts:170). Omitted on happy path. */
    outcome?: 'stripe_error';
    /** Stripe gateway error.kind on the failure path. */
    processor_error_kind?: 'retryable' | 'permanent' | 'idempotency_conflict';
  };
  payment_method_switched: {
    payment_id: string;
    previous_method: 'card' | 'promptpay';
    new_method: 'card' | 'promptpay';
    processor_payment_intent_id: string;
    attempt_seq: number;
    cancel_outcome: 'stripe_confirmed' | 'stripe_error_bypassed';
  };
  payment_auto_refunded_stale_invoice: {
    payment_id: string;
    invoice_id: string;
    refunded_amount_satang: string;
    cause: 'invoice_already_paid' | 'invoice_voided' | 'invoice_credited' | 'invoice_unknown_status';
    processor_refund_id: string;
  };
  payment_auto_refunded_concurrent_manual_mark: Record<string, unknown>;
  payment_environment_mismatch: Record<string, unknown>;
  payment_cross_tenant_probe: {
    acting_tenant_id?: string;
    subject_tenant_id?: string;
    probing_actor_id: string;
    target_entity: string;
    target_id: string;
    bridge_outcome?: string;
    target_owner_member_id?: string;
  };
  refund_initiated: {
    refund_id: string;
    payment_id: string;
    invoice_id: string;
    amount_satang: string;
    reason: string;
    idempotency_key: string;
  };
  /**
   * Two emit shapes:
   *   (a) admin-initiated refund (issue-refund.ts:492) — creates F4 CN
   *       and flips payment/invoice status; payload carries the full
   *       state-transition record.
   *   (b) webhook-driven recovery (process-charge-refunded.ts:155) —
   *       Stripe `charge.refunded` event arrives for a known refund
   *       row that was stuck `pending`; payload carries Stripe ids +
   *       recovery_path discriminator.
   */
  /**
   * R3 TD-2 (2026-04-28): explicit `path` discriminator on both arms
   * so TS narrowing is robust against future field additions. Without
   * the discriminator, TS narrows by `'recovery_path' in payload`
   * (presence-based) which breaks if any optional field overlaps.
   */
  refund_succeeded:
    | {
        path: 'admin_initiated';
        refund_id: string;
        payment_id: string;
        invoice_id: string;
        processor_refund_id: string;
        credit_note_id: string;
        credit_note_number: string;
        amount_satang: string;
        payment_next_status: 'partially_refunded' | 'refunded';
        invoice_next_status: 'partially_credited' | 'credited';
      }
    | {
        path: 'webhook_recovery';
        refund_id: string;
        processor_refund_id: string;
        processor_charge_id: string;
        recovery_path: 'webhook_charge_refunded';
      };
  refund_failed: {
    refund_id: string;
    payment_id: string;
    invoice_id: string;
    failure_reason_code: string;
    phase_b_error_kind?: string;
    processor_refund_id?: string;
    credit_note_id?: string;
  };
  out_of_band_refund_detected: {
    processor_refund_id: string;
    processor_charge_id: string;
    amount_satang: string;
    runbook_url: string;
  };
  /**
   * NOTE: `webhook_signature_rejected` + `webhook_api_version_mismatch`
   * are emitted via the F1 `auditRepo.append` path (route handler at
   * `src/app/api/webhooks/stripe/route.ts:auditReject`), NOT via this
   * F5 `audit.emit` port. The F1 audit shape uses `{ reason }` at the
   * top level instead of `payload`. These entries are kept here so the
   * `F5AuditEventType` discriminated union remains exhaustive — the
   * permissive payload shape is defensive only.
   */
  webhook_signature_rejected: Record<string, unknown>;
  webhook_api_version_mismatch: Record<string, unknown>;
  /**
   * NOTE: emitted by the admin tenant-payment-settings UPDATE surface
   * (Phase 9 polish, not yet wired). When that ships, tighten this to
   * `{ before_keys: string[]; after_keys: string[]; actor_user_id: string; ... }`
   * — never include the actual values (PCI scope: secret-key fields
   * MUST NOT travel through audit log).
   */
  tenant_payment_settings_updated: Record<string, unknown>;
  online_payment_toggled: Record<string, unknown>;
  dispute_created: Record<string, unknown>;
  webhook_unknown_intent: Record<string, unknown>;
  webhook_payment_already_canceled: Record<string, unknown>;
  payment_processor_retrieve_failed: Record<string, unknown>;
  payment_invoice_not_found: Record<string, unknown>;
  stale_pending_refund_detected: {
    refund_id: string;
    payment_id: string;
    invoice_id: string;
    amount_satang: string;
    age_minutes: number;
    original_initiator_user_id: string;
    original_correlation_id: string;
    runbook_url: string;
  };
  payment_acknowledged_terminal_state: Record<string, unknown>;
}

/**
 * R2 TD-13 (2026-04-27 → F5.1-B 2026-04-28): F5AuditEvent is now a
 * discriminated union over `F5AuditEventType`. The `payload` field
 * narrows automatically based on `eventType` literal at the emit site,
 * giving compile-time field-name + value-shape validation for the 12
 * tightened event types. Permissive entries (`Record<string, unknown>`)
 * stay loose to allow incremental hardening without breaking change.
 */
export type F5AuditEvent = {
  [T in F5AuditEventType]: {
    readonly tenantId: string | null;        // NULL for pre-resolution webhook rejects
    readonly requestId: string | null;
    readonly eventType: T;
    readonly actorUserId: string;            // system actor UUID for webhook paths
    readonly summary: string;
    readonly payload: F5AuditPayloadByType[T];
    /** Retention policy (data-model § 7.1). */
    readonly retentionYears: 5 | 10;
  };
}[F5AuditEventType];

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
  // H-11: terminal-state ack — 10y because it documents a permanent
  // payment-status decision that touches tax-document reconciliation
  // (Stripe charge already exists; admin may need to manually adjust
  // F4 invoice state).
  payment_acknowledged_terminal_state: 10,
};

/**
 * R3 C-1 helper: returns the canonical retention from
 * `F5_AUDIT_RETENTION_YEARS`. Use at every emit call site instead of
 * hardcoding `5` or `10` so the map remains the single source of truth.
 */
export function retentionFor(eventType: F5AuditEventType): 5 | 10 {
  return F5_AUDIT_RETENTION_YEARS[eventType];
}

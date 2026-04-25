/**
 * T058 — failPayment use-case (F5 / stripe-webhook.md § 4.2).
 *
 * Handles `payment_intent.payment_failed`. No F4 invocation, no refund.
 */
import { err, ok, type Result } from '@/lib/result';
import type {
  AuditPort,
  ClockPort,
  PaymentsRepo,
  ProcessorEventsRepo,
  ProcessorGatewayPort,
  TenantPaymentSettingsRepo,
} from '../ports';
import { canTransition } from '../../domain/policies/payment-status-transitions';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '../../domain/system-actors';

/**
 * Sentinel reason code emitted on `payment_failed` audit when Stripe
 * does NOT supply a `last_payment_error.code` on the retrieved
 * PaymentIntent. Const-named so dashboards can pin a stable filter
 * (audit 2026-04-25 finding #9 — was previously a bare `'unknown'`
 * literal liable to drift across files).
 */
export const PAYMENT_FAILURE_REASON_UNKNOWN = 'unknown' as const;

export interface FailPaymentInput {
  readonly tenantId: string;
  readonly paymentIntentId: string;
  readonly requestId: string | null;
  readonly eventCreatedAtUnixSeconds: number;
  /**
   * Stripe `event.id` for atomic markProcessed (audit 2026-04-25 #4).
   * Optional for backward compat.
   */
  readonly processorEventId?: string;
}

export type FailPaymentOutcome =
  | { readonly kind: 'processed' }
  | { readonly kind: 'unknown_intent' }
  | { readonly kind: 'already_terminal' };

export type FailPaymentError =
  | { readonly code: 'illegal_transition'; readonly from: string }
  | { readonly code: 'processor_unavailable'; readonly reason: string };

export interface FailPaymentDeps {
  readonly paymentsRepo: PaymentsRepo;
  readonly tenantSettingsRepo: TenantPaymentSettingsRepo;
  readonly processorGateway: ProcessorGatewayPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  /**
   * Optional — pair with `input.processorEventId` for atomic
   * markProcessed inside this use-case's withTx (audit 2026-04-25 #4).
   */
  readonly processorEventsRepo?: ProcessorEventsRepo;
}

export async function failPayment(
  deps: FailPaymentDeps,
  input: FailPaymentInput,
): Promise<Result<FailPaymentOutcome, FailPaymentError>> {
  const settings = await deps.tenantSettingsRepo.getByTenantId(input.tenantId);
  if (!settings) {
    return err({ code: 'processor_unavailable', reason: 'tenant_settings_missing' });
  }

  return await deps.paymentsRepo.withTx(async (tx) => {
    const payment = await deps.paymentsRepo.lockForUpdateByPaymentIntentId(
      tx,
      input.paymentIntentId,
    );
    if (!payment) {
      // Ops-visibility audit (audit 2026-04-25 finding #10): the
      // `payment_intent.payment_failed` webhook arrived for an intent
      // we have no row for. Indicates Stripe-side mis-routing,
      // multi-account collisions, or replay from old test fixtures.
      // Best-effort emit (tx=null): the dispatch tx is read-only at
      // this point, and we want this audit to commit even if the
      // outer dispatch path swallows the result.
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'webhook_unknown_intent',
        actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
        summary: `payment_intent.payment_failed for unknown intent ${input.paymentIntentId}`,
        payload: {
          processor_payment_intent_id: input.paymentIntentId,
          event_type: 'payment_intent.payment_failed',
          event_created_at_unix_seconds: input.eventCreatedAtUnixSeconds,
        },
        retentionYears: 5,
      });
      return ok<FailPaymentOutcome>({ kind: 'unknown_intent' });
    }

    const transition = canTransition(payment.status, 'failed');
    if (!transition.ok) {
      if (transition.error.kind === 'terminal_state') {
        return ok<FailPaymentOutcome>({ kind: 'already_terminal' });
      }
      return err<FailPaymentError>({
        code: 'illegal_transition',
        from: payment.status,
      });
    }

    // Re-fetch to read last_payment_error.code (PCI SAQ-A: never from
    // webhook payload raw).
    const retrieved = await deps.processorGateway.retrievePaymentIntent(
      input.paymentIntentId,
      settings.processorAccountId,
    );
    if (!retrieved.ok) {
      return err<FailPaymentError>({
        code: 'processor_unavailable',
        reason: retrieved.error.kind,
      });
    }

    const completedAt = new Date(input.eventCreatedAtUnixSeconds * 1000);
    const reasonCode =
      retrieved.value.lastPaymentErrorCode ?? PAYMENT_FAILURE_REASON_UNKNOWN;

    await deps.paymentsRepo.updateStatus(tx, {
      paymentId: payment.id,
      tenantId: input.tenantId,
      nextStatus: 'failed',
      failureReasonCode: reasonCode,
      completedAt,
    });

    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId,
      eventType: 'payment_failed',
      actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
      summary: `Payment ${payment.id} failed (${reasonCode})`,
      payload: {
        payment_id: payment.id,
        invoice_id: payment.invoiceId,
        failure_reason_code: reasonCode,
        ...(retrieved.value.card
          ? {
              card_brand: retrieved.value.card.brand,
              card_last4: retrieved.value.card.last4,
            }
          : {}),
      },
      retentionYears: 5,
    });

    // Atomic markProcessed (audit 2026-04-25 #4) — same tx as audit + status update.
    if (deps.processorEventsRepo && input.processorEventId) {
      await deps.processorEventsRepo.markProcessed(tx, input.processorEventId);
    }

    return ok<FailPaymentOutcome>({ kind: 'processed' });
  });
}

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
  ProcessorGatewayPort,
  TenantPaymentSettingsRepo,
} from '../ports';
import { canTransition } from '../../domain/policies/payment-status-transitions';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '../../domain/system-actors';

export interface FailPaymentInput {
  readonly tenantId: string;
  readonly paymentIntentId: string;
  readonly requestId: string | null;
  readonly eventCreatedAtUnixSeconds: number;
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
    const reasonCode = retrieved.value.lastPaymentErrorCode ?? 'unknown';

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

    return ok<FailPaymentOutcome>({ kind: 'processed' });
  });
}

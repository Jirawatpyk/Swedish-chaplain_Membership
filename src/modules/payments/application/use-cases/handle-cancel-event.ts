/**
 * T060 — handleCancelEvent use-case (F5 / stripe-webhook.md § 4.3).
 *
 * Handles `payment_intent.canceled` webhook — either triggered by our
 * own cancelPayment (T059; row already `canceled` → no-op idempotent)
 * OR by a dashboard-initiated cancel (rare).
 */
import { err, ok, type Result } from '@/lib/result';
import type { AuditPort, ClockPort, PaymentsRepo } from '../ports';
import { canTransition } from '../../domain/policies/payment-status-transitions';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '../../domain/system-actors';

export interface HandleCancelEventInput {
  readonly tenantId: string;
  readonly paymentIntentId: string;
  readonly requestId: string | null;
  readonly eventCreatedAtUnixSeconds: number;
}

export type HandleCancelEventOutcome =
  | { readonly kind: 'processed' }
  | { readonly kind: 'already_canceled' }
  | { readonly kind: 'unknown_intent' };

export type HandleCancelEventError = {
  readonly code: 'illegal_transition';
  readonly from: string;
};

export interface HandleCancelEventDeps {
  readonly paymentsRepo: PaymentsRepo;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
}

export async function handleCancelEvent(
  deps: HandleCancelEventDeps,
  input: HandleCancelEventInput,
): Promise<Result<HandleCancelEventOutcome, HandleCancelEventError>> {
  return await deps.paymentsRepo.withTx(async (tx) => {
    const payment = await deps.paymentsRepo.lockForUpdateByPaymentIntentId(
      tx,
      input.paymentIntentId,
    );
    if (!payment) {
      return ok<HandleCancelEventOutcome>({ kind: 'unknown_intent' });
    }

    if (payment.status === 'canceled') {
      // Already canceled via T059 member-initiated path — idempotent no-op.
      return ok<HandleCancelEventOutcome>({ kind: 'already_canceled' });
    }

    const transition = canTransition(payment.status, 'canceled');
    if (!transition.ok) {
      if (transition.error.kind === 'terminal_state') {
        // Reached a terminal NON-canceled state (succeeded/failed/
        // refunded). Cannot cancel. Return no-op to avoid retry-storm.
        return ok<HandleCancelEventOutcome>({ kind: 'already_canceled' });
      }
      return err<HandleCancelEventError>({
        code: 'illegal_transition',
        from: payment.status,
      });
    }

    const completedAt = new Date(input.eventCreatedAtUnixSeconds * 1000);
    await deps.paymentsRepo.updateStatus(tx, {
      paymentId: payment.id,
      tenantId: input.tenantId,
      nextStatus: 'canceled',
      completedAt,
    });

    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId,
      eventType: 'payment_canceled',
      actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
      summary: `Payment ${payment.id} canceled via webhook`,
      payload: {
        payment_id: payment.id,
        invoice_id: payment.invoiceId,
        actor_type: 'webhook',
      },
      retentionYears: 5,
    });

    return ok<HandleCancelEventOutcome>({ kind: 'processed' });
  });
}

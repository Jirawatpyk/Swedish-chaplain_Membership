/**
 * T060 — handleCancelEvent use-case (F5 / stripe-webhook.md § 4.3).
 *
 * Handles `payment_intent.canceled` webhook — either triggered by our
 * own cancelPayment (T059; row already `canceled` → no-op idempotent)
 * OR by a dashboard-initiated cancel (rare).
 */
import { err, ok, type Result } from '@/lib/result';
import type {
  AuditPort,
  ClockPort,
  PaymentsRepo,
  ProcessorEventsRepo,
} from '../ports';
import { canTransition } from '../../domain/policies/payment-status-transitions';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '../../domain/system-actors';

export interface HandleCancelEventInput {
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
  /**
   * Optional — pair with `input.processorEventId` for atomic
   * markProcessed inside this use-case's withTx (audit 2026-04-25 #4).
   */
  readonly processorEventsRepo?: ProcessorEventsRepo;
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
      // Audit 2026-04-26 round-2 self-review #R2-A1: best-effort emit
      // (tx=null) so audit failure cannot roll back markProcessed.
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'webhook_unknown_intent',
        actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
        summary: `payment_intent.canceled for unknown intent ${input.paymentIntentId}`,
        payload: {
          processor_payment_intent_id: input.paymentIntentId,
          event_type: 'payment_intent.canceled',
          event_created_at_unix_seconds: input.eventCreatedAtUnixSeconds,
        },
        retentionYears: 5,
      });
      if (deps.processorEventsRepo && input.processorEventId) {
        await deps.processorEventsRepo.markProcessed(tx, input.processorEventId);
      }
      return ok<HandleCancelEventOutcome>({ kind: 'unknown_intent' });
    }

    if (payment.status === 'canceled') {
      // Audit 2026-04-26 round-2 self-review #R2-A1: best-effort emit.
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'webhook_payment_already_canceled',
        actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
        summary: `Duplicate payment_intent.canceled webhook for already-canceled payment ${payment.id}`,
        payload: {
          payment_id: payment.id,
          invoice_id: payment.invoiceId,
          processor_payment_intent_id: input.paymentIntentId,
        },
        retentionYears: 5,
      });
      if (deps.processorEventsRepo && input.processorEventId) {
        await deps.processorEventsRepo.markProcessed(tx, input.processorEventId);
      }
      return ok<HandleCancelEventOutcome>({ kind: 'already_canceled' });
    }

    const transition = canTransition(payment.status, 'canceled');
    if (!transition.ok) {
      if (transition.error.kind === 'terminal_state') {
        // Reached a terminal NON-canceled state (succeeded/failed/
        // refunded). Cannot cancel. Return no-op + atomic markProcessed
        // to avoid retry-storm + stuck-row class.
        if (deps.processorEventsRepo && input.processorEventId) {
          await deps.processorEventsRepo.markProcessed(
            tx,
            input.processorEventId,
          );
        }
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

    // Atomic markProcessed (audit 2026-04-25 #4) — same tx as audit + status update.
    if (deps.processorEventsRepo && input.processorEventId) {
      await deps.processorEventsRepo.markProcessed(tx, input.processorEventId);
    }

    return ok<HandleCancelEventOutcome>({ kind: 'processed' });
  });
}

/**
 * T060 — handleCancelEvent use-case (F5 / stripe-webhook.md § 4.3).
 *
 * Handles `payment_intent.canceled` webhook — either triggered by our
 * own cancelPayment (T059; row already `canceled` → no-op idempotent)
 * OR by a dashboard-initiated cancel (rare).
 */
import { ok, type Result } from '@/lib/result';
import type {
  AuditPort,
  ClockPort,
  PaymentsRepo,
  ProcessorEventsRepo,
} from '../ports';
import { canTransition } from '../../domain/policies/payment-status-transitions';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '../../domain/system-actors';
import { retentionFor } from '../ports/audit-port';
import { emitWebhookUnknownIntent, markProcessedIfPresent } from './_shared';

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

/**
 * R5 canonical fix (2026-04-25): expose `invoiceId` so the route
 * handler can fire surgical `revalidatePath('/portal/invoices/<id>')`.
 */
export type HandleCancelEventOutcome =
  | { readonly kind: 'processed'; readonly invoiceId: string }
  | { readonly kind: 'already_canceled'; readonly invoiceId: string }
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
      // Best-effort audit emit (tx=null) so audit-table outage cannot
      // roll back the markProcessed sitting inside `tx`.
      await emitWebhookUnknownIntent(
        deps.audit,
        input,
        'payment_intent.canceled',
      );
      await markProcessedIfPresent(deps, input, tx);
      return ok<HandleCancelEventOutcome>({ kind: 'unknown_intent' });
    }

    if (payment.status === 'canceled') {
      // Best-effort audit emit so failure cannot roll back markProcessed.
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
        retentionYears: retentionFor('webhook_payment_already_canceled'),
      });
      await markProcessedIfPresent(deps, input, tx);
      return ok<HandleCancelEventOutcome>({
        kind: 'already_canceled',
        invoiceId: payment.invoiceId,
      });
    }

    const transition = canTransition(payment.status, 'canceled');
    if (!transition.ok) {
      if (transition.error.kind === 'terminal_state') {
        // Reached a terminal NON-canceled state (succeeded/failed/
        // refunded). Cannot cancel. Return no-op + atomic markProcessed
        // to avoid retry-storm + stuck-row class.
        await markProcessedIfPresent(deps, input, tx);
        return ok<HandleCancelEventOutcome>({
        kind: 'already_canceled',
        invoiceId: payment.invoiceId,
      });
      }
      // R4 I-3: illegal_transition on webhook-side cancel is a PERMANENT
      // mismatch. Acknowledge atomically + forensic audit + no-op.
      // (`already_canceled` is the closest no-op kind in the union;
      // ops dashboards filter on the audit row to spot the anomaly.)
      await markProcessedIfPresent(deps, input, tx);
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'payment_processor_retrieve_failed',
        actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
        summary: `handleCancelEvent hit illegal_transition from ${payment.status} (acknowledged + no-op to break retry loop)`,
        payload: {
          payment_intent_id: input.paymentIntentId,
          payment_id: payment.id,
          from_status: payment.status,
          to_status: 'canceled',
          processor_error_kind: 'illegal_transition',
        },
        retentionYears: retentionFor('payment_processor_retrieve_failed'),
      });
      return ok<HandleCancelEventOutcome>({
        kind: 'already_canceled',
        invoiceId: payment.invoiceId,
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
      retentionYears: retentionFor('payment_canceled'),
    });

    // Atomic markProcessed (audit 2026-04-25 #4) — same tx as audit + status update.
    await markProcessedIfPresent(deps, input, tx);

    return ok<HandleCancelEventOutcome>({
      kind: 'processed',
      invoiceId: payment.invoiceId,
    });
  });
}

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
import { retentionFor } from '../ports/audit-port';
import { emitWebhookUnknownIntent, markProcessedIfPresent } from './_shared';
import { paymentsMetrics } from '@/lib/metrics';
import { paymentsTracer } from '@/lib/otel-tracer';
import { SpanStatusCode } from '@opentelemetry/api';

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

/**
 * R5 canonical fix (2026-04-25): expose `invoiceId` on outcome kinds
 * derived from a known payment row so the route handler can fire
 * surgical `revalidatePath('/portal/invoices/<id>')`.
 */
export type FailPaymentOutcome =
  | { readonly kind: 'processed'; readonly invoiceId: string }
  | { readonly kind: 'unknown_intent' }
  | { readonly kind: 'already_terminal'; readonly invoiceId: string };

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
  // T140 OTel span — webhook failure-branch latency.
  return await paymentsTracer().startActiveSpan(
    'payments.fail',
    {
      attributes: {
        'payments.payment_intent_id': input.paymentIntentId,
        'payments.tenant_id': input.tenantId,
      },
    },
    async (span) => {
      try {
        const result = await failPaymentBody(deps, input);
        if (result.ok) {
          span.setAttribute('payments.outcome', result.value.kind);
        } else {
          span.setAttribute('payments.outcome', `err:${result.error.code}`);
        }
        return result;
      } catch (e) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: e instanceof Error ? e.message : 'fail_threw',
        });
        throw e;
      } finally {
        span.end();
      }
    },
  );
}

async function failPaymentBody(
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
      // Ops-visibility audit (audit 2026-04-25 finding #10).
      // best-effort emit (tx=null) per audit-port contract — audit
      // outage MUST NOT roll back markProcessed (avoids stuck-row
      // class on probe paths). markProcessed stays inside `tx` so it
      // commits atomically with the empty dispatch tx.
      await emitWebhookUnknownIntent(
        deps.audit,
        input,
        'payment_intent.payment_failed',
      );
      await markProcessedIfPresent(deps, input, tx);
      return ok<FailPaymentOutcome>({ kind: 'unknown_intent' });
    }

    const transition = canTransition(payment.status, 'failed');
    if (!transition.ok) {
      if (transition.error.kind === 'terminal_state') {
        // Atomic markProcessed (audit 2026-04-26 round-2 #5b) — no
        // state mutation but still mark processor_events.processed_at
        // so the dispatch tail short-circuits and ops dashboards see
        // the terminal-retry as "handled" rather than "stuck".
        await markProcessedIfPresent(deps, input, tx);
        return ok<FailPaymentOutcome>({
          kind: 'already_terminal',
          invoiceId: payment.invoiceId,
        });
      }
      // R4 I-3: illegal_transition (e.g. succeeded → failed) is a
      // PERMANENT webhook-side mismatch. Returning err would bubble
      // to 500 → Stripe retries 24h → stuck-row loop. Acknowledge
      // atomically + forensic audit + no-op return.
      await markProcessedIfPresent(deps, input, tx);
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'payment_processor_retrieve_failed',
        actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
        summary: `failPayment hit illegal_transition from ${payment.status} (acknowledged + no-op to break retry loop)`,
        payload: {
          payment_intent_id: input.paymentIntentId,
          payment_id: payment.id,
          from_status: payment.status,
          to_status: 'failed',
          processor_error_kind: 'illegal_transition',
        },
        retentionYears: retentionFor('payment_processor_retrieve_failed'),
      });
      return ok<FailPaymentOutcome>({
        kind: 'already_terminal',
        invoiceId: payment.invoiceId,
      });
    }

    // Re-fetch to read last_payment_error.code (PCI SAQ-A: never from
    // webhook payload raw).
    const retrieved = await deps.processorGateway.retrievePaymentIntent(
      input.paymentIntentId,
      settings.processorAccountId,
    );
    if (!retrieved.ok) {
      // R3 I-9: forensic audit so ops see Stripe outages during failPayment
      // (mirrors confirmPayment retrieve-fail trail). Best-effort emit on
      // null tx — outer withTx is about to roll back; emitting through
      // `tx` would discard the row we want ops to see.
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'payment_processor_retrieve_failed',
        actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
        summary: `retrievePaymentIntent failed during fail of ${input.paymentIntentId}`,
        payload: {
          payment_intent_id: input.paymentIntentId,
          payment_id: payment.id,
          processor_error_kind: retrieved.error.kind,
        },
        retentionYears: retentionFor('payment_processor_retrieve_failed'),
      });
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
        // R3 I-1: card metadata intentionally OMITTED. A failed payment
        // never produces a tax document, so card_brand/card_last4 have
        // no receipt-correlation purpose — keeping them only widens the
        // PCI surface in the long-retention audit_log.
      },
      retentionYears: retentionFor('payment_failed'),
    });

    // Atomic markProcessed (audit 2026-04-25 #4) — same tx as audit + status update.
    await markProcessedIfPresent(deps, input, tx);

    // T141 metric: decline-rate / forensics by reason_code. Powers
    // SLO-F5-005 success-rate numerator (failures by reason) +
    // dashboard third-row failure breakdown.
    paymentsMetrics.failedCount(input.tenantId, payment.method, reasonCode);

    return ok<FailPaymentOutcome>({
      kind: 'processed',
      invoiceId: payment.invoiceId,
    });
  });
}

/**
 * T056 — processWebhookEvent use-case (F5 / stripe-webhook.md § 3 steps 6–10).
 *
 * Route handler (Group C/F) owns steps 1–5 (raw body read, signature
 * verify, livemode check, api_version check) AND step 7 (tenant
 * resolution) — each of those emits its own audit directly at the route
 * layer. Those route-level responsibilities are pinned by T042 contract
 * test assertions (cases c, d, i) which explicitly check
 * `processWebhookEventMock` is NOT called on those branches.
 *
 * This use-case runs AFTER the route has verified + resolved tenant, and
 * handles:
 *   6.  Idempotency upsert into `processor_events` (ON CONFLICT DO NOTHING).
 *       Duplicate → return `duplicate` outcome; caller 200-s.
 *   8.  UPDATE processor_events.tenant_id = resolved tenant id.
 *   9.  Dispatch by event.type to per-event sub-use-cases. PCI SAQ-A
 *       (guardian Group B F1/F2): we pass only the structured allow-list
 *       envelope `{ id, type, api_version, livemode }` PLUS the narrow
 *       dispatch hint (paymentIntentId / chargeId / refundIds) — never
 *       the full `event.data.object`. Card metadata is re-fetched via
 *       the gateway inside the sub-use-case.
 *   10. markProcessed(processed_at=now()).
 *
 * Security-critical → 100% branch coverage (Principle II).
 */
import { err, ok, type Result } from '@/lib/result';
import type {
  AuditPort,
  ClockPort,
  InvoicingBridgePort,
  PaymentsRepo,
  ProcessorEventsRepo,
  ProcessorGatewayPort,
  RefundsRepo,
  TenantPaymentSettingsRepo,
  VerifiedStripeEvent,
} from '../ports';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '../../domain/system-actors';
import { confirmPayment } from './confirm-payment';
import { failPayment } from './fail-payment';
import { handleCancelEvent } from './handle-cancel-event';

export interface ProcessWebhookEventInput {
  readonly tenantId: string;
  readonly event: VerifiedStripeEvent;
  readonly payloadSha256: string;
  readonly correlationId: string;
  readonly requestId: string | null;
}

export type ProcessWebhookEventOutcome =
  | { readonly kind: 'processed'; readonly dispatched: string }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'acknowledged_only' }
  | { readonly kind: 'auto_refunded_stale_invoice' };

export type ProcessWebhookEventError = {
  readonly code: 'dispatch_failed';
  readonly eventType: string;
  readonly detail: string;
};

export interface ProcessWebhookEventDeps {
  readonly paymentsRepo: PaymentsRepo;
  readonly refundsRepo: RefundsRepo;
  readonly processorEventsRepo: ProcessorEventsRepo;
  readonly tenantSettingsRepo: TenantPaymentSettingsRepo;
  readonly processorGateway: ProcessorGatewayPort;
  readonly invoicingBridge: InvoicingBridgePort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
}

/**
 * Allow-list webhook metadata handed to sub-use-cases (PCI SAQ-A
 * structural guard — T042 (f) asserts this exact shape).
 */
export interface WebhookDispatchEnvelope {
  readonly id: string;
  readonly type: string;
  readonly api_version: string;
  readonly livemode: boolean;
}

export async function processWebhookEvent(
  deps: ProcessWebhookEventDeps,
  input: ProcessWebhookEventInput,
): Promise<Result<ProcessWebhookEventOutcome, ProcessWebhookEventError>> {
  const { event, tenantId } = input;

  // Step 6 — idempotency insert. Runs on its own tx so a duplicate is
  // observed before we open the dispatch tx (avoids a useless row lock
  // on retry).
  const inserted = await deps.paymentsRepo.withTx(async (tx) => {
    return await deps.processorEventsRepo.insertIfNew(tx, {
      id: event.id,
      tenantId,
      eventType: event.type,
      apiVersion: event.apiVersion,
      livemode: event.livemode,
      processorAccountId: event.account,
      outcome: 'processed',
      payloadSha256: input.payloadSha256,
      correlationId: input.correlationId,
      receivedAt: new Date(deps.clock.nowMs()),
    });
  });

  if (!inserted.inserted) {
    // Duplicate delivery — short-circuit.
    return ok<ProcessWebhookEventOutcome>({ kind: 'duplicate' });
  }

  // Step 9 — dispatch. Structured allow-list ONLY (PCI guardian).
  const envelope: WebhookDispatchEnvelope = {
    id: event.id,
    type: event.type,
    api_version: event.apiVersion,
    livemode: event.livemode,
  };

  const { dataObject } = event;

  let outcome: ProcessWebhookEventOutcome;

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const result = await confirmPayment(
        {
          paymentsRepo: deps.paymentsRepo,
          tenantSettingsRepo: deps.tenantSettingsRepo,
          processorGateway: deps.processorGateway,
          invoicingBridge: deps.invoicingBridge,
          audit: deps.audit,
          clock: deps.clock,
        },
        {
          tenantId,
          paymentIntentId: dataObject.id,
          correlationId: input.correlationId,
          requestId: input.requestId,
          eventCreatedAtUnixSeconds: event.createdAtUnixSeconds,
        },
      );
      if (!result.ok) {
        return err<ProcessWebhookEventError>({
          code: 'dispatch_failed',
          eventType: event.type,
          detail: result.error.code,
        });
      }
      if (result.value.kind === 'auto_refunded_stale_invoice') {
        outcome = { kind: 'auto_refunded_stale_invoice' };
      } else {
        outcome = { kind: 'processed', dispatched: envelope.type };
      }
      break;
    }

    case 'payment_intent.payment_failed': {
      const result = await failPayment(
        {
          paymentsRepo: deps.paymentsRepo,
          tenantSettingsRepo: deps.tenantSettingsRepo,
          processorGateway: deps.processorGateway,
          audit: deps.audit,
          clock: deps.clock,
        },
        {
          tenantId,
          paymentIntentId: dataObject.id,
          requestId: input.requestId,
          eventCreatedAtUnixSeconds: event.createdAtUnixSeconds,
        },
      );
      if (!result.ok) {
        return err<ProcessWebhookEventError>({
          code: 'dispatch_failed',
          eventType: event.type,
          detail: result.error.code,
        });
      }
      outcome = { kind: 'processed', dispatched: envelope.type };
      break;
    }

    case 'payment_intent.canceled': {
      const result = await handleCancelEvent(
        {
          paymentsRepo: deps.paymentsRepo,
          audit: deps.audit,
          clock: deps.clock,
        },
        {
          tenantId,
          paymentIntentId: dataObject.id,
          requestId: input.requestId,
          eventCreatedAtUnixSeconds: event.createdAtUnixSeconds,
        },
      );
      if (!result.ok) {
        return err<ProcessWebhookEventError>({
          code: 'dispatch_failed',
          eventType: event.type,
          detail: result.error.code,
        });
      }
      outcome = { kind: 'processed', dispatched: envelope.type };
      break;
    }

    case 'charge.refunded': {
      // Inspect each refund id; if we have no matching refunds row,
      // emit out_of_band_refund_detected (FR-011a). We never mutate
      // invoice state from this branch (runbook handles reconciliation).
      const refundIds = dataObject.refundIds ?? [];
      await deps.paymentsRepo.withTx(async (tx) => {
        for (const refundId of refundIds) {
          const existing = await deps.refundsRepo.findByProcessorRefundId(
            tx,
            tenantId,
            refundId,
          );
          if (!existing) {
            await deps.audit.emit(tx, {
              tenantId,
              requestId: input.requestId,
              eventType: 'out_of_band_refund_detected',
              actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
              summary: `Out-of-band refund detected on charge ${dataObject.id}`,
              payload: {
                processor_refund_id: refundId,
                processor_charge_id: dataObject.id,
                amount_satang: (dataObject.amountSatang ?? 0n).toString(),
                runbook_url: 'docs/runbooks/out-of-band-refund.md',
              },
              retentionYears: 10,
            });
          }
        }
      });
      outcome = { kind: 'processed', dispatched: envelope.type };
      break;
    }

    case 'charge.dispute.created': {
      await deps.paymentsRepo.withTx(async (tx) => {
        await deps.audit.emit(tx, {
          tenantId,
          requestId: input.requestId,
          eventType: 'dispute_created',
          actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
          summary: `Dispute created on charge ${dataObject.id}`,
          payload: {
            dispute_id: dataObject.disputeId ?? null,
            charge_id: dataObject.id,
            amount_satang: (dataObject.amountSatang ?? 0n).toString(),
          },
          retentionYears: 10,
        });
      });
      outcome = { kind: 'processed', dispatched: envelope.type };
      break;
    }

    default: {
      // Unknown event type — forward-compat per § 4.6. Mark the
      // processor_event row as `acknowledged_only`.
      await deps.paymentsRepo.withTx(async (tx) => {
        await deps.processorEventsRepo.updateOutcome(tx, {
          id: event.id,
          outcome: 'acknowledged_only',
        });
      });
      outcome = { kind: 'acknowledged_only' };
    }
  }

  // Step 10 — markProcessed (own tx; processor_events write is
  // independent from dispatch tx).
  await deps.paymentsRepo.withTx(async (tx) => {
    await deps.processorEventsRepo.markProcessed(tx, event.id);
  });

  return ok(outcome);
}

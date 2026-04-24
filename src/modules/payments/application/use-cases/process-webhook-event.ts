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
  // Tracks whether markProcessed was folded into the dispatch tx
  // atomically (refunded / dispute / default branches). Sub-use-case
  // branches (succeeded / failed / canceled) run a separate-tx mark
  // at the tail. See Architect D-03 LOW closeout block below.
  let markedProcessedAtomically = false;

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
      // Architect D-03 LOW (closed 2026-04-24): markProcessed folded
      // into the same withTx as the audit emissions — atomic commit.
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
        // Atomic with the audit writes above.
        await deps.processorEventsRepo.markProcessed(tx, event.id);
      });
      outcome = { kind: 'processed', dispatched: envelope.type };
      markedProcessedAtomically = true;
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
        // Architect D-03 LOW closeout — atomic with audit.
        await deps.processorEventsRepo.markProcessed(tx, event.id);
      });
      outcome = { kind: 'processed', dispatched: envelope.type };
      markedProcessedAtomically = true;
      break;
    }

    default: {
      // Unknown event type — forward-compat per § 4.6. Mark the
      // processor_event row as `acknowledged_only` + processed_at
      // atomically so the row cannot get stuck in a split-commit.
      await deps.paymentsRepo.withTx(async (tx) => {
        await deps.processorEventsRepo.updateOutcome(tx, {
          id: event.id,
          outcome: 'acknowledged_only',
        });
        await deps.processorEventsRepo.markProcessed(tx, event.id);
      });
      outcome = { kind: 'acknowledged_only' };
      markedProcessedAtomically = true;
    }
  }

  // Architect D-03 LOW (2026-04-24, partial closeout):
  // Branches that already marked atomically (refunded / dispute /
  // default) skip this tail call. Sub-use-case branches (succeeded /
  // failed / canceled) keep the split-tx window because their deps
  // shape does not yet expose processorEventsRepo — extending those
  // requires widening 3 sub-use-case Deps interfaces + unit tests
  // (tracked as a post-Phase-3 backend-refactor PR). Until then the
  // failure mode is: dispatch-tx commits, markProcessed-tx fails
  // (e.g. connection drop) → processor_events row has outcome=
  // 'processed' but processed_at=NULL. Next Stripe retry hits the
  // idempotency guard (ON CONFLICT DO NOTHING on id) and returns
  // 200 without re-dispatching, so no double-processing — the only
  // residual is a stuck row visible on observability dashboards,
  // which the out-of-band-refund reconciliation runbook catches.
  if (!markedProcessedAtomically) {
    try {
      await deps.paymentsRepo.withTx(async (tx) => {
        await deps.processorEventsRepo.markProcessed(tx, event.id);
      });
    } catch (e) {
      // Swallow + log — the dispatch already committed; better to
      // 200 Stripe and let reconciliation clean up than 500 and
      // trigger a retry storm for a transient row-marker write.
      // eslint-disable-next-line no-console
      console.warn(
        '[processWebhookEvent] markProcessed split-tx failure (sub-use-case branch) — stuck processor_events row left for reconciliation',
        {
          eventId: event.id,
          eventType: event.type,
          tenantId,
          error: e instanceof Error ? e.message : String(e),
        },
      );
    }
  }

  return ok(outcome);
}

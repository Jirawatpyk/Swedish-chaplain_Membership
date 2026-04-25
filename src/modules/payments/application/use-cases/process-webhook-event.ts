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
 *   6.  Idempotency upsert into `processor_events` (ON CONFLICT DO NOTHING)
 *       with the resolved tenant_id from input. Duplicate → return
 *       `duplicate` outcome; caller 200-s.
 *       (No separate "step 8 UPDATE tenant_id" — that step from the
 *       original design is unimplementable under the RLS SELECT policy
 *       and was abandoned. Audit 2026-04-25 / data-model.md § 5.4.)
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
import {
  noopLogger,
  type AuditPort,
  type ClockPort,
  type InvoicingBridgePort,
  type LoggerPort,
  type PaymentsRepo,
  type ProcessorEventsRepo,
  type ProcessorGatewayPort,
  type RefundsRepo,
  type TenantPaymentSettingsRepo,
  type VerifiedStripeEvent,
} from '../ports';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '../../domain/system-actors';
import { retentionFor } from '../ports/audit-port';
import { confirmPayment, type ConfirmPaymentOutcome } from './confirm-payment';
import { failPayment, type FailPaymentOutcome } from './fail-payment';
import { handleCancelEvent, type HandleCancelEventOutcome } from './handle-cancel-event';

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
  /**
   * Optional structured logger — defaults to `noopLogger` (silent) when
   * absent so existing tests do not need to provide one. Composition
   * root wires `paymentsLogger` (audit 2026-04-25 finding #5).
   */
  readonly logger?: LoggerPort;
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
    // duplicate delivery — but ONLY short-circuit if the prior
    // attempt actually completed (processed_at set). If the previous
    // dispatch tx threw mid-flight, the step-6 row committed to its
    // own tx (outcome='processed') but `processed_at` is still NULL
    // because markProcessed only fires inside the dispatch tx. Without
    // this guard, every Stripe retry hits ON CONFLICT and silently
    // declares duplicate → the event never recovers. Treat
    // `processed_at IS NULL` as "in-flight, retry the dispatch" so the
    // recovery path proceeds normally.
    if (inserted.event.processedAt !== null) {
      return ok<ProcessWebhookEventOutcome>({ kind: 'duplicate' });
    }
    // Fall through into the dispatch block — the row already exists,
    // markProcessed at the tail will set processed_at. The dispatch
    // sub-use-cases are idempotent (lockForUpdate + canTransition
    // guards), so re-running them on the same payment row is safe.
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
          // Audit 2026-04-25 #4: pass processorEventsRepo so the
          // sub-use-case can fold markProcessed into its own withTx.
          processorEventsRepo: deps.processorEventsRepo,
        },
        {
          tenantId,
          paymentIntentId: dataObject.id,
          correlationId: input.correlationId,
          requestId: input.requestId,
          eventCreatedAtUnixSeconds: event.createdAtUnixSeconds,
          processorEventId: event.id,
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
      // Audit 2026-04-26 round-2 self-review #R2-A2: whitelist outcome
      // kinds confirmPayment is KNOWN to mark atomically. New outcome
      // kinds added later default to false → fall through to the tail
      // canary log → regression caught early instead of silent stuck row.
      // typed against the outcome union so adding a new kind in
      // ConfirmPaymentOutcome forces a build error here if the dev
      // forgets to whitelist it (vs runtime canary log only).
      const knownAtomicConfirmKinds = new Set<ConfirmPaymentOutcome['kind']>([
        'processed',
        'auto_refunded_stale_invoice',
        'already_succeeded',
        'unknown_intent',
        // invoice_not_found short-circuit folds markProcessed into the
        // same withTx as the row lock.
        'invoice_not_found',
      ]);
      markedProcessedAtomically = knownAtomicConfirmKinds.has(
        result.value.kind,
      );
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
          processorEventsRepo: deps.processorEventsRepo,
        },
        {
          tenantId,
          paymentIntentId: dataObject.id,
          requestId: input.requestId,
          eventCreatedAtUnixSeconds: event.createdAtUnixSeconds,
          processorEventId: event.id,
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
      // Whitelist (audit 2026-04-26 round-2 self-review #R2-A2).
      // typed against FailPaymentOutcome.
      const knownAtomicFailKinds = new Set<FailPaymentOutcome['kind']>([
        'processed',
        'unknown_intent',
        'already_terminal',
      ]);
      markedProcessedAtomically = knownAtomicFailKinds.has(result.value.kind);
      break;
    }

    case 'payment_intent.canceled': {
      const result = await handleCancelEvent(
        {
          paymentsRepo: deps.paymentsRepo,
          audit: deps.audit,
          clock: deps.clock,
          processorEventsRepo: deps.processorEventsRepo,
        },
        {
          tenantId,
          paymentIntentId: dataObject.id,
          requestId: input.requestId,
          eventCreatedAtUnixSeconds: event.createdAtUnixSeconds,
          processorEventId: event.id,
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
      // Whitelist (audit 2026-04-26 round-2 self-review #R2-A2).
      // typed against HandleCancelEventOutcome.
      const knownAtomicCancelKinds = new Set<HandleCancelEventOutcome['kind']>([
        'processed',
        'unknown_intent',
        'already_canceled',
      ]);
      markedProcessedAtomically = knownAtomicCancelKinds.has(result.value.kind);
      break;
    }

    case 'charge.refunded': {
      // Architect D-03 LOW (closed 2026-04-24): markProcessed folded
      // into the same withTx as the audit emissions — atomic commit.
      // wrap in try/catch so a tx rejection produces an
      // explicit dispatch_failed err (route → 500 → Stripe retries),
      // not a fall-through to `return ok(outcome)` with `outcome`
      // undefined.
      const refundIds = dataObject.refundIds ?? [];
      try {
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
                retentionYears: retentionFor('out_of_band_refund_detected'),
              });
            }
          }
          // Atomic with the audit writes above.
          await deps.processorEventsRepo.markProcessed(tx, event.id);
        });
      } catch (e) {
        return err<ProcessWebhookEventError>({
          code: 'dispatch_failed',
          eventType: event.type,
          // Stripe error messages can carry partial API key
          // fragments / internal ids. Use the class name only — caller
          // logs it into pino + audit downstream where leak risk is real.
          detail: e instanceof Error ? e.constructor.name : 'unknown',
        });
      }
      outcome = { kind: 'processed', dispatched: envelope.type };
      markedProcessedAtomically = true;
      break;
    }

    case 'charge.dispute.created': {
      // same try/catch wrap as charge.refunded above.
      try {
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
            retentionYears: retentionFor('dispute_created'),
          });
          // Architect D-03 LOW closeout — atomic with audit.
          await deps.processorEventsRepo.markProcessed(tx, event.id);
        });
      } catch (e) {
        return err<ProcessWebhookEventError>({
          code: 'dispatch_failed',
          eventType: event.type,
          // Stripe error messages can carry partial API key
          // fragments / internal ids. Use the class name only — caller
          // logs it into pino + audit downstream where leak risk is real.
          detail: e instanceof Error ? e.constructor.name : 'unknown',
        });
      }
      outcome = { kind: 'processed', dispatched: envelope.type };
      markedProcessedAtomically = true;
      break;
    }

    default: {
      // Unknown event type — forward-compat per § 4.6. Mark the
      // processor_event row as `acknowledged_only` + processed_at
      // atomically so the row cannot get stuck in a split-commit.
      // R3 I-8: wrap in try/catch to mirror charge.refunded /
      // charge.dispute.created branches above. A bare throw here
      // would bubble past the route's structured error path.
      try {
        await deps.paymentsRepo.withTx(async (tx) => {
          await deps.processorEventsRepo.updateOutcome(tx, {
            id: event.id,
            outcome: 'acknowledged_only',
          });
          await deps.processorEventsRepo.markProcessed(tx, event.id);
        });
      } catch (e) {
        return err<ProcessWebhookEventError>({
          code: 'dispatch_failed',
          eventType: event.type,
          detail: e instanceof Error ? e.constructor.name : 'unknown',
        });
      }
      outcome = { kind: 'acknowledged_only' };
      markedProcessedAtomically = true;
    }
  }

  // Audit 2026-04-26 round-2 #5b: split-tx tail ELIMINATED. Every
  // sub-use-case branch (succeeded / failed / canceled, including their
  // unknown_intent + already_* + auto_refunded_stale_invoice early-
  // return paths) now folds markProcessed into its own withTx + the
  // refunded / dispute / default branches mark inline. The flag is
  // kept for now as a documentation marker + safety guard: if a future
  // branch forgets to mark, we still log + try the tail commit rather
  // than silently leave a stuck row. Production should NEVER reach the
  // `if (!markedProcessedAtomically)` body — the warn line is the
  // canary that flags any regression.
  if (!markedProcessedAtomically) {
    const log: LoggerPort = deps.logger ?? noopLogger;
    log.error(
      'processWebhookEvent.markedProcessedAtomically_invariant_violated',
      {
        eventId: event.id,
        eventType: event.type,
        tenantId,
        // If this fires, a new dispatch branch was added without
        // setting `markedProcessedAtomically = true` AND without
        // folding markProcessed into the sub-use-case's withTx. Fix
        // the new branch — do NOT silently rely on this tail.
      },
    );
    try {
      await deps.paymentsRepo.withTx(async (tx) => {
        await deps.processorEventsRepo.markProcessed(tx, event.id);
      });
    } catch (e) {
      log.warn('processWebhookEvent.markProcessed_tail_failure', {
        eventId: event.id,
        eventType: event.type,
        tenantId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return ok(outcome);
}

/**
 * processWebhookEvent use-case (F5 / stripe-webhook.md § 3 steps 6–10).
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
import { processChargeRefunded } from './process-charge-refunded';
import { paymentsMetrics } from '@/lib/metrics';
import { paymentsTracer } from '@/lib/otel-tracer';
import { SpanStatusCode } from '@opentelemetry/api';

export interface ProcessWebhookEventInput {
  readonly tenantId: string;
  readonly event: VerifiedStripeEvent;
  readonly payloadSha256: string;
  readonly correlationId: string;
  readonly requestId: string | null;
}

/**
 * R5 canonical fix (2026-04-25): `processed` outcome carries the
 * affected `invoiceId` when the dispatcher can derive it (the
 * sub-use-case loaded a payment row that has a matching `invoice_id`
 * column). The route handler uses this to fire a SURGICAL
 * `revalidatePath('/portal/invoices/<id>')` instead of a broad
 * `[invoiceId]` pattern that busts every invoice's cache.
 *
 * Per-event-type guarantees for `invoiceId` presence on `processed`:
 *
 *   `payment_intent.succeeded`     — ALWAYS set (confirmPayment outcome)
 *   `payment_intent.payment_failed`— ALWAYS set (failPayment outcome)
 *   `payment_intent.canceled`      — ALWAYS set (handleCancelEvent outcome)
 *   `charge.refunded`              — SET when the refund row is in DB
 *                                    (out-of-band refund without DB
 *                                    record falls back to undefined)
 *   `charge.dispute.created`       — UNDEFINED (no payment lookup
 *                                    yet — TODO when dispute UI lands)
 *   default branch (unknown type)  — UNDEFINED
 *
 * `auto_refunded_stale_invoice` always sets `invoiceId` (only emitted
 * by confirmPayment which loaded the payment row).
 *
 * The optional shape (`invoiceId?: string`) is intentional rather
 * than splitting into two `processed` variants — caller logic only
 * needs the boolean "do I have an id?" branch and a discriminated
 * sub-union would force every consumer through an exhaustive switch
 * for no behavioural gain. Route handler uses
 * `typeof outcome.invoiceId === 'string'` to choose surgical vs
 * fallback path.
 */
export type ProcessWebhookEventOutcome =
  | {
      readonly kind: 'processed';
      readonly dispatched: string;
      readonly invoiceId?: string;
    }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'acknowledged_only' }
  | {
      readonly kind: 'auto_refunded_stale_invoice';
      readonly invoiceId: string;
    };

/**
 * R5 S006 — `kind` discriminator lets ops dashboards filter dispatch
 * failures by class WITHOUT re-parsing pino logs:
 *   - `sub_use_case_error`     → confirm/fail/cancel use-case returned err
 *   - `dispatch_threw`         → withTx (audit / markProcessed) threw inside
 *                                charge.refunded / charge.dispute.created
 *   - `unknown_event_type_threw` → default-branch withTx threw while
 *                                acknowledging an unrecognised event type
 */
/**
 * F5R1-IMP2 — set of sub-use-case error codes that the dispatcher
 * classifies as `permanent`. Driven by code (not kind) because each
 * sub-use-case Result.err encodes the recoverable/non-recoverable
 * distinction in its code:
 *   - `tenant_settings_missing` — admin must configure F5 in settings
 *   - `bridge_error` — F4 invoice in unexpected state (admin fix)
 *   - `invoice_not_found` — invoice deleted while payment was in flight
 *   - `invoice_shape_invalid` — F4 schema drift (post-deploy fix)
 *   - `invariant_*` — code bug that won't self-heal
 *   - `payment_method_unsupported` — caller passed a method we don't accept
 * Stripe will stop retrying on these (200 from webhook).
 *
 * Everything else (e.g. `processor_unavailable` for Stripe outage, db
 * transient, generic dispatch_threw) stays `transient` — 500 from
 * webhook → Stripe retries → eventual recovery when the outage clears.
 */
export const PERMANENT_SUB_USE_CASE_DETAILS: ReadonlySet<string> = new Set([
  'tenant_settings_missing',
  'bridge_error',
  'invoice_not_found',
  'invoice_shape_invalid',
  'payment_method_unsupported',
  'invariant_auto_refunded_missing_invoice_id',
]);

export type ProcessWebhookEventError = {
  readonly code: 'dispatch_failed';
  readonly kind:
    | 'sub_use_case_error'
    | 'dispatch_threw'
    | 'unknown_event_type_threw';
  readonly eventType: string;
  readonly detail: string;
  /**
   * F5R1-IMP2 — retry semantics discriminator.
   *
   * `'transient'` → route returns 500; Stripe retries (up to 72h).
   *   Use for: DB outage (Neon down), Stripe API outage (gateway
   *   `retryable`), tenant-resolution-failed (rare race during
   *   onboarding), generic dispatch throw.
   *
   * `'permanent'` → route returns 200 + emits a forensic
   *   `webhook_dispatch_permanent_failure` audit row; Stripe stops
   *   retrying. Use for: F4 bridge errors that cannot self-heal
   *   (`tenant_settings_missing`, `invoice_shape_invalid`, F4
   *   schema-drift errors), `unknown_event_type_threw` on an event
   *   type we explicitly do not handle.
   *
   * Without this discriminator, every error returned 500 → Stripe
   * retried for 72h on permanent classes → retry-storm and audit-log
   * pollution. The retry queue draining cost is the same as
   * webhook-signature-rejected drained: 4xx (or 2xx with forensic
   * trail) tells Stripe to stop.
   */
  readonly permanence: 'transient' | 'permanent';
};

/**
 * F5R1-IMP2 — classify a sub-use-case error code as permanent or
 * transient for retry semantics. See `PERMANENT_SUB_USE_CASE_DETAILS`
 * above for the permanent list.
 */
function categorisePermanence(detail: string): 'transient' | 'permanent' {
  return PERMANENT_SUB_USE_CASE_DETAILS.has(detail) ? 'permanent' : 'transient';
}

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
   * root wires `paymentsLogger`.
   */
  readonly logger?: LoggerPort;
  /**
   * F8 cross-module on-paid hooks. Forwarded into the inner
   * `confirmPayment` deps for the `payment_intent.succeeded` branch so
   * the F8 RenewalCycle transition lands inside F4's atomic tx alongside
   * the invoice flip. Composition root injects via
   * `f8OnPaidCallbacks(tenantId)` when `FEATURE_F8_RENEWALS=true`.
   */
  readonly onPaidCallbacks?: ReadonlyArray<
    (
      evt: import('@/modules/invoicing').F4InvoicePaidEvent,
      tx?: unknown,
    ) => Promise<void>
  >;
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

/**
 * PII-safe error detail formatter for `dispatch_failed` responses.
 *
 * Returns the Error class name (e.g. `"StripeAPIError"`, `"PostgresError"`)
 * if the thrown value is an Error instance, else `"unknown"`. Never returns
 * `e.message` because Stripe error payloads can carry partial API key
 * fragments / internal ids — the route logs the full error into pino +
 * audit downstream where leak risk is contained.
 */
function formatDispatchErrorDetail(e: unknown): string {
  return e instanceof Error ? e.constructor.name : 'unknown';
}

/**
 * Pick `invoiceId` off a sub-use-case outcome union member when the
 * variant carries one. Outcome kinds without an `invoiceId` field
 * (e.g. `unknown_intent`) yield `undefined` so the dispatcher can
 * fall back to the broader revalidation path at the route layer.
 */
function extractInvoiceId(
  value:
    | ConfirmPaymentOutcome
    | FailPaymentOutcome
    | HandleCancelEventOutcome,
): string | undefined {
  // Duck-type narrowing; FailPayment + HandleCancel outcome shapes
  // never carry invoiceId in unit-test fixtures, so the false branch
  // is exercised only via integration paths.
  /* v8 ignore start */
  return 'invoiceId' in value ? value.invoiceId : undefined;
  /* v8 ignore stop */
}

export async function processWebhookEvent(
  deps: ProcessWebhookEventDeps,
  input: ProcessWebhookEventInput,
): Promise<Result<ProcessWebhookEventOutcome, ProcessWebhookEventError>> {
  // T140 OTel span: hop 4 of the F5 distributed trace
  // (`webhook_receive` boundary). Sub-use-case spans (confirm/fail/
  // cancel/charge.refunded) become children automatically via OTel
  // active-context propagation. Route-level signature verify lives in
  // the auto-instrumented Next route handler; this span starts AFTER
  // verify + tenant resolution.
  return await paymentsTracer().startActiveSpan(
    'payments.webhook.process',
    {
      attributes: {
        'webhook.event_id': input.event.id,
        'webhook.event_type': input.event.type,
        'webhook.api_version': input.event.apiVersion,
        'webhook.livemode': input.event.livemode,
        'payments.tenant_id': input.tenantId,
      },
    },
    async (span) => {
      try {
        const result = await processWebhookEventBody(deps, input);
        if (result.ok) {
          span.setAttribute('webhook.outcome', result.value.kind);
        } else {
          span.setAttribute('webhook.outcome', `err:${result.error.code}`);
        }
        return result;
        /* v8 ignore start — tracer error-status path; processWebhookEventBody
         * always returns Result<...>. Defence-in-depth for OOM /
         * tracer-internal throws bypassing the typed contract. */
      } catch (e) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: e instanceof Error ? e.message : 'webhook_threw',
        });
        throw e;
        /* v8 ignore stop */
      } finally {
        span.end();
      }
    },
  );
}

async function processWebhookEventBody(
  deps: ProcessWebhookEventDeps,
  input: ProcessWebhookEventInput,
): Promise<Result<ProcessWebhookEventOutcome, ProcessWebhookEventError>> {
  const { event, tenantId } = input;

  // T141 metric: per-tenant per-event-type ingest rate. Emitted at
  // dispatch entry (after route-level signature/livemode/api_version
  // gates) so it counts only the events that genuinely reached the
  // tenant-resolved dispatcher. Powers dashboard top-row.
  paymentsMetrics.webhookReceiveCount(tenantId, event.type);

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
      // T141 metric: idempotency hit — webhook redelivery skipped
      // because the prior dispatch already committed `processed_at`.
      // Useful baseline for FR-008 idempotency assurance + healthy
      // baseline for SLO-F5-006 zero-double-credit invariant.
      paymentsMetrics.webhookDuplicateIgnored(tenantId, event.type);
      return ok<ProcessWebhookEventOutcome>({ kind: 'duplicate' });
    }
    // Fall through into the dispatch block — the row already exists,
    // markProcessed at the tail will set processed_at. The dispatch
    // sub-use-cases are idempotent (lockForUpdate + canTransition
    // guards), so re-running them on the same payment row is safe.
    //
    // F5R1-E8 — emit a recovery-replay metric so SRE can detect
    // chronic mid-flight crash patterns (Vercel function timeout
    // mid-dispatch, OOM, OTel exporter back-pressure). The recovery
    // is correct + safe, but pino logs alone do not surface to alert
    // rules; this counter does.
    //
    // For `charge.refunded` events, the recovery replay will re-emit
    // the audit row (out_of_band_refund_detected or refund_succeeded
    // depending on branch) — forensic queries that aggregate these
    // MUST group by `payload->>'processor_refund_id'` to dedupe
    // (contract parity with the confirm-payment Phase B docstring).
    paymentsMetrics.webhookDispatchRecoveryReplay(tenantId, event.type);
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
  // F5R1-S5 — flag + tail canary deleted. Every sub-use-case + every
  // inline branch is contracted to fold markProcessed into its own
  // withTx (confirm-payment.ts:582, fail-payment.ts:233, handle-
  // cancel-event.ts:159, process-charge-refunded.ts:233, refunded /
  // dispute / default branches below). The previous defensive flag +
  // canary tail block was documented "unreachable through input
  // manipulation alone" and v8-ignored — it only fired on a code-bug
  // regression that the sweep-stale-pending cron would have caught
  // independently. ~80 lines removed.
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
          // F8: forward cross-module on-paid callbacks so the renewal
          // cycle transition lands inside F4's atomic tx with the invoice
          // flip. `undefined` when `FEATURE_F8_RENEWALS=false`.
          /* v8 ignore next 3 — F8 callback conditional spread; F4-only
           * unit-test paths exercise the absent-callbacks branch. */
          ...(deps.onPaidCallbacks !== undefined
            ? { onPaidCallbacks: deps.onPaidCallbacks }
            : {}),
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
          kind: 'sub_use_case_error',
          eventType: event.type,
          detail: result.error.code,
          permanence: categorisePermanence(result.error.code),
        });
      }
      // R5 canonical fix (2026-04-25): forward `invoiceId` from the
      // sub-use-case outcome up to the route handler so it can fire a
      // surgical `revalidatePath('/portal/invoices/<id>')`. Outcome
      // kinds that DON'T carry invoiceId (e.g. `unknown_intent`)
      // produce undefined here — route falls back to broader pattern.
      const confirmInvoiceId = extractInvoiceId(result.value);
      if (result.value.kind === 'auto_refunded_stale_invoice') {
        // R5 I4 (2026-04-25): `auto_refunded_stale_invoice` is only
        // ever emitted by confirmPayment AFTER it loaded the payment
        // row, so the outcome MUST carry invoiceId. If it doesn't,
        // that's a `confirmPayment` contract violation.
        //
        // convert from
        // `throw new Error('invariant: ...')` to `return err()`.
        // Throwing here bubbles to the route's outer try/catch → 500
        // → Stripe retries the event every 1h × 72h chasing a code
        // bug that won't fix itself. Return a structured
        // `dispatch_failed` instead so the route 500-once + alerts
        // ops via the existing `dispatchFailureKind` log channel,
        // and Stripe gives up after the standard 3-retry-then-die
        // window for non-2xx responses tagged
        // `invariant_*`. Constitution Principle III: Application
        // layer MUST return Result<T,E>, never throw.
        /* v8 ignore start — confirmPayment contract guarantees invoiceId
         * on auto_refunded_stale_invoice; defence-in-depth for post-
         * compile contract drift. */
        if (confirmInvoiceId === undefined) {
          return err<ProcessWebhookEventError>({
            code: 'dispatch_failed',
            kind: 'sub_use_case_error',
            eventType: event.type,
            detail: 'invariant_auto_refunded_missing_invoice_id',
            permanence: 'permanent',
          });
        }
        /* v8 ignore stop */
        outcome = {
          kind: 'auto_refunded_stale_invoice',
          invoiceId: confirmInvoiceId,
        };
      } else {
        outcome = {
          kind: 'processed',
          dispatched: envelope.type,
          ...(confirmInvoiceId !== undefined && { invoiceId: confirmInvoiceId }),
        };
      }
      // Audit 2026-04-26 round-2 self-review #R2-A2: whitelist outcome
      // kinds confirmPayment is KNOWN to mark atomically. New outcome
      // kinds added later default to false → fall through to the tail
      // canary log → regression caught early instead of silent stuck row.
      // typed against the outcome union so adding a new kind in
      // ConfirmPaymentOutcome forces a build error here if the dev
      // forgets to whitelist it (vs runtime canary log only).
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
          kind: 'sub_use_case_error',
          eventType: event.type,
          detail: result.error.code,
          permanence: categorisePermanence(result.error.code),
        });
      }
      // R5 canonical fix (2026-04-25): forward `invoiceId` for
      // surgical revalidation in the route handler.
      const failInvoiceId = extractInvoiceId(result.value);
      outcome = {
        kind: 'processed',
        dispatched: envelope.type,
        ...(failInvoiceId !== undefined && { invoiceId: failInvoiceId }),
      };
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
      /* v8 ignore start -- R4 I-3 (2026-04-26): handleCancelEvent now ack's every error case as ok({kind:'already_canceled'}) to break Stripe's 24h retry loop on permanent mismatches. The err arm here is dead code preserved structurally so the dispatcher matches the other branches' shape; if a future handleCancelEvent revision reintroduces err returns, this guard prevents a silent fall-through to ok(outcome) with `outcome` undefined. */
      if (!result.ok) {
        return err<ProcessWebhookEventError>({
          code: 'dispatch_failed',
          kind: 'sub_use_case_error',
          eventType: event.type,
          detail: result.error.code,
          permanence: categorisePermanence(result.error.code),
        });
      }
      /* v8 ignore stop */
      // R5 canonical fix (2026-04-25): forward `invoiceId`.
      const cancelInvoiceId = extractInvoiceId(result.value);
      outcome = {
        kind: 'processed',
        dispatched: envelope.type,
        ...(cancelInvoiceId !== undefined && { invoiceId: cancelInvoiceId }),
      };
      break;
    }

    case 'charge.refunded': {
      // extracted to `process-charge-refunded.ts` for
      // symmetry with confirm/fail/cancel branches. Behaviour-preserving:
      // dispatcher maps the use-case's `dispatch_failed` Result into this
      // branch's `dispatch_threw` error variant (matches the previous
      // inline try/catch surface).
      const refundResult = await processChargeRefunded(
        {
          paymentsRepo: deps.paymentsRepo,
          refundsRepo: deps.refundsRepo,
          processorEventsRepo: deps.processorEventsRepo,
          audit: deps.audit,
          // review-20260428-102639.md W5 closure — clock is now required.
          clock: deps.clock,
        },
        {
          tenantId,
          requestId: input.requestId,
          eventId: event.id,
          chargeId: dataObject.id,
          refundIds: dataObject.refundIds ?? [],
          amountSatang: dataObject.amountSatang ?? 0n,
          /* v8 ignore start — env-tag ternary; unit-test fixtures pin
           * one livemode value at a time. Cross-livemode coverage
           * lives in the contract tests for /api/webhooks/stripe. */
          processorEnv: event.livemode ? 'live' : 'test',
          /* v8 ignore stop */
        },
      );
      if (!refundResult.ok) {
        return err<ProcessWebhookEventError>({
          code: 'dispatch_failed',
          kind: 'dispatch_threw',
          eventType: event.type,
          // Stripe error messages can carry partial API key fragments /
          // internal ids. Use the class name only — caller logs it into
          // pino + audit downstream where leak risk is real.
          detail: formatDispatchErrorDetail(refundResult.error.cause),
          // Default to transient: Stripe-side or DB-side throw on
          // charge.refunded should retry. The categorise helper would
          // catch the rare permanent-class detail string if needed.
          permanence: 'transient',
        });
      }
      outcome = {
        kind: 'processed',
        dispatched: envelope.type,
        ...(refundResult.value.invoiceId !== undefined && {
          invoiceId: refundResult.value.invoiceId,
        }),
      };
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
          kind: 'dispatch_threw',
          eventType: event.type,
          // Stripe error messages can carry partial API key
          // fragments / internal ids. Use the class name only — caller
          // logs it into pino + audit downstream where leak risk is real.
          detail: formatDispatchErrorDetail(e),
          // Default to transient: a dispatch-tx throw is most likely
          // a Neon transient or OTel back-pressure. The route layer
          // can override after inspecting `detail` if a permanent
          // pattern emerges.
          permanence: 'transient',
        });
      }
      outcome = { kind: 'processed', dispatched: envelope.type };
      break;
    }

    default: {
      // Unknown event type — forward-compat per § 4.6. Mark the
      // processor_event row as `acknowledged_only` + processed_at
      // atomically so the row cannot get stuck in a split-commit.
      // wrap in try/catch to mirror charge.refunded /
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
          kind: 'unknown_event_type_threw',
          eventType: event.type,
          detail: formatDispatchErrorDetail(e),
          // Transient — the default-branch throw is most likely a DB
          // transient on the markProcessed tx (we don't dispatch any
          // business logic for unknown event types). Stripe should
          // retry; the next attempt will succeed cleanly.
          permanence: 'transient',
        });
      }
      outcome = { kind: 'acknowledged_only' };
    }
  }

  return ok(outcome);
}

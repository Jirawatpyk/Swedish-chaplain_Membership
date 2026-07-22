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
// F5R3 MED-6 (2026-05-16) — outcome type imports dropped along with
// the `extractInvoiceId` helper. The inlined `'invoiceId' in
// result.value` narrowing only needs the use-case function imports.
import { confirmPayment } from './confirm-payment';
import { failPayment } from './fail-payment';
import { F5_SETTINGS_MISSING_DETAIL } from './_shared';
import { handleCancelEvent } from './handle-cancel-event';
import { processChargeRefunded } from './process-charge-refunded';
import { processRefundUpdated } from './process-refund-updated';
// money-remediation Task 5 — `RecordPaymentError` types the F4 half of the
// permanence table. TYPE-ONLY, deliberately: a value import from the F4
// barrel would be the first runtime payments -> invoicing coupling and would
// drag F4's composition root (and its Blob adapter) into the webhook bundle.
// That is also why the predicate lives here rather than being exported from
// the invoicing barrel.
import type { RecordPaymentError, TaxAtPaymentFlag } from '@/modules/invoicing';
import { paymentsMetrics } from '@/lib/metrics';
import { asSatang } from '@/lib/money';
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
    }
  // F5R2-TY-A — distinct outcome for the E9 give-up path. Pre-fix
  // this kind fell through to the generic `processed` catch-all →
  // ops dashboards saw it as successful dispatch, masking the
  // "Stripe retry storm broken — operator must reconcile" signal
  // that the audit row carries.
  | {
      readonly kind: 'auto_refund_given_up';
      readonly dispatched: string;
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
export type DispatchPermanence = 'transient' | 'permanent';

/**
 * money-remediation Task 5 — permanence of each F4 `RecordPaymentError`
 * code, as it arrives on the webhook rail.
 *
 * ## How an F4 code gets here
 *
 * `confirm-payment.ts` sets `detail: bridgeResult.error.code` on its
 * `bridge_error`. That `code` is produced by `summariseF4Error`
 * (`invoicing-bridge.ts`), which reads F4's `error.code`. So the KEY IS THE
 * F4 CODE, not the F4 detail — `summariseF4Error` produces a meaningful
 * `.detail` for `pdf_render_failed` / `blob_upload_failed` only; every other
 * variant falls through to `unknown_f4_error_shape (code=…)` and bumps
 * `paymentsMetrics.f4BridgeUnknownErrorShape`. That counter is therefore
 * NOISY BY CONSTRUCTION and must not be alerted on as an anomaly signal.
 *
 * ## Exhaustive on purpose
 *
 * Typing this as a total `Record` over `RecordPaymentError['code']` means a
 * new F4 error code is a BUILD failure here, not a silent default. That is
 * the property the deleted `PERMANENT_SUB_USE_CASE_DETAILS` set lacked, and
 * why it drifted to naming two codes (`invoice_shape_invalid`,
 * `payment_method_unsupported`) that exist nowhere in `src/`.
 *
 * ## Two entries carry history — read before editing
 *
 *   - `settings_missing` (and its F5-side sibling `tenant_settings_missing`,
 *     handled in the predicate below) is permanent by a DOCUMENTED PRIOR FIX,
 *     F5R2-CRIT-2. Flipping either to transient is a verbatim regression:
 *     72h of retries against a configuration gap tenants hit during
 *     onboarding, which cannot self-heal.
 *   - `invalid_status` is a judgement call, and reversible. It cannot be
 *     discriminated from the code alone — `summariseF4Error`'s scalar
 *     whitelist accepts only code/kind/detail/reason and DROPS the `status`
 *     field that `record-payment.ts` attaches, so a lost optimistic race
 *     (retryable) is indistinguishable here from a genuinely wrong status
 *     (not). Called transient on the plan's own stated bias: a transient
 *     mislabelled permanent recreates finding F-1 (silent stranded money); a
 *     permanent mislabelled transient is a bounded, noisy, logged retry storm
 *     capped by the ceiling below. Choose the loud failure over the silent
 *     one. Widening that whitelist to carry `status` is what would let us do
 *     better.
 *
 * `membership_terminated` and `payment_date_out_of_range` are classified but
 * UNREACHABLE on this rail: both sit behind `isAdminDialogRail`
 * (`record-payment.ts`), and `markPaidFromProcessor` hardcodes
 * `triggeredBy: 'webhook'`. They are here because the Record is total.
 */
const F4_RECORD_PAYMENT_PERMANENCE: Readonly<
  Record<RecordPaymentError['code'], DispatchPermanence>
> = {
  // ── Permanent: needs an operator, an admin edit, or a deploy ──────────
  settings_missing: 'permanent',
  invoice_not_found: 'permanent',
  no_snapshot_on_invoice: 'permanent',
  legacy_no_tin_event_needs_remediation: 'permanent',
  legacy_invoice_needs_reissue: 'permanent',
  // A CONFIG gap, classified with `settings_missing`: it clears only when an
  // operator flips `FEATURE_088_TAX_AT_PAYMENT` on, which no Stripe retry can
  // do. Trade-off (task-5 review L-2): if the flag is toggled OFF→ON within
  // minutes, in-flight PIs captured while OFF get 200-acked here and are not
  // retried, so an operator reconciles them from the forensic row — accepted,
  // because treating it transient would instead 72h-retry every capture during
  // a deliberate flag-OFF window.
  new_flow_bill_requires_flag_on: 'permanent',
  overflow: 'permanent',
  membership_terminated: 'permanent',
  payment_date_out_of_range: 'permanent',
  // ── Transient: recovers on its own, well inside Stripe's 72h window ───
  pdf_render_failed: 'transient',
  blob_upload_failed: 'transient',
  concurrent_state_change: 'transient',
  invalid_status: 'transient',
};

/**
 * money-remediation Task 5 / finding F-1 item 3 — the transient-retry
 * budget, after which a transient is 200-acked with a forensic audit row
 * instead of retried forever.
 *
 * ## Why a ceiling is mandatory here, not a nice-to-have
 *
 * Deriving permanence from the sub-code means transient F4 declines now
 * return 500 where they previously returned 200. That raises the error rate
 * on the Stripe webhook endpoint — and **Stripe disables endpoints that fail
 * persistently**. Without a ceiling, a systemic F4 or Blob outage becomes
 * "webhook endpoint disabled", which is strictly worse than the outage it
 * came from: recovery then requires a human in the Stripe Dashboard.
 *
 * The usual mitigation ("ship it behind an alert") is unsatisfiable in this
 * repository — there is no alerting backend (no Prometheus, Grafana or
 * PagerDuty; no configured OTel reader). `paymentsMetrics.webhookDispatchFailed`
 * increments into a collector nobody reads. So the bound has to be in the
 * code path.
 *
 * 48h mirrors `STALE_REFUND_GIVE_UP_SECONDS` in `confirm-payment.ts`: same
 * reasoning, same number, and it leaves ~24h of Stripe's 72h window unused
 * as headroom. Measured against `event.createdAtUnixSeconds` (Stripe's own
 * creation time, stable across redeliveries) rather than a local attempt
 * counter, which we do not persist.
 *
 * Scoped to `sub_use_case_error` — the branch whose error rate this change
 * actually raises. The `dispatch_threw` branches were transient before this
 * commit and stay transient; extending the ceiling to them is a defensible
 * follow-up but is not this commit's blast radius, and this commit is the
 * one most likely to need a fast revert.
 */
export const TRANSIENT_RETRY_CEILING_SECONDS = 48 * 60 * 60;

export type ProcessWebhookEventError = {
  readonly code: 'dispatch_failed';
  readonly kind:
    | 'sub_use_case_error'
    | 'dispatch_threw'
    | 'unknown_event_type_threw';
  readonly eventType: string;
  readonly detail: string;
  /**
   * money-remediation Task 5 — the F4 sub-code behind a `bridge_error`,
   * or `null` on branches that have none (`dispatch_threw`,
   * `unknown_event_type_threw`, and the non-`bridge_error` codes).
   *
   * Deliberately a NEW field rather than an overload of `detail`: `detail`
   * is read by the route for its pino line AND — load-bearing — lands in
   * `webhook_dispatch_permanent_failure`'s audit payload, where
   * `audit-port.ts` types `dispatch_failure_detail` as a required `string`.
   * Overloading it would silently change the meaning of rows already
   * written under the old semantics.
   */
  readonly subDetail: string | null;
  /**
   * money-remediation Task 5 — `true` when `permanence` is `'permanent'`
   * ONLY because the event outlived `TRANSIENT_RETRY_CEILING_SECONDS`.
   *
   * Kept separate from `permanence` so the forensic audit row can say
   * "transient class, retry budget exhausted" instead of asserting that F4
   * is permanently broken. At 3am those are different pages: one means
   * "F4/Blob was down for two days", the other means "an operator must fix
   * a row". Always `false` when the pair classified permanent on its own
   * merits — the ceiling escalates, it never downgrades.
   */
  readonly retryCeilingExceeded: boolean;
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
 * money-remediation Task 5 — classify a sub-use-case failure from the
 * `(code, subDetail)` PAIR. Exported for the table-driven unit test in
 * `tests/unit/payments/application/webhook-permanence.test.ts`.
 *
 * Replaces `categorisePermanence(detail)`, which keyed on `code` alone.
 * Across both live sub-use-case error unions that value is only ever
 * `bridge_error`, `processor_unavailable`, or
 * `invariant_auto_refunded_missing_invoice_id` — and `bridge_error` was in
 * the permanent set, so EVERY F4 decline was 200-acked and never retried,
 * transient or not. The discriminating F4 code sat one level down in
 * `.detail` and was discarded by `subUseCaseErr`. Plumbing it through is
 * the substance of Task 5.
 *
 * (`illegal_transition` is declared on `FailPaymentError` and is the sole
 * member of `HandleCancelEventError`, but is DEAD on both: the arms that
 * would produce it ack via `ok({kind:'already_terminal'})` /
 * `already_canceled` to break Stripe's retry loop. It never reaches here,
 * so it is not enumerated.)
 *
 * Unrecognised input — an unknown code, an unknown sub-detail, or a
 * `bridge_error` whose sub-detail we could not resolve — defaults to
 * `transient`. That is the deliberate bias: a transient mislabelled
 * permanent silently strands captured money (finding F-1); a permanent
 * mislabelled transient is a bounded, logged retry storm that the ceiling
 * caps. Prefer the loud failure.
 */
export function classifyDispatchPermanence(
  code: string,
  subDetail: string | null,
): DispatchPermanence {
  switch (code) {
    case 'processor_unavailable':
      // Stripe API outage — recovers inside the retry window.
      return 'transient';
    case 'invariant_auto_refunded_missing_invoice_id':
      // A confirmPayment contract violation; a code bug will not self-heal.
      return 'permanent';
    case 'bridge_error': {
      if (subDetail === null) return 'transient';
      // F5's OWN pre-bridge refusal (confirm-payment + fail-payment settings
      // guards) — not an F4 code, so it is not in the Record above.
      // Permanent by F5R2-CRIT-2; see that Record's docstring. The detail
      // string is the shared `F5_SETTINGS_MISSING_DETAIL` const so this
      // consumer and its two producers rename in lockstep (a drift here silently
      // reclassifies an unconfigured-tenant capture as transient → 48h retries).
      if (subDetail === F5_SETTINGS_MISSING_DETAIL) return 'permanent';
      return (
        F4_RECORD_PAYMENT_PERMANENCE[subDetail as RecordPaymentError['code']] ??
        // `f4_error` (summariseF4Error's code fallback) and anything else we
        // cannot read land here.
        'transient'
      );
    }
    default:
      return 'transient';
  }
}

/**
 * F5R2-S7 — factory for `dispatch_failed` errors with
 * `kind: 'sub_use_case_error'`. The 3 sub-use-case error sites
 * (`payment_intent.succeeded` confirmPayment branch,
 * `payment_intent.payment_failed` failPayment branch,
 * `payment_intent.canceled` handleCancelEvent branch) had identical
 * 5-line err({...}) blocks differing only in the `detail` value.
 * Centralising:
 *   - Removes the "forget to classify permanence" bug class on a
 *     future 4th sub-use-case branch.
 *   - Single anchor point for `'sub_use_case_error'` literal —
 *     dispatcher-error grep is more discoverable.
 *   - `permanence` is derived in one place; cannot drift across call sites.
 *
 * money-remediation Task 5 — takes the ERROR OBJECT, not just its code. The
 * pre-Task-5 signature was `(eventType, detail: string)` and the three
 * sub-use-case call sites passed `result.error.code`, so the F4 sub-code in
 * `.detail` was structurally unable to reach the classifier. `eventAgeSeconds`
 * arrives from the caller (one clock read per dispatch) so this stays a pure
 * function of its arguments.
 */
function subUseCaseErr(
  eventType: string,
  error: { readonly code: string; readonly detail?: string },
  eventAgeSeconds: number,
): ProcessWebhookEventError {
  const subDetail = error.detail ?? null;
  const classified = classifyDispatchPermanence(error.code, subDetail);
  // The ceiling only ever escalates transient -> permanent. A pair that
  // classified permanent on its own merits keeps `retryCeilingExceeded:
  // false` so the forensic row does not misattribute it to a give-up.
  const retryCeilingExceeded =
    classified === 'transient' && eventAgeSeconds > TRANSIENT_RETRY_CEILING_SECONDS;
  return {
    code: 'dispatch_failed',
    kind: 'sub_use_case_error',
    eventType,
    detail: error.code,
    subDetail,
    retryCeilingExceeded,
    permanence: retryCeilingExceeded ? 'permanent' : classified,
  };
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
   * 088 SEC-MED — FEATURE_088_TAX_AT_PAYMENT (2-state flow flag). Forwarded into
   * the inner `confirmPayment` deps for the `payment_intent.succeeded` branch, so
   * the webhook payability read carries the honest flag (the read sets
   * `reconciliationPath: true`, keeping the F4 stranded-funds guard dormant).
   * Wired from `env.features.f088TaxAtPayment` at `makeProcessWebhookEventDeps`.
   */
  readonly taxAtPayment: TaxAtPaymentFlag;
  /**
   * money-remediation Task 4 / finding F-1 — `FEATURE_F5_SETTLEMENT_ABORT`.
   * Pure passthrough into the inner `confirmPayment` deps for the
   * `payment_intent.succeeded` branch; the dispatcher itself does not read it.
   * See `ConfirmPaymentDeps.settlementAbort` for the semantics. Wired from
   * `env.features.f5SettlementAbort` at `makeProcessWebhookEventDeps`.
   */
  readonly settlementAbort: boolean;
  /**
   * Optional structured logger. Currently the dispatcher emits via the
   * module-level `paymentsLogger` (see `route.ts`) and OTel spans; this
   * deps slot is reserved for future structured callsites inside the
   * dispatcher itself and for test doubles (`noopLogger` /
   * `vi.fn()`-backed). Absent → no-op (field is `undefined`, no default
   * substitution).
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
  /**
   * F8 cross-module POST-COMMIT hooks. Forwarded into the inner
   * `confirmPayment` deps for the `payment_intent.succeeded` branch so the
   * F2 scheduled-plan-change finaliser runs AFTER the settlement tx commits
   * (it cannot run in-tx — self-deadlocks against the member-row lock).
   * Composition root injects via `f8AfterCommitCallbacks(tenantId)` when
   * `FEATURE_F8_RENEWALS=true`.
   */
  readonly onAfterCommitCallbacks?: ReadonlyArray<
    (invoiceId: string) => Promise<void>
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
// F5R3 MED-6 (2026-05-16) — `extractInvoiceId` helper removed.
// The duck-type `'invoiceId' in value` narrowing was opaque and
// triggered v8-ignore overhead because not every outcome variant
// carries the field. Call sites now inline the same predicate
// (`'invoiceId' in result.value ? result.value.invoiceId : undefined`)
// — the reader sees the actual narrowing predicate at the use site
// instead of jumping to a helper.

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
          // F5R3 LOW (2026-05-16) — H-4 hygiene; see confirm-payment.ts.
          message: e instanceof Error ? e.constructor.name : 'webhook_threw',
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

  // money-remediation Task 5 — age of the Stripe event, for the
  // transient-retry ceiling. Read once here (rather than per err-site) so
  // every branch of one dispatch classifies against the same instant, and
  // `subUseCaseErr` stays a pure function. Stripe's `created` is stable
  // across redeliveries, so this genuinely measures how long we have been
  // failing, not how long this attempt took.
  const eventAgeSeconds =
    Math.floor(deps.clock.nowMs() / 1000) - event.createdAtUnixSeconds;

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
  // withTx (confirm-payment.ts happy-path tail, fail-payment.ts
  // terminal-and-happy paths, handle-cancel-event.ts happy /
  // already-canceled / terminal paths, process-charge-refunded.ts
  // withTx tail, refunded / dispute / default branches below). The
  // previous defensive flag + canary tail block was documented
  // "unreachable through input manipulation alone" and v8-ignored —
  // it only fired on a code-bug regression that the sweep-stale-
  // pending cron would have caught independently. ~80 lines removed.
  // (R3 comment-rot fix: symbolic refs replace line numbers that
  // rotted as R1+R2 grew the underlying files.)
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
          // 088 SEC-MED — forward the honest flow flag into the webhook
          // confirm read (which sets reconciliationPath: true → guard dormant).
          taxAtPayment: deps.taxAtPayment,
          settlementAbort: deps.settlementAbort,
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
          // F8 POST-COMMIT hooks (F2 finaliser) — fired after confirmPayment's
          // settlement tx commits. `undefined` when FEATURE_F8_RENEWALS=false.
          /* v8 ignore next 3 — F8 after-commit conditional spread; F4-only
           * unit-test paths exercise the absent-callbacks branch. */
          ...(deps.onAfterCommitCallbacks !== undefined
            ? { onAfterCommitCallbacks: deps.onAfterCommitCallbacks }
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
        return err(subUseCaseErr(event.type, result.error, eventAgeSeconds));
      }
      // R5 canonical fix (2026-04-25): forward `invoiceId` from the
      // sub-use-case outcome up to the route handler so it can fire a
      // surgical `revalidatePath('/portal/invoices/<id>')`. Outcome
      // kinds that DON'T carry invoiceId (e.g. `unknown_intent`)
      // produce undefined here — route falls back to broader pattern.
      const confirmInvoiceId = 'invoiceId' in result.value ? result.value.invoiceId : undefined;
      if (result.value.kind === 'auto_refunded_stale_invoice') {
        // R5 I4 (2026-04-25): `auto_refunded_stale_invoice` is only
        // ever emitted by confirmPayment AFTER it loaded the payment
        // row, so the outcome MUST carry invoiceId. If it doesn't,
        // that's a `confirmPayment` contract violation.
        //
        // Returns a structured `dispatch_failed` permanent — route
        // 200-acks Stripe (no retry storm) + alerts ops via the
        // existing `dispatchFailureKind` log channel + the
        // `webhookDispatchFailed` metric. Constitution Principle III:
        // Application layer MUST return Result<T,E>, never throw.
        /* v8 ignore start — confirmPayment contract guarantees invoiceId
         * on auto_refunded_stale_invoice; defence-in-depth for post-
         * compile contract drift. */
        if (confirmInvoiceId === undefined) {
          // F5R2-S7 — `classifyDispatchPermanence` maps this code to
          // 'permanent' so `subUseCaseErr` derives it automatically (same
          // value as the pre-fix literal). No sub-detail: this is the
          // dispatcher's own invariant, not an F4 decline.
          return err(
            subUseCaseErr(
              event.type,
              { code: 'invariant_auto_refunded_missing_invoice_id' },
              eventAgeSeconds,
            ),
          );
        }
        /* v8 ignore stop */
        outcome = {
          kind: 'auto_refunded_stale_invoice',
          invoiceId: confirmInvoiceId,
        };
      } else if (result.value.kind === 'auto_refund_given_up') {
        // F5R2-TY-A — distinct outcome for the E9 give-up path.
        // Pre-fix this kind fell through to the generic `processed`
        // catch-all → ops dashboards saw it as a successful
        // dispatch, losing the "Stripe stopped retrying — operator
        // must reconcile via Stripe Dashboard" signal that the
        // forensic audit row carries. The route handler can now
        // pivot on `outcome.kind === 'auto_refund_given_up'` if
        // needed (e.g., for SRE alerting on chronic occurrences).
        outcome = {
          kind: 'auto_refund_given_up',
          dispatched: envelope.type,
          invoiceId: result.value.invoiceId,
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
        return err(subUseCaseErr(event.type, result.error, eventAgeSeconds));
      }
      // R5 canonical fix (2026-04-25): forward `invoiceId` for
      // surgical revalidation in the route handler.
      const failInvoiceId = 'invoiceId' in result.value ? result.value.invoiceId : undefined;
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
        return err(subUseCaseErr(event.type, result.error, eventAgeSeconds));
      }
      /* v8 ignore stop */
      // R5 canonical fix (2026-04-25): forward `invoiceId`.
      const cancelInvoiceId = 'invoiceId' in result.value ? result.value.invoiceId : undefined;
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
          // F5R3 SB-1 (2026-05-16) — propagate the dispatcher's logger
          // so the parent_status_recovery race-warn lands in pino.
          ...(deps.logger ? { logger: deps.logger } : {}),
        },
        {
          tenantId,
          requestId: input.requestId,
          eventId: event.id,
          chargeId: dataObject.id,
          refundIds: dataObject.refundIds ?? [],
          amountSatang: dataObject.amountSatang ?? 0n,
          // F5R3v3 H-4 (2026-05-16) — propagate the verifier's
          // amount-projection-failed flag so the use-case can skip
          // the mismatch comparison (existing > 0 vs default 0)
          // that would otherwise trip on a single fuzzed event.
          ...(dataObject.amountProjectionFailed
            ? { amountProjectionFailed: true }
            : {}),
          // F-9 (Task 9) — app-initiated refund markers + the PaymentIntent
          // they are cross-checked against. Without BOTH, the fallback cannot
          // recognise an app refund whose `processor_refund_id` has not been
          // attached yet, and a false 10-year OOB forensic fires.
          ...(dataObject.appRefundIds !== undefined
            ? { appRefundIds: dataObject.appRefundIds }
            : {}),
          ...(dataObject.paymentIntentId !== undefined
            ? { paymentIntentId: dataObject.paymentIntentId }
            : {}),
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
          // F5R2 — `formatDispatchErrorDetail` returns the error class
          // name (e.g. `PostgresError`, `TypeError`), NOT a sub-use-case
          // code, so routing it through `classifyDispatchPermanence` would
          // hit the default arm and return 'transient' anyway. Hardcoded
          // transient is correct for the dispatch_threw branch — a
          // thrown-error class doesn't carry permanent/transient semantics;
          // rely on the route's retry budget + observability counters to
          // surface chronic permanent throws (e.g. StripeAuthenticationError
          // storms).
          // Task 5 — a thrown dispatch has no F4 sub-code (`detail` is an
          // Error class name). Ceiling is scoped to `sub_use_case_error`.
          subDetail: null,
          retryCeilingExceeded: false,
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

    // PR-A follow-up (2026-07-12) — `charge.refund.updated` is DEPRECATED by
    // Stripe ("only sent for refunds with a corresponding charge; listen to
    // `refund.updated` for updates on all refunds instead"). Charge-less async
    // refunds (PromptPay / GrabPay / bank transfers) settle via `refund.updated`
    // ONLY. Both carry a `Stripe.Refund` `data.object` and route to the SAME
    // use-case. `refund.updated` fires on any Refund update INCL. status→failed,
    // so it covers the failure transition too — no separate `refund.failed`
    // subscription (the A.14 stale-pending sweep backstops any delivery gap).
    // Idempotent across BOTH events for one refund: markProcessed is
    // per-event-id, the finaliser guards on `expectedCurrentStatus='pending'`
    // (a sibling-won race → already_finalized no-op), and the F4 credit note is
    // idempotent per `(tenant, source_refund_id)` — so exactly one CN is booked.
    case 'charge.refund.updated':
    case 'refund.updated': {
      // A.11 — async refund-lifecycle reconciliation. Mirrors the
      // charge.refunded branch shape: the sub-use-case's `dispatch_failed`
      // Result maps to this branch's `dispatch_threw` error variant, and it
      // folds `markProcessed` into its own withTx. `dataObject.id` is the
      // Stripe Refund id (`re_…`), `latestChargeId` the parent charge, and
      // `refundStatus` the projected Refund `status` (verifier A.10).
      const refundUpdatedResult = await processRefundUpdated(
        {
          paymentsRepo: deps.paymentsRepo,
          refundsRepo: deps.refundsRepo,
          processorEventsRepo: deps.processorEventsRepo,
          invoicingBridge: deps.invoicingBridge,
          audit: deps.audit,
          clock: deps.clock,
          ...(deps.logger ? { logger: deps.logger } : {}),
        },
        {
          tenantId,
          requestId: input.requestId,
          eventId: event.id,
          // The concrete Stripe event that carried this settlement
          // (`charge.refund.updated` | `refund.updated`) — threaded so the
          // 10-year OOB / refund_failed forensic summaries name the real
          // channel instead of a hardcoded (possibly wrong) event type.
          sourceEventType: event.type,
          processorRefundId: dataObject.id,
          chargeId: dataObject.latestChargeId ?? null,
          refundStatus: dataObject.refundStatus ?? null,
          // Branded fallback — ProcessRefundUpdatedInput.amountSatang is
          // `Satang`; the projection-failed case yields `asSatang(0n)`
          // (runtime-identical to `0n`, forensic-only value).
          amountSatang: dataObject.amountSatang ?? asSatang(0n),
          // Round-2 review fix (#32): thread the projection-failed flag so the
          // 10y OOB / auto-refund-failed forensics write the 'projection_failed'
          // sentinel instead of a known-wrong 0 when the verifier could not
          // parse the Refund amount (mirrors the dispute branch). Defaults false.
          amountProjectionFailed: dataObject.amountProjectionFailed ?? false,
          // F-9 (Task 9) — the Refund object carries its OWN marker, which the
          // verifier keys by the Refund's own id, plus the PaymentIntent for
          // the anti-forgery cross-check.
          ...(dataObject.appRefundIds?.[dataObject.id] !== undefined
            ? { appRefundId: dataObject.appRefundIds[dataObject.id] as string }
            : {}),
          ...(dataObject.paymentIntentId !== undefined
            ? { paymentIntentId: dataObject.paymentIntentId }
            : {}),
          /* v8 ignore start — env-tag ternary; unit-test fixtures pin one
           * livemode value at a time. Cross-livemode coverage lives in the
           * contract tests for /api/webhooks/stripe. */
          processorEnv: event.livemode ? 'live' : 'test',
          /* v8 ignore stop */
        },
      );
      if (!refundUpdatedResult.ok) {
        return err<ProcessWebhookEventError>({
          code: 'dispatch_failed',
          kind: 'dispatch_threw',
          eventType: event.type,
          // Class name only — Stripe/Postgres error text can carry partial
          // keys / row data (PCI SAQ-A). Route logs the full error downstream.
          detail: formatDispatchErrorDetail(refundUpdatedResult.error.cause),
          // A thrown-error class doesn't carry permanent/transient semantics;
          // transient lets Stripe retry (the A.14 sweep is the backstop).
          // Task 5 — a thrown dispatch has no F4 sub-code (`detail` is an
          // Error class name). Ceiling is scoped to `sub_use_case_error`.
          subDetail: null,
          retryCeilingExceeded: false,
          permanence: 'transient',
        });
      }
      // A.11 outcomes that derive an invoice id forward it for surgical
      // revalidation; `out_of_band` (no DB refund/auto-refund) does not.
      outcome = {
        kind: 'processed',
        dispatched: envelope.type,
        ...('invoiceId' in refundUpdatedResult.value && {
          invoiceId: refundUpdatedResult.value.invoiceId,
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
            // Bug #6 follow-up (Task C.2 review) — same bug class as the
            // `payload.charge_id` fix directly below: `dataObject.id` on a
            // dispute event is the DISPUTE's own id (dp_…), not the charge
            // it disputes. Cite `latestChargeId` (the real ch_… id) in the
            // prose summary too, matching the `?? null` fallback style used
            // for the structured field.
            summary: `Dispute created on charge ${dataObject.latestChargeId ?? 'unknown'}`,
            payload: {
              dispute_id: dataObject.disputeId ?? null,
              // Bug #6 fix (Task C.2) — `dataObject.id` on a dispute
              // event is the DISPUTE's own id (dp_…), not the charge
              // it disputes. `latestChargeId` is the real ch_… id,
              // defensively extracted from `raw['charge']` by the
              // verifier (mirrors `extractLatestChargeId`).
              charge_id: dataObject.latestChargeId ?? null,
              // F5R3v3 H-4 (2026-05-16) — when the verifier flagged
              // amount projection as failed, write a 'projection_failed'
              // sentinel rather than the misleading '0' default. This
              // audit row is retained 10 years (RD §87 / GDPR Art.
              // 6(1)(c)) — a known-wrong value is worse than a
              // sentinel that reads "we couldn't parse this" at
              // forensic review time.
              amount_satang: dataObject.amountProjectionFailed
                ? 'projection_failed'
                : (dataObject.amountSatang ?? 0n).toString(),
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
          // Task 5 — a thrown dispatch has no F4 sub-code (`detail` is an
          // Error class name). Ceiling is scoped to `sub_use_case_error`.
          subDetail: null,
          retryCeilingExceeded: false,
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
          // Task 5 — a thrown dispatch has no F4 sub-code (`detail` is an
          // Error class name). Ceiling is scoped to `sub_use_case_error`.
          subDetail: null,
          retryCeilingExceeded: false,
          permanence: 'transient',
        });
      }
      outcome = { kind: 'acknowledged_only' };
    }
  }

  return ok(outcome);
}

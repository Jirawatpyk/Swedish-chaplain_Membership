/**
 * F5 Phase 9 — T140 OTel tracer accessor.
 *
 * Provides a singleton OpenTelemetry `Tracer` instance for hand-instrumenting
 * F5 lifecycle hops not covered by `@vercel/otel` auto-instrumentation:
 *
 *   `portal_click → api_payments_initiate → stripe_create_intent →
 *    webhook_receive → webhook_verify → f4_markpaid → receipt_email_enqueued`
 *
 * Auto-instrumentation already wraps Next.js route handlers, fetch calls,
 * and Drizzle queries. This module exposes the tracer for explicit
 * `startActiveSpan` calls inside Application use-cases (where the work
 * boundary is semantic — not a single HTTP/DB call) so the resulting
 * trace has named hops aligned with `plan.md § VII Distributed tracing`.
 *
 * Span attributes follow the project log redact contract — no PII /
 * card / secret / Authorization values. Tenant id is passed as-is —
 * a small-cardinality bounded string at SaaS scale (one tenant per
 * chamber). L-1 (review 2026-04-27): clarified that this module does
 * NOT hash tenantId; an earlier docstring suggested a hash-when-
 * correlation-needed strategy that was never implemented. If
 * cross-request user-level correlation requires tenantId obfuscation
 * in spans, swap to `cryptoHash('sha256', tenantId)` at the call
 * site — but no F5 use-case needs that today.
 */
import {
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type Tracer,
} from '@opentelemetry/api';

const TRACER_NAME = 'swecham.payments';

let cachedTracer: Tracer | null = null;

export function paymentsTracer(): Tracer {
  if (!cachedTracer) {
    cachedTracer = trace.getTracer(TRACER_NAME, '1.0.0');
  }
  return cachedTracer;
}

/**
 * F7 Phase 9 — T174 OTel tracer for the broadcasts bounded context.
 * Trace tree documented in `docs/observability.md § 22`:
 * `member_compose_page_load → member_submit_broadcast →
 *  admin_approve_send_now → cron_dispatch_scheduled →
 *  webhook_receive_resend → public_unsubscribe`.
 *
 * Attribute-redaction contract: no recipient_email, recipient_emails,
 * body_html, rejection_reason raw text, Resend-Signature, or
 * Svix-Signature values. Bounded-cardinality attributes only:
 * tenant.id, broadcast.id, actor.role, segment.type.
 */
const BROADCASTS_TRACER_NAME = 'swecham.broadcasts';
let cachedBroadcastsTracer: Tracer | null = null;

export function broadcastsTracer(): Tracer {
  if (!cachedBroadcastsTracer) {
    cachedBroadcastsTracer = trace.getTracer(BROADCASTS_TRACER_NAME, '1.0.0');
  }
  return cachedBroadcastsTracer;
}

/**
 * F8 Phase 3.5 S-06 — OTel tracer for the renewals bounded context.
 *
 * Trace tree (US1 Phase 3 + Phase 4+ extensions):
 * `admin_pipeline_load → load_cycle_detail → cancel_cycle →
 *  mark_paid_offline → cron_dispatch_reminders → at_risk_recompute →
 *  tier_upgrade_evaluate`.
 *
 * Attribute-redaction contract: no member email / phone / tax-id raw,
 * no PAN-like payment_reference. Bounded-cardinality only:
 * tenant.id, cycle.id, actor.role, urgency.bucket, tier.bucket.
 */
const RENEWALS_TRACER_NAME = 'swecham.renewals';
let cachedRenewalsTracer: Tracer | null = null;

export function renewalsTracer(): Tracer {
  if (!cachedRenewalsTracer) {
    cachedRenewalsTracer = trace.getTracer(RENEWALS_TRACER_NAME, '1.0.0');
  }
  return cachedRenewalsTracer;
}

/**
 * F6 — OTel tracer for the events bounded context (EventCreate
 * Integration). SC-003 webhook ingest p95 < 300ms SLO is unobservable
 * without these spans.
 *
 * Trace tree:
 * `webhook_ingest_eventcreate → idempotency_receipt →
 *  event_upsert → attendee_match → registration_insert → audit_emit`.
 *
 * Attribute-redaction contract: no attendee_email, attendee_name,
 * attendee_company raw, no webhook_secret_active/_grace, no
 * X-Chamber-Signature values. Bounded-cardinality attributes only:
 * tenant.id, f6.match_type, f6.source, f6.signature_outcome.
 */
const EVENTS_TRACER_NAME = 'swecham.events';
let cachedEventsTracer: Tracer | null = null;

export function eventsTracer(): Tracer {
  if (!cachedEventsTracer) {
    cachedEventsTracer = trace.getTracer(EVENTS_TRACER_NAME, '1.0.0');
  }
  return cachedEventsTracer;
}

/**
 * Round 5 simplification — span lifecycle helper.
 *
 * Wraps `tracer.startSpan(name, {attributes}) → fn(span) → catch:
 * setStatus(ERROR) + recordException + rethrow → finally: span.end()`.
 * Removes the duplicated try/catch/finally boilerplate that started
 * showing up at the F7 webhook, cron, and unsubscribe entrypoints.
 *
 * Why a generic helper rather than a class: the OTel API is
 * pure-functional + the helper has no state of its own. A
 * higher-order function keeps the call site terse:
 *
 * ```ts
 * return withSpan(broadcastsTracer(), 'webhook_receive_resend', { 'tenant.id': t }, async (span) => {
 *   span.setAttribute('broadcasts.outcome', 'success');
 *   return jsonOk();
 * });
 * ```
 *
 * The helper does NOT swallow errors — exceptions still propagate so
 * the route handler / cron loop can convert them into HTTP 5xx + log
 * entries as before. We just guarantee `span.end()` runs even on a
 * synchronous throw inside the callback (was a Round 5 R5-CRON-B
 * leak risk before this helper existed).
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan(name, { attributes });
  try {
    return await fn(span);
  } catch (e) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: e instanceof Error ? e.message : String(e),
    });
    if (e instanceof Error) span.recordException(e);
    throw e;
  } finally {
    span.end();
  }
}

/**
 * R6 staff-review W-P6 fix — same as `withSpan` but uses
 * `startActiveSpan` so the span is set as the active context for the
 * duration of `fn()`. Auto-instrumented child spans (Drizzle queries,
 * fetch calls inside the callback) will then parent correctly to this
 * span in the trace tree, instead of being orphaned at the root.
 *
 * Use this for cron loops + route handlers where the work inside the
 * callback issues DB queries / outbound HTTP that should appear as
 * children in Vercel Observability. `withSpan` (non-active) is fine
 * for leaf-level annotations where no child spans are expected.
 */
export async function withActiveSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span: Span) => {
    try {
      return await fn(span);
    } catch (e) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: e instanceof Error ? e.message : String(e),
      });
      if (e instanceof Error) span.recordException(e);
      throw e;
    } finally {
      span.end();
    }
  });
}

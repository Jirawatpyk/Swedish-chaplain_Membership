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
import { trace, type Tracer } from '@opentelemetry/api';

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

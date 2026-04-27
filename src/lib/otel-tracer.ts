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
 * card / secret / Authorization values. Tenant id is hashed via
 * `cryptoHash('sha256', tenantId)` only when broader correlation is
 * needed; otherwise raw small-cardinality fields (event_type, method,
 * outcome) are safe to set verbatim.
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

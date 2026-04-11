import { registerOTel } from '@vercel/otel';

/**
 * OpenTelemetry instrumentation entry point (T019, plan.md § Performance
 * & Observability, docs/observability.md).
 *
 * Next.js loads this file automatically before any request is handled.
 * `@vercel/otel` wires up the SDK with sensible defaults for the Vercel
 * runtime — distributed traces are exported via OTLP and rendered in
 * Vercel's "Traces" panel without extra config.
 *
 * Per-span attributes (user id hash, auth event, outcome) are added by
 * the use cases themselves via `trace.getActiveSpan()?.setAttribute(...)`
 * — see src/modules/auth/application/sign-in.ts (Phase 3).
 */
export function register() {
  registerOTel({
    serviceName: 'swecham-membership',
    // Additional configuration (sampler, exporters) can be added here.
    // Defaults: AlwaysOnSampler + Vercel-managed OTLP exporter.
  });
}

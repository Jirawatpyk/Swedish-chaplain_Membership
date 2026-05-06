import { registerOTel } from '@vercel/otel';
import { assertVercelDeploymentForTrustedXff } from '@/lib/client-ip';

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

  // K14-1 (R13-W1): wire the K13-7 boot-time XFF trust assertion.
  // Triple-confirmed at R13 by reliability-guardian + security-threat-
  // modeler + feature-dev:code-reviewer that the function existed but
  // was never called — SEC-R12-1 mitigation provided zero protection
  // until this line landed. Pure read of `process.env` + optional
  // `console.warn`; cannot throw or block boot.
  assertVercelDeploymentForTrustedXff();
}

/**
 * F119 T122 — the OTel span around an approval-round hand-off
 * (`broadcasts.version.send`, `broadcasts.schedule.confirm`;
 * contracts/dashboard-and-notifications.md § 4.4).
 *
 * Attributes are limited to `tenant.slug`, `broadcast.id`, `broadcast.stage`
 * and `broadcast.round` — never a value (no subject, body, note or address).
 * A stated refusal is not an error; only a `server_error` result (or a throw)
 * marks the span ERROR.
 */
import { SpanStatusCode } from '@opentelemetry/api';
import { broadcastsTracer } from '@/lib/otel-tracer';
import type { Result } from '@/lib/result';

export async function inApprovalSpan<T, E extends { readonly kind: string }>(
  name: string,
  ids: { readonly tenantSlug: string; readonly broadcastId: string },
  run: () => Promise<Result<T, E>>,
  describe: (value: T) => { readonly stage: string; readonly round: number | null },
): Promise<Result<T, E>> {
  return broadcastsTracer().startActiveSpan(
    name,
    { attributes: { 'tenant.slug': ids.tenantSlug, 'broadcast.id': ids.broadcastId } },
    async (span) => {
      try {
        const result = await run();
        if (result.ok) {
          const { stage, round } = describe(result.value);
          span.setAttribute('broadcast.stage', stage);
          if (round !== null) span.setAttribute('broadcast.round', round);
        } else if (result.error.kind === 'server_error') {
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'server_error' });
        }
        return result;
      } catch (e) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'threw' });
        throw e;
      } finally {
        span.end();
      }
    },
  );
}

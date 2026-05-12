/**
 * F6 webhook route composition adapter.
 *
 * Wires the route handler `src/app/api/webhooks/eventcreate/v1/[tenantSlug]
 * /route.ts` (T052) to the cross-cutting infrastructure:
 *   - `ratelimitCheck` — Upstash sliding-window 60 req/min per tenant
 *     (FR-005). Reuses the F1 auth rate-limiter adapter.
 *   - `loadTenantWebhookConfig` — Drizzle SELECT of the active + grace
 *     secrets for the resolved tenant. Runs inside `runInTenant(ctx, fn)`
 *     so RLS+FORCE on `tenant_webhook_configs` accepts the read.
 *   - re-export of `makeIngestWebhookAttendeeDeps` for the route's
 *     dispatch path.
 *
 * Mirrors F5's `src/lib/stripe-webhook-deps.ts` route-composition
 * precedent.
 */
import { and, eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { rateLimiter as authRateLimiter } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
import { tenantWebhookConfigs } from '@/modules/events/infrastructure/schema';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import type { TenantWebhookConfigAggregate } from '@/modules/events';

export { makeIngestWebhookAttendeeDeps } from '@/modules/events';

/**
 * F6 webhook rate limit per FR-005: 60 req/min per tenant. Uses the
 * Upstash sliding-window key `f6-webhook:<tenant_slug>`.
 */
const F6_WEBHOOK_MAX_PER_MIN = 60;
const F6_WEBHOOK_WINDOW_SECONDS = 60;

export interface RatelimitResult {
  readonly success: boolean;
  /** Unix-ms timestamp when the bucket resets. */
  readonly reset: number;
}

export async function ratelimitCheck(tenantSlug: string): Promise<RatelimitResult> {
  const result = await authRateLimiter.check(
    `f6-webhook:${tenantSlug}`,
    F6_WEBHOOK_MAX_PER_MIN,
    F6_WEBHOOK_WINDOW_SECONDS,
  );
  return { success: result.success, reset: result.reset };
}

/**
 * Load the active webhook config for a tenant. Returns `null` if the
 * tenant has not yet configured EventCreate ingest (no row in
 * `tenant_webhook_configs`). The webhook receiver returns HTTP 404 in
 * that case.
 *
 * Runs in a short-lived tx so the RLS+FORCE policy on
 * `tenant_webhook_configs` accepts the read.
 */
export async function loadTenantWebhookConfig(
  ctx: TenantContext,
): Promise<TenantWebhookConfigAggregate | null> {
  const rows = await runInTenant(ctx, async (tx) =>
    tx
      .select()
      .from(tenantWebhookConfigs)
      .where(
        and(
          eq(tenantWebhookConfigs.tenantId, ctx.slug),
          eq(tenantWebhookConfigs.source, 'eventcreate'),
        ),
      )
      .limit(1),
  );

  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    tenantId: ctx.slug as unknown as TenantWebhookConfigAggregate['tenantId'],
    source: row.source as 'eventcreate',
    activeSecret: row.webhookSecretActive as unknown as TenantWebhookConfigAggregate['activeSecret'],
    graceSecret: row.webhookSecretGrace as unknown as TenantWebhookConfigAggregate['graceSecret'],
    graceRotatedAt: row.graceRotatedAt ? new Date(row.graceRotatedAt) : null,
    enabled: row.enabled,
    createdAt: new Date(row.createdAt),
    lastReceivedAt: row.lastReceivedAt ? new Date(row.lastReceivedAt) : null,
    lastRotatedAt: row.lastRotatedAt ? new Date(row.lastRotatedAt) : null,
  };
}

/**
 * Resolve a URL-path tenant slug to a TenantContext. Returns `null` if
 * the slug shape is invalid (the slug pattern is `[a-z0-9-]{1,63}`;
 * malformed slugs trigger HTTP 404 from the route handler — no tenant
 * enumeration oracle).
 */
export function resolveTenantFromSlug(slug: string): TenantContext | null {
  try {
    return asTenantContext(slug);
  } catch {
    return null;
  }
}

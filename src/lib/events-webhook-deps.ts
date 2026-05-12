/**
 * F6 webhook route composition adapter.
 *
 * **Issue I-FULL-1 (full-scope review 2026-05-12) — Principle III note**:
 * This file imports Drizzle's `tenantWebhookConfigs` schema table directly
 * from `@/modules/events/infrastructure/schema` to implement
 * `loadTenantWebhookConfig`. ESLint's barrel-enforcement rule blocks
 * cross-module deep imports, but `src/lib/**` is explicitly listed in
 * the rule's `ignores` array (`eslint.config.mjs:206-223`) because lib/
 * is the project's "composition adapter layer" that legitimately
 * bridges module internals into Next.js route handlers. F5 follows
 * the SAME pattern with `src/lib/stripe-webhook-deps.ts` importing
 * F5's schema directly. Constitution Principle III (Clean Architecture)
 * is preserved because Application use-cases never reach this file —
 * the route handler is the only caller, and it's already in
 * Presentation layer where Infrastructure types are allowed.
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
 *
 * Issue I7 (review 2026-05-12) — inherited Upstash fail-open behavior:
 * the underlying `authRateLimiter` (src/modules/auth/infrastructure/
 * rate-limit/upstash-rate-limiter.ts) silently falls back to a
 * PROCESS-LOCAL in-memory bucket when Upstash is unreachable. This is
 * a deliberate Constitution Principle VIII trade-off (degraded service
 * vs total outage) but it has implications for F6:
 *
 *   - During an Upstash incident, the per-process in-memory bucket
 *     protects ONE Vercel Fluid Compute function instance only.
 *     Concurrent instances under load → effective rate limit is
 *     60/min × N instances, not 60/min/tenant.
 *   - Attackers could exploit a Upstash outage window to flood the
 *     F6 webhook with valid-signed Zapier replays before the cap kicks
 *     in across instances.
 *
 * Mitigations in place:
 *   - HMAC + per-tenant secret → attacker needs the secret to forge
 *     valid deliveries (the fail-open only weakens DoS, not auth).
 *   - Idempotency receipts in F6-owned table → duplicate-rejection
 *     still works during the outage window.
 *   - `auth_redis_fallback_total` metric — operators should alert on
 *     this metric filtered by `key prefix = f6-webhook:` to detect
 *     F6-surface fail-open events. See docs/observability.md § 14
 *     when wired (Phase 10 T131 will add this alert).
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

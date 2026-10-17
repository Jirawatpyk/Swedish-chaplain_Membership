/**
 * GET /api/health — public liveness probe (spec 123 US1, DW-3).
 *
 * Read by the post-deploy smoke workflow (`.github/workflows/post-deploy-smoke.yml`,
 * runbook `docs/runbooks/post-deploy-smoke.md`). Unauthenticated by design.
 *
 *   200 {"status":"ok"}        `select 1` answered within 3 s
 *   503 {"status":"degraded"}  it threw, or did not answer within 3 s
 *
 * Security (a new public surface):
 *   - The body is one of two fixed strings: no version, environment, tenant,
 *     hostname or error text ever reaches it.
 *   - The probe PROMISE is cached in this module for 10 s, ok and degraded
 *     alike, so concurrent requests share one query and a flood costs one
 *     `select 1` per instance per 10 s.
 *
 * The 3 s limit is a Node timer, not `statement_timeout`: the Neon pooler drops
 * that parameter, so a wedged connection would otherwise hang the request.
 *
 * Calls `db` directly without a use case — a liveness probe has no domain
 * logic (spec 123 plan § Complexity Tracking, the cron-route precedent).
 */
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';

export const dynamic = 'force-dynamic';

const PROBE_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 10_000;

type HealthStatus = 'ok' | 'degraded';

class HealthProbeTimeoutError extends Error {}

let cached: { readonly startedAt: number; readonly result: Promise<HealthStatus> } | null = null;

async function probe(): Promise<HealthStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HealthProbeTimeoutError()), PROBE_TIMEOUT_MS);
  });
  try {
    // `.then` so a synchronous throw from `execute` lands in the catch too.
    await Promise.race([Promise.resolve().then(() => db.execute(sql`select 1`)), timeout]);
    return 'ok';
  } catch (e) {
    logger.warn({ err: errKind(e), route: 'api.health' }, 'health.degraded');
    return 'degraded';
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(): Promise<Response> {
  const now = Date.now();
  // Assigned synchronously, before any await, so concurrent callers share it.
  if (cached === null || now - cached.startedAt > CACHE_TTL_MS) {
    cached = { startedAt: now, result: probe() };
  }
  const status = await cached.result;
  return Response.json(
    { status },
    { status: status === 'ok' ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}

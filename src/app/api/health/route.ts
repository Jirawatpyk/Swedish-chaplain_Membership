/**
 * GET /api/health — public liveness probe (spec 123 US1, DW-3).
 *
 * Read by the post-deploy smoke workflow (`.github/workflows/post-deploy-smoke.yml`,
 * runbook `docs/runbooks/post-deploy-smoke.md`). Unauthenticated by design.
 *
 *   200 {"status":"ok"}        `select 1` answered within 3 s
 *   503 {"status":"degraded"}  it threw, did not answer within 3 s, or an
 *                              earlier `select 1` is still unsettled
 *
 * Security and load (a new public surface):
 *   - The body is one of two fixed strings: no version, environment, tenant,
 *     hostname or error text ever reaches it.
 *   - The probe PROMISE is cached in this module for 10 s from when it SETTLES,
 *     ok and degraded alike, so concurrent requests share one query and a flood
 *     costs at most one `select 1` per instance per window.
 *   - A CEILING, not just a rate: while the raw query is still unsettled (it
 *     holds a pooled connection), no second query starts — the probe answers
 *     degraded at once with probe `still-pending`. A hung database plus a
 *     steady caller therefore pins one connection, never the whole pool.
 *
 * The 3 s limit is a Node timer, not `statement_timeout`: the Neon pooler drops
 * that parameter, so a wedged connection would otherwise hang the request.
 *
 * Log: `health.degraded` with `probe` (timeout | query-error | still-pending —
 * constant strings, safe to search on) and `err` (the error class only, never
 * `e.message`; class names can be minified, so search by `probe`). The field is
 * NOT named `reason`: `src/lib/logger.ts` redacts every top-level `reason` (the
 * F5 gateway defence), which would turn it into "[REDACTED]".
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

/** The current probe; `settledAt` is null until its result is known. */
let cached: { settledAt: number | null; readonly result: Promise<HealthStatus> } | null = null;

/** The raw `select 1` while it is unsettled — it holds a pooled connection. */
let inFlight: Promise<unknown> | null = null;

async function probe(): Promise<HealthStatus> {
  if (inFlight !== null) {
    logger.warn({ probe: 'still-pending', route: 'api.health' }, 'health.degraded');
    return 'degraded';
  }

  // `.then` so a synchronous throw from `execute` lands in the catch too.
  const query = Promise.resolve().then(() => db.execute(sql`select 1`));
  inFlight = query;
  query
    .finally(() => {
      if (inFlight === query) inFlight = null;
    })
    .catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HealthProbeTimeoutError()), PROBE_TIMEOUT_MS);
  });
  try {
    await Promise.race([query, timeout]);
    return 'ok';
  } catch (e) {
    const outcome = e instanceof HealthProbeTimeoutError ? 'timeout' : 'query-error';
    logger.warn({ err: errKind(e), probe: outcome, route: 'api.health' }, 'health.degraded');
    return 'degraded';
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(): Promise<Response> {
  const now = Date.now();
  let entry = cached;
  // Expired only once settled AND 10 s old: an unsettled probe is always shared.
  // Assigned synchronously, before any await, so concurrent callers share it.
  if (entry === null || (entry.settledAt !== null && now - entry.settledAt >= CACHE_TTL_MS)) {
    const next: { settledAt: number | null; readonly result: Promise<HealthStatus> } = {
      settledAt: null,
      result: probe(),
    };
    void next.result.then(() => {
      next.settledAt = Date.now();
    });
    cached = next;
    entry = next;
  }
  const status = await entry.result;
  return Response.json(
    { status },
    { status: status === 'ok' ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}

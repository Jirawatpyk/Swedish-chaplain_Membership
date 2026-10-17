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
 *   - Abandon age: a query still unsettled after 60 s is dropped (NOT
 *     cancelled — its connection stays held until the driver gives up) and ONE
 *     fresh probe may run, so health can turn ok again once the database
 *     recovers. A second abandonment waits until the abandoned query settles,
 *     so the worst case is TWO hung connections per instance. `still-pending`
 *     is therefore sticky for up to 60 s per instance.
 *
 * The 3 s limit is a Node timer, not `statement_timeout`: the Neon pooler drops
 * that parameter, so a wedged connection would otherwise hang the request.
 *
 * Log, only when the outcome CHANGES per instance (no repeat every 10 s):
 * `health.degraded` (warn) with `probe` (timeout | query-error | still-pending —
 * constant strings, safe to search on) and `err` (the error class only, never
 * `e.message`; class names can be minified, so search by `probe`). The field is
 * NOT named `reason`: `src/lib/logger.ts` redacts every top-level `reason` (the
 * F5 gateway defence), which would turn it into "[REDACTED]".
 * `health.recovered` (info) once, when a degraded instance answers ok again.
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
const ABANDON_AFTER_MS = 60_000;

type HealthStatus = 'ok' | 'degraded';
type DegradedProbe = 'timeout' | 'query-error' | 'still-pending';

class HealthProbeTimeoutError extends Error {}

/** The current probe; `settledAt` is null until its result is known. */
let cached: { settledAt: number | null; readonly result: Promise<HealthStatus> } | null = null;

/** The raw `select 1` while it is unsettled — it holds a pooled connection. */
let inFlight: { readonly query: Promise<unknown>; readonly startedAt: number } | null = null;

/** A query dropped after ABANDON_AFTER_MS, kept until it settles (at most one). */
let abandoned: Promise<unknown> | null = null;

/** The last degraded outcome logged on this instance; null while ok. */
let lastDegraded: DegradedProbe | null = null;

function reportDegraded(kind: DegradedProbe, err?: string): void {
  if (kind === lastDegraded) return;
  lastDegraded = kind;
  const fields =
    err === undefined ? { probe: kind, route: 'api.health' } : { err, probe: kind, route: 'api.health' };
  logger.warn(fields, 'health.degraded');
}

function reportOk(): void {
  if (lastDegraded === null) return;
  lastDegraded = null;
  logger.info({ route: 'api.health' }, 'health.recovered');
}

async function probe(): Promise<HealthStatus> {
  if (inFlight !== null) {
    const stuck = Date.now() - inFlight.startedAt >= ABANDON_AFTER_MS;
    if (!stuck || abandoned !== null) {
      reportDegraded('still-pending');
      return 'degraded';
    }
    abandoned = inFlight.query;
    inFlight = null;
  }

  // `.then` so a synchronous throw from `execute` lands in the catch too.
  const query = Promise.resolve().then(() => db.execute(sql`select 1`));
  inFlight = { query, startedAt: Date.now() };
  query
    .finally(() => {
      if (inFlight?.query === query) inFlight = null;
      if (abandoned === query) abandoned = null;
    })
    .catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HealthProbeTimeoutError()), PROBE_TIMEOUT_MS);
  });
  try {
    await Promise.race([query, timeout]);
  } catch (e) {
    reportDegraded(e instanceof HealthProbeTimeoutError ? 'timeout' : 'query-error', errKind(e));
    return 'degraded';
  } finally {
    clearTimeout(timer);
  }
  reportOk();
  return 'ok';
}

export async function GET(): Promise<Response> {
  const now = Date.now();
  let entry = cached;
  // Expired only once settled AND 10 s old: an unsettled probe is always shared.
  // Assigned synchronously, before any await, so concurrent callers share it.
  if (entry === null || (entry.settledAt !== null && now - entry.settledAt >= CACHE_TTL_MS)) {
    const next: { settledAt: number | null; readonly result: Promise<HealthStatus> } = {
      settledAt: null,
      // Total: if probe() itself throws (a failing logger), answer degraded
      // rather than caching a rejected promise forever.
      result: probe().catch((): HealthStatus => 'degraded'),
    };
    void next.result.finally(() => {
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

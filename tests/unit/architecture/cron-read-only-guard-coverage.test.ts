/**
 * #408 — every scheduled cron honours READ_ONLY_MODE.
 *
 * The class: `READ_ONLY_MODE=true` is the emergency write freeze, and
 * `src/proxy.ts` enforces it only for POST/PUT/PATCH/DELETE. Vercel Cron
 * invokes every `vercel.json` path with GET (the routes alias `GET = POST`),
 * so the proxy never froze a cron: dispatch kept sending E-Blasts, sweeps kept
 * deleting rows and Resend audiences, all while the operator believed writes
 * were stopped. Twelve scheduled routes (the 10 F8 renewals coordinators and
 * sweeps, `auth/prune-expired-invitations`, `broadcasts/retention-sweep`) plus
 * the unscheduled worker `renewals/auto-draft/[tenantId]` guarded themselves
 * by hand, each with its own inline check; the rest did not.
 *
 * Rules, for every `crons[].path` in `vercel.json`:
 *   1. the path resolves to `src/app<path>/route.ts`;
 *   2. that file CALLS the shared guard (`cronReadOnlyGuard(`) and RETURNS its
 *      answer (`const x = cronReadOnlyGuard(…)` then `if (x) return x`), and
 *      the call sits AFTER the Bearer check, so an unauthenticated caller still gets
 *      401 rather than learning the freeze state — OR the path is in EXEMPT
 *      with a written reason (a route that writes nothing and calls nothing
 *      external);
 *   3. every EXEMPT key is still scheduled (a stale exemption is a lie about
 *      a route that no longer exists).
 * An inline `env.flags.readOnlyMode` check does NOT satisfy rule 2: one
 * helper means one response shape and one log line to alert on.
 *
 * Positive controls, because a scan that cannot tell "nothing to find" from
 * "not looking" is not a check: the parse must yield at least MIN_CRON_PATHS
 * paths, and fixtures prove the matchers reject a comment-only mention (whole
 * line or trailing), the inline flag check, a call whose answer is not
 * returned, and a guard placed before the Bearer check.
 *
 * Comments are stripped before matching (this docblock names the symbols it
 * requires) and `\r` is stripped on read — the working tree is CRLF, and a
 * gate anchored on `\n` is inert on every Windows checkout while CI stays
 * green (the `check:f8-error-id` precedent).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');

/**
 * Floor for the parse, not a target: 39 paths are scheduled today. It sits
 * below that so removing a job does not fail the gate, but a parse that
 * silently collapses to nothing does.
 */
const MIN_CRON_PATHS = 30;

/**
 * Scheduled routes that may run during a freeze. Each one only READS and
 * emits metrics — a freeze is an incident window, and these gauges are how
 * the operator watches it; silencing them would blind the alerting exactly
 * when it is needed. A route that writes ANYTHING (a cache row included) or
 * calls an external service does not belong here.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  '/api/internal/metrics/stale-pending-count':
    'Read-only gauge: one cross-tenant SELECT … GROUP BY on payments (the tx holds only SET LOCAL statement_timeout); emits payments.stale_pending_count, writes nothing, calls nothing external.',
  '/api/internal/metrics/unprocessed-events-count':
    'Read-only gauge: one cross-tenant SELECT … GROUP BY on processor_events; emits payments.unprocessed_events_count, writes nothing, calls nothing external.',
  '/api/internal/metrics/broadcasts-gauges':
    'Read-only gauges: SELECT-only transactions over broadcasts, marketing_unsubscribes, tenant_member_settings and member_change_requests; emits/forgets gauges only (the de-latch set is in-process memory), writes no table, calls nothing external.',
  '/api/internal/observability/recompute-match-rate':
    'Read-only gauge: a per-tenant COUNT over audit_log under runInTenant (SET LOCAL only); emits eventcreate_match_rate_gauge, writes nothing, calls nothing external.',
  '/api/internal/cron/plan-change-divergence':
    'Read-only detector: checkPlanChangeDivergence only SELECTs (renewal_cycles ↔ linked §86/4); emits a counter and answers non-2xx on divergence, writes nothing, calls nothing external.',
};

const GUARD_CALL = /\bcronReadOnlyGuard\s*\(/;
/**
 * The guard only works if its answer is handed back: `const x = cronReadOnlyGuard(…)`
 * followed IMMEDIATELY by `if (x) return x;` or by an `if (x) { … return x; }`
 * block (the F8 routes meter the skip first). A bare `cronReadOnlyGuard(ROUTE);`
 * logs the skip and then runs the job anyway.
 */
const RETURNED_GUARD =
  /\bconst\s+(\w+)\s*=\s*cronReadOnlyGuard\s*\([^)]*\)\s*;?\s*if\s*\(\s*\1\s*\)\s*(?:return\s+\1\b|\{[^{}]{0,400}?\breturn\s+\1\b)/;
const UNRETURNED =
  'calls cronReadOnlyGuard( without returning its result (`const x = cronReadOnlyGuard(…); if (x) return x`)';
const AUTH_CALL = /\b(?:verifyCronBearer|gateCronBearerOrRespond|gateF6Cron)\s*\(/;

/**
 * Strip block comments, then line comments — whole-line AND trailing. A `//`
 * counts as a comment only at line start or after whitespace / `;` `,` `(` `)`
 * `{` `}`, so the `//` in a URL literal (`'https://…'`, preceded by `:`)
 * survives. A string holding ` // ` would be cut short; that can only remove
 * code, so it fails the gate loudly — it can never make a route pass.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;,(){}])\/\/[^\n]*/gm, '$1');
}

/** Rule 2: `null` when the file returns the guard's answer after its Bearer check, else why not. */
function guardViolation(code: string): string | null {
  if (!GUARD_CALL.test(code)) return 'does not call cronReadOnlyGuard(';
  const guard = RETURNED_GUARD.exec(code);
  if (!guard) return UNRETURNED;
  const auth = AUTH_CALL.exec(code);
  if (!auth) return 'has no recognised Bearer check (verifyCronBearer / gateCronBearerOrRespond / gateF6Cron)';
  if (guard.index < auth.index) return 'calls cronReadOnlyGuard( BEFORE the Bearer check';
  return null;
}

function readCronPaths(): readonly string[] {
  const raw = readFileSync(join(ROOT, 'vercel.json'), 'utf8').replace(/\r/g, '');
  const parsed = JSON.parse(raw) as { crons?: ReadonlyArray<{ path?: unknown }> };
  return (parsed.crons ?? []).map((c) => c.path).filter((p): p is string => typeof p === 'string');
}

function routeFileFor(path: string): string {
  return join(ROOT, 'src/app', `${path.replace(/^\//, '')}`, 'route.ts');
}

const cronPaths = readCronPaths();

describe('#408 — every scheduled cron honours READ_ONLY_MODE (architecture gate)', () => {
  it('parses the scheduled cron paths at all (positive control for the parse)', () => {
    expect(cronPaths.length).toBeGreaterThanOrEqual(MIN_CRON_PATHS);
  });

  it('rule 1 — every scheduled path resolves to a route file', () => {
    const unresolved = cronPaths.filter((p) => !existsSync(routeFileFor(p)));
    expect(unresolved).toEqual([]);
  });

  it('rule 2 — every scheduled route calls the guard after its Bearer check, or is exempt with a reason', () => {
    const offenders: string[] = [];
    for (const path of cronPaths) {
      const reason = EXEMPT[path];
      if (reason !== undefined) {
        if (reason.trim().length === 0) offenders.push(`${path}: EXEMPT with an empty reason`);
        continue;
      }
      const file = routeFileFor(path);
      if (!existsSync(file)) continue; // rule 1 reports it
      const code = stripComments(readFileSync(file, 'utf8').replace(/\r/g, ''));
      const why = guardViolation(code);
      if (why !== null) offenders.push(`${path}: ${why}`);
    }
    expect(offenders).toEqual([]);
  });

  it('rule 3 — every EXEMPT entry is still scheduled', () => {
    const stale = Object.keys(EXEMPT).filter((p) => !cronPaths.includes(p));
    expect(stale).toEqual([]);
  });

  it('positive control — a comment-only mention and the inline flag check FAIL rule 2', () => {
    const commentOnly = stripComments(`
      // cronReadOnlyGuard(ROUTE) is only named in this comment
      if (!verifyCronBearer(auth, secret)) return unauthorized();
    `);
    const inlineFlag = stripComments(`
      if (!verifyCronBearer(auth, secret)) return unauthorized();
      if (env.flags.readOnlyMode) return NextResponse.json({ skipped: true });
    `);
    expect(guardViolation(commentOnly)).toBe('does not call cronReadOnlyGuard(');
    expect(guardViolation(inlineFlag)).toBe('does not call cronReadOnlyGuard(');
  });

  it('positive control — a guard before the Bearer check FAILS rule 2; after it passes', () => {
    const before = 'const ro = cronReadOnlyGuard(ROUTE); if (ro) return ro;\nconst gate = await gateCronBearerOrRespond(req, { route });';
    const after = 'const gate = await gateF6Cron(req, ROUTE); if (gate) return gate;\nconst ro = cronReadOnlyGuard(ROUTE); if (ro) return ro;';
    expect(guardViolation(before)).toBe('calls cronReadOnlyGuard( BEFORE the Bearer check');
    expect(guardViolation(after)).toBeNull();
  });

  it('positive control — a mention only in a TRAILING comment FAILS rule 2', () => {
    const trailing = stripComments(`
      if (!verifyCronBearer(auth, secret)) return unauthorized(); // then cronReadOnlyGuard(ROUTE)
      return NextResponse.json({ ok: true });
    `);
    expect(guardViolation(trailing)).toBe('does not call cronReadOnlyGuard(');
  });

  it('positive control — a call whose result is not returned FAILS rule 2', () => {
    const bare = stripComments(`
      if (!verifyCronBearer(auth, secret)) return unauthorized();
      cronReadOnlyGuard(ROUTE);
      await sweep();
    `);
    const unreturned = stripComments(`
      if (!verifyCronBearer(auth, secret)) return unauthorized();
      const frozen = cronReadOnlyGuard(ROUTE);
      await sweep();
    `);
    expect(guardViolation(bare)).toBe(UNRETURNED);
    expect(guardViolation(unreturned)).toBe(UNRETURNED);
  });

  it('positive control — a URL literal survives the comment strip; the braced return form passes', () => {
    const url = stripComments(`
      const gate = await gateCronBearerOrRespond(req, { route: 'https://example.test/api/cron' });
      if (gate) return gate;
      const frozen = cronReadOnlyGuard('https://example.test/api/cron');
      if (frozen) {
        // metered, then returned
        metrics.skipped('x');
        metrics.completed('tenant', 'skipped_read_only');
        return frozen;
      }
    `);
    expect(url).toContain("'https://example.test/api/cron'");
    expect(guardViolation(url)).toBeNull();
  });
});

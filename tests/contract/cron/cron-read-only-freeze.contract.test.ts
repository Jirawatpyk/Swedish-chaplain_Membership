/**
 * #408 — READ_ONLY_MODE reaches the scheduled crons that had no route-level
 * contract test of their own.
 *
 * Vercel Cron invokes every `vercel.json` path with GET, and `src/proxy.ts`
 * freezes only POST/PUT/PATCH/DELETE, so each route must skip by itself (via
 * `cronReadOnlyGuard`, right after its Bearer check). The routes below each
 * write or call out on their first real step — outbox-dispatch sends email
 * through Resend, outbox-purge DELETEs outbox rows, sweep-stale-pending-refunds
 * asks Stripe and finalises refunds, lockout-cleanup UPDATEs users + appends an
 * audit row, and the two PDF reconcilers re-render and upload to Vercel Blob.
 *
 * Seam: `@/lib/db` keeps its real exports but `db` and `runInTenant` are
 * replaced by recorders that THROW on first use, and `fetch` is spied.
 *   - freeze ON  → 200 skip body, zero DB calls, zero `fetch` calls;
 *   - freeze ON + a wrong Bearer → 401 (the freeze state is not leaked);
 *   - freeze OFF → the route goes past the guard to its first DB call (its
 *     own behaviour from there is pinned by the integration suites under
 *     `tests/integration/{invoicing,members,broadcasts}/`).
 *
 * Imports are sequential awaits, never `Promise.all`: concurrent dynamic
 * imports of large route graphs deadlock vite-node with no output.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { NextRequest } from 'next/server';

const flagsMock = vi.hoisted(() => ({ readOnlyMode: false }));
const dbCalls = vi.hoisted(() => [] as string[]);

vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  const flags = {
    ...actual.env.flags,
    get readOnlyMode() {
      return flagsMock.readOnlyMode;
    },
  };
  return { ...actual, env: { ...actual.env, flags } };
});

vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
  const record = (name: string): never => {
    dbCalls.push(name);
    throw new Error(`#408 test: DB reached via ${name}`);
  };
  const db = new Proxy(
    {},
    {
      get: (_target, prop) =>
        typeof prop === 'symbol' || prop === 'then'
          ? undefined
          : (..._args: unknown[]) => record(`db.${prop}`),
    },
  );
  return { ...actual, db, runInTenant: () => record('runInTenant') };
});

type Handler = (req: NextRequest) => Promise<Response>;

const ROUTES: ReadonlyArray<{ readonly path: string; readonly load: () => Promise<{ GET: Handler }> }> = [
  { path: '/api/cron/outbox-dispatch', load: () => import('@/app/api/cron/outbox-dispatch/route') },
  { path: '/api/cron/outbox-purge', load: () => import('@/app/api/cron/outbox-purge/route') },
  { path: '/api/cron/sweep-stale-pending-refunds', load: () => import('@/app/api/cron/sweep-stale-pending-refunds/route') },
  { path: '/api/cron/lockout-cleanup', load: () => import('@/app/api/cron/lockout-cleanup/route') },
  { path: '/api/internal/cron/receipt-pdf-reconcile', load: () => import('@/app/api/internal/cron/receipt-pdf-reconcile/route') },
  { path: '/api/internal/cron/void-pdf-reconcile', load: () => import('@/app/api/internal/cron/void-pdf-reconcile/route') },
];

function makeRequest(path: string, auth: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'GET',
    headers: { authorization: auth },
  });
}

const validAuth = (): string => `Bearer ${process.env.CRON_SECRET ?? ''}`;

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  flagsMock.readOnlyMode = false;
  dbCalls.length = 0;
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('#408 test: fetch reached'));
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('#408 — scheduled crons skip under READ_ONLY_MODE (routes without their own contract test)', () => {
  vi.setConfig({ testTimeout: 60_000 });

  for (const route of ROUTES) {
    describe(route.path, () => {
      it('freeze ON → 200 skip body; no DB call, no external call', async () => {
        flagsMock.readOnlyMode = true;
        const { GET } = await route.load();
        const res = await GET(makeRequest(route.path, validAuth()));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, skipped: true, reason: 'read_only_mode' });
        expect(dbCalls).toEqual([]);
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      it('freeze ON + wrong Bearer → 401, not the skip', async () => {
        flagsMock.readOnlyMode = true;
        const { GET } = await route.load();
        const res = await GET(makeRequest(route.path, 'Bearer wrong-secret-0000000000000000'));
        expect(res.status).toBe(401);
        expect(dbCalls).toEqual([]);
      });

      it('freeze OFF → the route runs past the guard to its first DB call', async () => {
        const { GET } = await route.load();
        let body: unknown = null;
        try {
          const res = await GET(makeRequest(route.path, validAuth()));
          body = await res.json().catch(() => null);
        } catch {
          // A route that does not catch its first DB error rejects here; that
          // is the recorder's throw, which is the point of this case.
        }
        expect(body).not.toEqual({ ok: true, skipped: true, reason: 'read_only_mode' });
        expect(dbCalls.length).toBeGreaterThan(0);
      });
    });
  }
});

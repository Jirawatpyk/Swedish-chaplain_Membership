/**
 * Contract test — `POST /api/portal/renewal/[memberId]/confirm` when
 * `requireMemberContext` itself fails.
 *
 * Round 5 of review asked one bounded question — *today, in the 26 F8 routes,
 * is there a path that answers 500 with nothing an alert rule can match?* —
 * and this was the answer.
 *
 * `requireMemberContext` has three 500 exits. Two log at error level with no
 * `errorId`; the third (`member-context.ts:155-162`, the contacts lookup)
 * logs **nothing at all**, because `drizzle-contact-repo` swallows the DB
 * error into a Result. The route passed that response straight through, so a
 * Neon fault while a member submits their renewal produced a 500 that
 * `F8.PORTAL_CONFIRM.*` could not match — while this file's own docblock and
 * `docs/runbooks/audit-emit-loss.md` both promised it would.
 *
 * The 24 admin routes never had this hole: `requireRenewalAdminContext`
 * emits `<entry>.CONTEXT_RESOLUTION_FAILED` on its own 500 path. This is the
 * member-facing money route, and it was the one left open.
 *
 * The fix logs in the ROUTE rather than in the shared helper, which has other
 * portal callers with their own taxonomies.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const memberCtx: { value: unknown } = { value: null };
const loggerErrorMock = vi.fn();

vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === 'features') return { ...target.features, f8Renewals: true };
        return Reflect.get(target, prop);
      },
    }),
  };
});
vi.mock('@/lib/member-context', () => ({
  requireMemberContext: () => Promise.resolve(memberCtx.value),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: loggerErrorMock, debug: vi.fn() },
}));
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: { check: async () => ({ success: true, reset: 0 }) },
}));
vi.mock('@/modules/renewals', async () => {
  const actual = await vi.importActual<typeof import('@/modules/renewals')>(
    '@/modules/renewals',
  );
  return { ...actual, makeRenewalsDeps: () => ({}), confirmRenewal: vi.fn() };
});

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/portal/renewal/m1/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cycleId: '00000000-0000-0000-0000-0000000000c1' }),
  });
}

async function loadHandler() {
  const mod = await import('@/app/api/portal/renewal/[memberId]/confirm/route');
  return mod.POST;
}

describe('contract: portal renewal confirm — a 500 from requireMemberContext is alertable', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('logs an errorId before passing the helper 500 through', async () => {
    memberCtx.value = {
      response: NextResponse.json({ error: 'server-error' }, { status: 500 }),
    };

    const POST = await loadHandler();
    const res = await POST(makeReq(), {
      params: Promise.resolve({ memberId: 'm1' }),
    });

    expect(res.status).toBe(500);
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [structured] = loggerErrorMock.mock.calls[0]!;
    expect(structured.errorId).toBe('F8.PORTAL_CONFIRM.CONTEXT_RESOLUTION_FAILED');
  });

  it('does NOT log for the helper rejections that are not 500s', async () => {
    // A 401/403/404 from the gate is an ordinary authorisation outcome, not an
    // outage; logging it at error level would drown the signal this test pins.
    memberCtx.value = {
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    };

    const POST = await loadHandler();
    const res = await POST(makeReq(), {
      params: Promise.resolve({ memberId: 'm1' }),
    });

    expect(res.status).toBe(401);
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });
});

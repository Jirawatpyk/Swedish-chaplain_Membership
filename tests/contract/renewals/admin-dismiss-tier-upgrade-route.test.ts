/**
 * Contract test — `POST /api/admin/renewals/tier-upgrades/[suggestionId]/dismiss`.
 *
 * Written for the `assertNever` migration (docs/code-conventions.md § 8).
 * The migration commit claimed "the mechanism is proven once rather than
 * eight times", and the review of it disagreed for a specific reason: the
 * accept route's proof asserts `errorId: 'F8.ACCEPT_TIER.UNEXPECTED'`, a
 * value only that route emitted, so copying the test anywhere else would
 * have failed. Four of the eight routes — this one, escalate, snooze and
 * outreach — had NO test importing them at all, so a regression in them was
 * caught by nothing in CI.
 *
 * What this file does and does not buy, stated precisely because the first
 * version of this docblock overstated it: it closes the CI contract-shard
 * gap. It does NOT put this route behind the pre-push API-route gate —
 * `.husky/pre-push` greps `tests/integration/` only, so a `tests/contract/`
 * file is invisible to it and this route still prints "no integration test
 * imports … — skipping" on push.
 *
 * This pins the shared mechanism on a second route, one that had no test:
 * an unhandled error KIND leaves the switch, `assertNever` throws INSIDE the
 * `try`, and the outer catch turns it into a 500 that carries the
 * correlationId AND an `errorId` the F8 alert rules can key on.
 *
 * Mocks the auth context, env flags, tenant resolver, logger, and
 * `dismissTierUpgrade` so the handler runs without a DB.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err } from '@/lib/result';

const requireRenewalAdminContextMock = vi.fn();
const dismissTierUpgradeMock = vi.fn();
const f8FeatureFlag = { value: true };
const loggerErrorMock = vi.fn();

vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === 'features') {
          return { ...target.features, f8Renewals: f8FeatureFlag.value };
        }
        return Reflect.get(target, prop);
      },
    }),
  };
});
vi.mock('@/lib/renewals-route-helpers', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/renewals-route-helpers')
  >('@/lib/renewals-route-helpers');
  return {
    ...actual,
    requireRenewalAdminContext: (...args: unknown[]) =>
      requireRenewalAdminContextMock(...args),
  };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: loggerErrorMock,
    debug: vi.fn(),
  },
}));
vi.mock('@/modules/renewals', async () => {
  const actual = await vi.importActual<typeof import('@/modules/renewals')>(
    '@/modules/renewals',
  );
  return {
    ...actual,
    dismissTierUpgrade: (...args: unknown[]) => dismissTierUpgradeMock(...args),
    makeRenewalsDeps: () => ({}),
  };
});

const ADMIN_CTX = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-dismiss-1',
  correlationId: 'corr-dismiss-1',
};

const SUGGESTION_ID = 'sugg-dismiss-1';

function makeReq(): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/renewals/tier-upgrades/${SUGGESTION_ID}/dismiss`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
}

function makeCtx() {
  return { params: Promise.resolve({ suggestionId: SUGGESTION_ID }) };
}

async function loadHandler() {
  const mod = await import(
    '@/app/api/admin/renewals/tier-upgrades/[suggestionId]/dismiss/route'
  );
  return mod.POST;
}

describe('contract: POST /api/admin/renewals/tier-upgrades/[suggestionId]/dismiss', () => {
  afterEach(() => {
    vi.clearAllMocks();
    f8FeatureFlag.value = true;
  });

  it('404 — a known error kind still maps to its documented status', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    dismissTierUpgradeMock.mockResolvedValueOnce(
      err({ kind: 'suggestion_not_found' }),
    );

    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());

    expect(res.status).toBe(404);
    // A mapped arm must NOT reach the catch.
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  // The mechanism this migration exists for. `return _exhaustive` left the
  // `try` NORMALLY, so this catch never ran: the 500 came from Next with no
  // correlationId and no errorId for an alert rule to match.
  it('500 unhandled error KIND — assertNever routes it through the catch, with correlationId and errorId', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    dismissTierUpgradeMock.mockResolvedValueOnce(
      err({ kind: 'suggestion_already_dismissed_in_a_future_release' }),
    );

    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());

    expect(res.status).toBe(500);
    const body = (await res.json()) as { correlationId?: string };
    expect(body.correlationId).toBe('corr-dismiss-1');
    expect(res.headers.get('X-Correlation-Id')).toBe('corr-dismiss-1');

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [structured] = loggerErrorMock.mock.calls[0]!;
    // The half the review found missing in seven of the eight routes: the
    // catch logged no errorId at all, so the F8 alert rules — which key on
    // this field, not on message text — could not match this 500.
    expect(structured.errorId).toBe('F8.DISMISS_TIER.UNEXPECTED');
    expect(structured.correlationId).toBe('corr-dismiss-1');
    // The thrown message names the KIND and carries nothing else from the
    // error object (`assertNever`'s default would JSON.stringify all of it,
    // and pino's default err serializer puts the message in the log).
    expect(String(structured.err)).toContain('dismiss-tier-upgrade');
    expect(String(structured.err)).toContain(
      'suggestion_already_dismissed_in_a_future_release',
    );
  });
});

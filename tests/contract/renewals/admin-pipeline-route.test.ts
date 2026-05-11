/**
 * F8 Phase 3 Wave H3 · T063 contract test — GET `/api/admin/renewals`.
 *
 * Verify-run D1 remediation. Mocks `requireRenewalAdminContext`,
 * `loadPipeline` use-case, env feature flag. Real-DB coverage lives
 * in H5 integration test.
 */
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireRenewalAdminContextMock = vi.fn();
const loadPipelineMock = vi.fn();
// K12-S (TST-K-3): track renewal_kill_switch_blocked audit emission
// on the FR-052b 404 path so a future refactor that drops the audit
// emit fails CI.
const auditEmitMock = vi.fn(
  async (_event: { type: string; payload: unknown }, _ctx: unknown) => {},
);
const f8FeatureFlag = { value: true };

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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/renewals', async () => {
  const actual = await vi.importActual<typeof import('@/modules/renewals')>(
    '@/modules/renewals',
  );
  return {
    ...actual,
    loadPipeline: (...args: unknown[]) => loadPipelineMock(...args),
    makeRenewalsDeps: () => ({
      auditEmitter: { emit: auditEmitMock, emitInTx: vi.fn() },
    }),
  };
});

const ADMIN_CTX = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-1',
  correlationId: 'corr-1',
};

function makeReq(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/admin/renewals${query}`);
}

async function loadHandler() {
  const mod = await import('@/app/api/admin/renewals/route');
  return mod.GET;
}

const EMPTY_PIPELINE = {
  rows: [],
  nextCursor: null,
  summary: {
    totalInWindow: 0,
    byUrgency: {
      't-90': 0,
      't-60': 0,
      't-30': 0,
      't-14': 0,
      't-7': 0,
      't-0': 0,
      grace: 0,
      lapsed: 0,
    },
    lapsedCount: 0,
  },
};

describe('GET /api/admin/renewals — contract', () => {
  beforeEach(() => {
    f8FeatureFlag.value = true;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Round 7 test-infra fix — see admin-mark-paid-offline-route.test.ts
  // for rationale (cold-load timeout under heavy parallel load).
  it('404 when feature flag off (FR-052b — K2 spec compliance)', { timeout: 30_000 }, async () => {
    // K2 / FR-052: dashboard route returns 404 (not 503) + emits
    // `renewal_kill_switch_blocked` audit. The previous test pinned
    // the WRONG behaviour (503) — the contract is now corrected.
    f8FeatureFlag.value = false;
    const GET = await loadHandler();
    const res = await GET(makeReq());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('feature_disabled');
    // K12-S (TST-K-3): pin the audit emission so a refactor that
    // drops the renewal_kill_switch_blocked audit (silently weakening
    // the FR-052b forensic trail) fails CI. Audit type + route
    // payload locked to the canonical shape.
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    const event = auditEmitMock.mock.calls[0]![0];
    expect(event.type).toBe('renewal_kill_switch_blocked');
    expect((event.payload as { route: string }).route).toBe(
      '/api/admin/renewals',
    );
  });

  it('passes through 401 from helper when no session', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: { code: 'no_session' } }), {
        status: 401,
      }),
    });
    const GET = await loadHandler();
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it('200 happy path — snake_case response shape', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    loadPipelineMock.mockResolvedValueOnce(
      ok({
        rows: [
          {
            cycleId: 'c1',
            memberId: 'm1',
            companyName: 'Acme Co',
            tierBucket: 'premium',
            expiresAt: '2026-08-15T17:00:00.000Z',
            urgency: 't-30',
            status: 'awaiting_payment',
            lastReminderAt: null,
            lastReminderStepId: null,
            linkedInvoiceId: null,
          },
        ],
        nextCursor: 'cur-2',
        summary: {
          totalInWindow: 1,
          byUrgency: { ...EMPTY_PIPELINE.summary.byUrgency, 't-30': 1 },
          lapsedCount: 0,
        },
      }),
    );
    const GET = await loadHandler();
    const res = await GET(makeReq('?tier=premium&urgency=t-30'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0].cycle_id).toBe('c1');
    expect(body.items[0].company_name).toBe('Acme Co');
    expect(body.items[0].tier_bucket).toBe('premium');
    expect(body.next_cursor).toBe('cur-2');
    expect(body.summary.total_in_window).toBe(1);
    expect(body.summary.by_urgency['t-30']).toBe(1);
  });

  it('400 invalid_query on bad urgency value', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const GET = await loadHandler();
    const res = await GET(makeReq('?urgency=not-a-bucket'));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_query');
  });

  it('400 invalid_query on limit > 200', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const GET = await loadHandler();
    const res = await GET(makeReq('?limit=500'));
    expect(res.status).toBe(400);
  });

  it('500 on unexpected error from use-case', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    loadPipelineMock.mockRejectedValueOnce(new Error('db down'));
    const GET = await loadHandler();
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('server_error');
  });

  it('400 invalid_input when use-case returns invalid_input', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    loadPipelineMock.mockResolvedValueOnce(
      err({ kind: 'invalid_input', issues: [{ path: 'tenantId', message: 'required' }] }),
    );
    const GET = await loadHandler();
    const res = await GET(makeReq());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_input');
  });
});

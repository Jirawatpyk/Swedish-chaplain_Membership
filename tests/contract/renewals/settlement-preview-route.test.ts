/**
 * 059-membership-suspension Task 9 contract test — GET
 * `/api/admin/renewals/settlement-preview`.
 *
 * Mirrors `admin-pipeline-route.test.ts`'s mock shape (requireRenewalAdmin
 * Context + the use-case + env feature flag + audit emit on the kill-switch
 * path). Real-DB coverage lives in the Task 9 integration test
 * (`tests/integration/renewals/settlement-preview.integration.test.ts`).
 */
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireRenewalAdminContextMock = vi.fn();
const loadSettlementPreviewMock = vi.fn();
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
    loadSettlementPreview: (...args: unknown[]) =>
      loadSettlementPreviewMock(...args),
    makeRenewalsDeps: () => ({
      cyclesRepo: {},
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

// Review round 1 fix A/D — the route now rejects non-UUID cycle_ids with
// 400 before reaching the use-case, so every fixture that must reach the
// mocked use-case needs well-formed UUIDs (not the opaque 'c1'/'c2'
// labels used before the hardening).
const CYCLE_ID_1 = '11111111-1111-4111-8111-111111111111';
const CYCLE_ID_2 = '22222222-2222-4222-8222-222222222222';

function makeReq(query = ''): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/renewals/settlement-preview${query}`,
  );
}

async function loadHandler() {
  const mod = await import('@/app/api/admin/renewals/settlement-preview/route');
  return mod.GET;
}

describe('GET /api/admin/renewals/settlement-preview — contract', () => {
  beforeEach(() => {
    f8FeatureFlag.value = true;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('404 when feature flag off (+ renewal_kill_switch_blocked audit)', { timeout: 30_000 }, async () => {
    f8FeatureFlag.value = false;
    const GET = await loadHandler();
    const res = await GET(makeReq('?cycle_ids=c1'));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('feature_disabled');
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    const event = auditEmitMock.mock.calls[0]![0];
    expect(event.type).toBe('renewal_kill_switch_blocked');
    expect((event.payload as { route: string }).route).toBe(
      '/api/admin/renewals/settlement-preview',
    );
  });

  it('passes through 401 from helper when no session', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: { code: 'no_session' } }), {
        status: 401,
      }),
    });
    const GET = await loadHandler();
    const res = await GET(makeReq('?cycle_ids=c1'));
    expect(res.status).toBe(401);
  });

  it('200 happy path — snake_case response shape', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    loadSettlementPreviewMock.mockResolvedValueOnce(
      ok({
        items: [
          {
            cycleId: CYCLE_ID_1,
            companyName: 'Acme Co',
            invoiceId: 'inv1',
            amountThbMinor: 1070_00,
            currency: 'THB',
            previewable: true,
          },
          {
            cycleId: CYCLE_ID_2,
            companyName: 'Beta Co',
            invoiceId: null,
            amountThbMinor: null,
            currency: null,
            previewable: false,
          },
        ],
        totalThbMinor: 1070_00,
      }),
    );
    const GET = await loadHandler();
    const res = await GET(makeReq(`?cycle_ids=${CYCLE_ID_1},${CYCLE_ID_2}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0].cycle_id).toBe(CYCLE_ID_1);
    expect(body.items[0].company_name).toBe('Acme Co');
    expect(body.items[0].invoice_id).toBe('inv1');
    expect(body.items[0].amount_thb_minor).toBe(1070_00);
    expect(body.items[0].currency).toBe('THB');
    expect(body.items[0].previewable).toBe(true);
    expect(body.items[1].previewable).toBe(false);
    expect(body.items[1].invoice_id).toBeNull();
    expect(body.total_thb_minor).toBe(1070_00);

    // The route must have parsed the comma-list into an array.
    const call = loadSettlementPreviewMock.mock.calls[0]!;
    expect(call[1].cycleIds).toEqual([CYCLE_ID_1, CYCLE_ID_2]);

    // Review round 1 fix D — a mutation of
    // `requireRenewalAdminContext(request, 'read')` → `'write'` would 403
    // every manager (this is a read-only surface: admin OR manager). Pin
    // the exact authz mode requested so that mutation can't survive.
    expect(requireRenewalAdminContextMock).toHaveBeenCalledWith(
      expect.anything(),
      'read',
    );
  });

  it('de-duplicates repeated cycle_ids before calling the use-case', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    loadSettlementPreviewMock.mockResolvedValueOnce(
      ok({ items: [], totalThbMinor: 0 }),
    );
    const GET = await loadHandler();
    const res = await GET(
      makeReq(`?cycle_ids=${CYCLE_ID_1},${CYCLE_ID_1},${CYCLE_ID_2}`),
    );
    expect(res.status).toBe(200);
    const call = loadSettlementPreviewMock.mock.calls[0]!;
    expect(call[1].cycleIds).toEqual([CYCLE_ID_1, CYCLE_ID_2]);
  });

  it('400 invalid_query when cycle_ids is missing', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const GET = await loadHandler();
    const res = await GET(makeReq());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_query');
  });

  it('400 invalid_query when cycle_ids is empty/blank', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const GET = await loadHandler();
    const res = await GET(makeReq('?cycle_ids=,, ,'));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_query');
  });

  it('400 invalid_query when cycle_ids has more than 100 ids', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const GET = await loadHandler();
    const ids = Array.from({ length: 101 }, (_, i) => `c${i}`).join(',');
    const res = await GET(makeReq(`?cycle_ids=${ids}`));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_query');
  });

  // Review round 1 fix A/D — a malformed id must fail fast as 400
  // invalid_query BEFORE any DB work, not reach Postgres and surface as a
  // 500 on `22P02 invalid input syntax for type uuid`.
  it('400 invalid_query when a cycle_id is not a well-formed UUID', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const GET = await loadHandler();
    const res = await GET(makeReq('?cycle_ids=not-a-uuid'));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_query');
    // Must never have reached the use-case.
    expect(loadSettlementPreviewMock).not.toHaveBeenCalled();
  });

  it('400 invalid_input when use-case returns invalid_input', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    loadSettlementPreviewMock.mockResolvedValueOnce(
      err({ kind: 'invalid_input', message: 'cycleIds must be 1..100' }),
    );
    const GET = await loadHandler();
    const res = await GET(makeReq(`?cycle_ids=${CYCLE_ID_1}`));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_input');
  });

  it('500 on unexpected error from use-case', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    loadSettlementPreviewMock.mockRejectedValueOnce(new Error('db down'));
    const GET = await loadHandler();
    const res = await GET(makeReq(`?cycle_ids=${CYCLE_ID_1}`));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('server_error');
  });
});

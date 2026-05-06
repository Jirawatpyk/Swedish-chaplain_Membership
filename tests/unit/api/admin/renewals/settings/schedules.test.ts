/**
 * F8 Phase 4 Wave J7 / H14 — schedule-editor route handler unit tests.
 *
 * Pins the wire contract for the two routes that back the admin
 * schedule-editor surface (`docs/contracts/admin-renewals-api.md` § 5):
 *
 *   1. GET  /api/admin/renewals/settings/schedules
 *      - load all 5 tier-bucket policies for the read-only editor
 *      - admin OR manager (read access)
 *
 *   2. PUT  /api/admin/renewals/settings/schedules/[tierBucket]
 *      - persist a single tier bucket's step list
 *      - admin only — manager 403 (write blocked)
 *      - emits `renewal_schedule_policy_updated` audit (atomic per
 *        Constitution Principle VIII; tested at the use-case level)
 *
 * Test scope (both routes):
 *   - Kill-switch (503), no-session (401), forbidden (403) auth gating
 *   - Happy path returns the full body shape
 *   - Use-case error variants → mapped HTTP statuses
 *   - Unexpected throw → 500 server_error
 *
 * The mock pattern mirrors `tests/unit/api/admin/renewals/send-reminder-now.test.ts`
 * — `requireRenewalAdminContext` is overridden so we can script auth
 * outcomes without booting the real session/RBAC stack; the
 * errorResponse/successResponse envelopes are kept REAL (NextResponse-
 * based) so we assert HTTP status + body shape end-to-end.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

// Tenant slug 'tenanta' is inlined into vi.mock factories below
// (factories are hoisted above module-level consts so a top-level
// `const TENANT_SLUG` is not in scope when the factory runs).
const ADMIN_USER_ID = '00000000-0000-0000-0000-000000000a01';

vi.mock('@/lib/env', () => ({
  env: {
    features: { f8Renewals: true },
    // vi.mock factories are hoisted above module-level consts; inline
    // the tenant slug literal rather than referencing TENANT_SLUG.
    tenant: { slug: 'tenanta' },
    log: { level: 'silent' },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: vi.fn(() => ({ slug: 'tenanta' })),
}));

const requireAdminMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/renewals-route-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    requireRenewalAdminContext: requireAdminMock,
    errorResponse: ({
      status,
      code,
      correlationId,
      details,
    }: {
      status: number;
      code: string;
      correlationId: string;
      details?: Record<string, unknown>;
    }) =>
      NextResponse.json(
        { error: { code, ...(details ?? {}) }, correlationId },
        {
          status,
          headers: {
            'X-Correlation-Id': correlationId,
            'Cache-Control': 'no-store, private',
          },
        },
      ),
    successResponse: <T>(body: T, correlationId: string, status = 200) =>
      NextResponse.json(body, {
        status,
        headers: {
          'X-Correlation-Id': correlationId,
          'Cache-Control': 'no-store, private',
        },
      }),
  };
});

const loadSchedulePoliciesMock = vi.hoisted(() => vi.fn());
const updateSchedulePolicyMock = vi.hoisted(() => vi.fn());
vi.mock('@/modules/renewals', async () => {
  const actual =
    await vi.importActual<typeof import('@/modules/renewals')>(
      '@/modules/renewals',
    );
  return {
    ...actual,
    loadSchedulePolicies: loadSchedulePoliciesMock,
    updateSchedulePolicy: updateSchedulePolicyMock,
    makeRenewalsDeps: vi.fn(() => ({ tenant: { slug: 'tenanta' } })),
  };
});

import { GET } from '@/app/api/admin/renewals/settings/schedules/route';
import { PUT } from '@/app/api/admin/renewals/settings/schedules/[tierBucket]/route';

function makeGetRequest(): NextRequest {
  return {
    headers: { get: () => null },
    url: 'http://localhost:3100/api/admin/renewals/settings/schedules',
  } as unknown as NextRequest;
}

function makePutRequest(body: unknown): NextRequest {
  return {
    headers: { get: () => null },
    url: 'http://localhost:3100/api/admin/renewals/settings/schedules/regular',
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  } as unknown as NextRequest;
}

const validParams = { params: Promise.resolve({ tierBucket: 'regular' }) };

function adminCtx() {
  return {
    current: { user: { id: ADMIN_USER_ID, role: 'admin' as const } },
    sourceIp: '127.0.0.1',
    requestId: 'req-1',
    correlationId: 'corr-1',
  };
}

// ===========================================================================
// GET /api/admin/renewals/settings/schedules
// ===========================================================================

describe('GET /api/admin/renewals/settings/schedules (T084)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminMock.mockResolvedValue(adminCtx());
  });

  it('503 feature_disabled when kill-switch off', async () => {
    const env = (await import('@/lib/env')).env as {
      features: { f8Renewals: boolean };
    };
    env.features.f8Renewals = false;
    try {
      const res = await GET(makeGetRequest());
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.code).toBe('feature_disabled');
      expect(requireAdminMock).not.toHaveBeenCalled();
    } finally {
      env.features.f8Renewals = true;
    }
  });

  it('401 forwards rejection from requireRenewalAdminContext', async () => {
    const { errorResponse } = await import('@/lib/renewals-route-helpers');
    requireAdminMock.mockResolvedValueOnce({
      response: errorResponse({
        status: 401,
        code: 'no_session',
        correlationId: 'corr-x',
      }),
    });
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
    expect(loadSchedulePoliciesMock).not.toHaveBeenCalled();
  });

  it('uses requireRenewalAdminContext("read") so manager can also load', async () => {
    loadSchedulePoliciesMock.mockResolvedValueOnce(ok({ policies: [] }));
    await GET(makeGetRequest());
    expect(requireAdminMock).toHaveBeenCalledWith(
      expect.anything(),
      'read',
    );
  });

  it('200 happy path returns policies array with snake_case shape', async () => {
    loadSchedulePoliciesMock.mockResolvedValueOnce(
      ok({
        policies: [
          {
            tierBucket: 'regular',
            updatedAt: '2026-05-01T08:00:00.000Z',
            steps: [
              {
                stepId: 't-30.email',
                offsetDays: -30,
                channel: 'email' as const,
                templateId: 'renewal.t-30.regular',
              },
            ],
          },
        ],
      }),
    );
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policies).toHaveLength(1);
    expect(body.policies[0].tier_bucket).toBe('regular');
    expect(body.policies[0].updated_at).toBe('2026-05-01T08:00:00.000Z');
    // step_id-format wire shape (snake_case)
    expect(body.policies[0].steps[0].step_id).toBe('t-30.email');
    expect(body.policies[0].steps[0].offset_days).toBe(-30);
  });

  it('400 invalid_input forwards use-case error message', async () => {
    loadSchedulePoliciesMock.mockResolvedValueOnce(
      err({ kind: 'invalid_input', message: 'tenantId is required' }),
    );
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_input');
    expect(body.error.message).toBe('tenantId is required');
  });

  it('500 server_error on unexpected throw', async () => {
    loadSchedulePoliciesMock.mockRejectedValueOnce(
      new Error('db: connection lost'),
    );
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('server_error');
  });
});

// ===========================================================================
// PUT /api/admin/renewals/settings/schedules/[tierBucket]
// ===========================================================================

const VALID_PUT_BODY = {
  steps: [
    {
      step_id: 't-30.email',
      offset_days: -30,
      channel: 'email',
      template_id: 'renewal.t-30.regular',
    },
  ],
};

describe('PUT /api/admin/renewals/settings/schedules/[tierBucket] (T085)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminMock.mockResolvedValue(adminCtx());
  });

  it('503 feature_disabled when kill-switch off', async () => {
    const env = (await import('@/lib/env')).env as {
      features: { f8Renewals: boolean };
    };
    env.features.f8Renewals = false;
    try {
      const res = await PUT(makePutRequest(VALID_PUT_BODY), validParams);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.code).toBe('feature_disabled');
      expect(requireAdminMock).not.toHaveBeenCalled();
    } finally {
      env.features.f8Renewals = true;
    }
  });

  it('401 forwards rejection from requireRenewalAdminContext (no session)', async () => {
    const { errorResponse } = await import('@/lib/renewals-route-helpers');
    requireAdminMock.mockResolvedValueOnce({
      response: errorResponse({
        status: 401,
        code: 'no_session',
        correlationId: 'corr-x',
      }),
    });
    const res = await PUT(makePutRequest(VALID_PUT_BODY), validParams);
    expect(res.status).toBe(401);
    expect(updateSchedulePolicyMock).not.toHaveBeenCalled();
  });

  it('403 forwards rejection (manager — write blocked)', async () => {
    const { errorResponse } = await import('@/lib/renewals-route-helpers');
    requireAdminMock.mockResolvedValueOnce({
      response: errorResponse({
        status: 403,
        code: 'forbidden',
        correlationId: 'corr-x',
      }),
    });
    const res = await PUT(makePutRequest(VALID_PUT_BODY), validParams);
    expect(res.status).toBe(403);
    expect(updateSchedulePolicyMock).not.toHaveBeenCalled();
  });

  it('uses requireRenewalAdminContext("write") to enforce admin-only', async () => {
    updateSchedulePolicyMock.mockResolvedValueOnce(
      ok({
        policy: {
          tierBucket: 'regular',
          updatedAt: '2026-05-04T08:00:00.000Z',
          steps: [
            {
              stepId: 't-30.email',
              offsetDays: -30,
              channel: 'email',
              templateId: 'renewal.t-30.regular',
            },
          ],
        },
        changeDiff: { added: [], removed: [], unchanged: ['t-30.email'] },
      }),
    );
    await PUT(makePutRequest(VALID_PUT_BODY), validParams);
    expect(requireAdminMock).toHaveBeenCalledWith(
      expect.anything(),
      'write',
    );
  });

  it('404 tier_bucket_not_found on unknown tierBucket path param', async () => {
    const res = await PUT(makePutRequest(VALID_PUT_BODY), {
      params: Promise.resolve({ tierBucket: 'platinum-nope' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('tier_bucket_not_found');
    expect(updateSchedulePolicyMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body when JSON.parse throws', async () => {
    const res = await PUT(makePutRequest(new Error('SyntaxError')), validParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
    expect(updateSchedulePolicyMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body when zod schema fails (empty steps array)', async () => {
    const res = await PUT(makePutRequest({ steps: [] }), validParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
    expect(body.error.fieldErrors).toBeDefined();
    expect(updateSchedulePolicyMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body when step has invalid channel value', async () => {
    const res = await PUT(
      makePutRequest({
        steps: [
          {
            step_id: 't-30.email',
            offset_days: -30,
            channel: 'sms', // invalid — only 'email' | 'task'
          },
        ],
      }),
      validParams,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
  });

  it('422 invalid_steps when use-case rejects domain invariants', async () => {
    updateSchedulePolicyMock.mockResolvedValueOnce(
      err({
        kind: 'invalid_steps',
        error: 'duplicate_step_id',
      }),
    );
    const res = await PUT(makePutRequest(VALID_PUT_BODY), validParams);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_steps');
    expect(body.error.error).toBe('duplicate_step_id');
  });

  it('400 invalid_input forwards use-case error message', async () => {
    updateSchedulePolicyMock.mockResolvedValueOnce(
      err({ kind: 'invalid_input', message: 'tier_bucket required' }),
    );
    const res = await PUT(makePutRequest(VALID_PUT_BODY), validParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_input');
    expect(body.error.message).toBe('tier_bucket required');
  });

  it('200 happy path returns policy + change_diff snake_case shape', async () => {
    updateSchedulePolicyMock.mockResolvedValueOnce(
      ok({
        policy: {
          tierBucket: 'regular',
          updatedAt: '2026-05-04T08:00:00.000Z',
          steps: [
            {
              stepId: 't-30.email',
              offsetDays: -30,
              channel: 'email',
              templateId: 'renewal.t-30.regular',
            },
          ],
        },
        changeDiff: {
          added: ['t-30.email'],
          removed: ['t-60.email'],
          unchanged: [],
        },
      }),
    );
    const res = await PUT(makePutRequest(VALID_PUT_BODY), validParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tier_bucket).toBe('regular');
    expect(body.updated_at).toBe('2026-05-04T08:00:00.000Z');
    expect(body.steps[0].step_id).toBe('t-30.email');
    expect(body.change_diff.added).toEqual(['t-30.email']);
    expect(body.change_diff.removed).toEqual(['t-60.email']);
  });

  it('500 server_error on unexpected throw', async () => {
    updateSchedulePolicyMock.mockRejectedValueOnce(
      new Error('db: connection lost'),
    );
    const res = await PUT(makePutRequest(VALID_PUT_BODY), validParams);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('server_error');
  });
});

/**
 * PR B (#707 follow-up) — GET / PUT /api/admin/renewals/settings/reply-to.
 *
 * Pins the wire contract: the F8 kill switch, the `settings.renewal_schedules`
 * gate (its own audit on a manager 403 lives in requireRenewalAdminContext),
 * READ_ONLY_MODE after the gate and before any write, a strict body, the
 * use-case error kinds mapped to 422 codes, and server_error → 500.
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
    // QA Round 1 fix — same as per-tenant.test.ts: transitive imports
    // of `@/modules/renewals` reach upstash-rate-limiter which reads
    // env.upstash.url|token at module-init.
    upstash: {
      url: 'https://test.upstash.io',
      token: 'test-token-with-enough-length-for-zod-min-20',
    },
    // schedules route imports membersDeps → audit-deps which transitively
    // pulls in the Resend transactional email client. Resend SDK is
    // constructed at module-init with `env.resend.apiKey`; stub here.
    resend: {
      apiKey: 're_test_placeholder',
      webhookSigningSecret: 'whsec_test_placeholder',
      fromEmail: 'noreply@test.example',
    },
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

const loadMock = vi.hoisted(() => vi.fn());
const updateMock = vi.hoisted(() => vi.fn());
vi.mock('@/modules/renewals', async () => {
  const actual = await vi.importActual<typeof import('@/modules/renewals')>('@/modules/renewals');
  return {
    ...actual,
    loadRenewalReplyTo: loadMock,
    updateRenewalReplyTo: updateMock,
    makeRenewalsDeps: vi.fn(() => ({ tenant: { slug: 'tenanta' } })),
  };
});

const readOnlyMock = vi.hoisted(() => vi.fn((): Response | null => null));
vi.mock('@/app/api/plans/_read-only-guard', () => ({ readOnlyModeResponse: readOnlyMock }));

import { GET, PUT } from '@/app/api/admin/renewals/settings/reply-to/route';

function req(body?: unknown): NextRequest {
  return {
    headers: { get: () => null },
    url: 'http://localhost:3100/api/admin/renewals/settings/reply-to',
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  } as unknown as NextRequest;
}

function adminCtx(role: 'admin' | 'super_admin' = 'admin') {
  return {
    current: { user: { id: ADMIN_USER_ID, role } },
    sourceIp: '127.0.0.1',
    requestId: 'req-1',
    correlationId: 'corr-1',
  };
}

describe('GET /api/admin/renewals/settings/reply-to', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminMock.mockResolvedValue(adminCtx());
  });

  it('returns the stored values under the read gate', async () => {
    loadMock.mockResolvedValue(ok({ email: 'm@swecham.example', displayName: 'SweCham' }));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'm@swecham.example', displayName: 'SweCham' });
    expect(requireAdminMock).toHaveBeenCalledWith(expect.anything(), 'read', 'settings.renewal_schedules', 'F8.REPLY_TO_READ');
  });

  it('a gate refusal is returned as is', async () => {
    const { NextResponse } = await import('next/server');
    requireAdminMock.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) });
    expect((await GET(req())).status).toBe(403);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('a read failure is 500 server_error', async () => {
    loadMock.mockResolvedValue(err({ kind: 'server_error', message: 'Error' }));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('server_error');
  });
});

describe('PUT /api/admin/renewals/settings/reply-to', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminMock.mockResolvedValue(adminCtx());
    readOnlyMock.mockReturnValue(null);
  });

  it('passes the values, actor and literal role to the use case and returns changed', async () => {
    requireAdminMock.mockResolvedValue(adminCtx('super_admin'));
    updateMock.mockResolvedValue(ok({ email: 'm@swecham.example', displayName: null, changed: true }));
    const res = await PUT(req({ email: 'm@swecham.example', displayName: null }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'm@swecham.example', displayName: null, changed: true });
    expect(requireAdminMock).toHaveBeenCalledWith(expect.anything(), 'write', 'settings.renewal_schedules', 'F8.REPLY_TO_WRITE');
    expect(updateMock).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenanta',
      email: 'm@swecham.example',
      displayName: null,
      actorUserId: ADMIN_USER_ID,
      actorRole: 'super_admin',
      requestId: 'req-1',
      correlationId: 'corr-1',
    });
  });

  it('READ_ONLY_MODE refuses after the gate, before the use case', async () => {
    readOnlyMock.mockReturnValue(new Response(null, { status: 503 }));
    const res = await PUT(req({ email: null, displayName: null }));
    expect(res.status).toBe(503);
    expect(requireAdminMock).toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['unparseable JSON', new Error('bad json')],
    ['an unknown key', { email: null, displayName: null, extra: 1 }],
    ['a missing field', { email: 'm@swecham.example' }],
    ['a non-string email', { email: 5, displayName: null }],
  ])('%s is 400 invalid_body with no write', async (_label, body) => {
    const res = await PUT(req(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'invalid_email' }, 'invalid_email', undefined],
    [{ kind: 'display_name_without_email' }, 'display_name_without_email', undefined],
    [{ kind: 'invalid_display_name', reason: 'unsafe_character' }, 'invalid_display_name', 'unsafe_character'],
  ])('%o is 422 with its code', async (error, code, reason) => {
    updateMock.mockResolvedValue(err(error));
    const res = await PUT(req({ email: 'x', displayName: null }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe(code);
    expect(body.error.reason).toBe(reason);
  });

  it('server_error and an unexpected throw are 500 server_error', async () => {
    updateMock.mockResolvedValueOnce(err({ kind: 'server_error', message: 'Error' }));
    expect((await PUT(req({ email: null, displayName: null }))).status).toBe(500);
    updateMock.mockRejectedValueOnce(new Error('boom'));
    const res = await PUT(req({ email: null, displayName: null }));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('server_error');
  });

  it('503 feature_disabled when the F8 flag is off', async () => {
    const env = (await import('@/lib/env')).env as { features: { f8Renewals: boolean } };
    env.features.f8Renewals = false;
    try {
      expect((await PUT(req({ email: null, displayName: null }))).status).toBe(503);
      expect((await GET(req())).status).toBe(503);
    } finally {
      env.features.f8Renewals = true;
    }
  });
});

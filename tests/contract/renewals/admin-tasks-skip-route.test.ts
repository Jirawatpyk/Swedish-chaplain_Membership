/**
 * F8 Phase 8 R10 W2 close — contract test for
 * `POST /api/admin/renewals/tasks/[taskId]/skip`.
 *
 * Skip differs from Done in that `skipped_reason` is REQUIRED (1..500
 * chars) per Domain invariant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireRenewalAdminContextMock = vi.fn();
const skipEscalationTaskMock = vi.fn();
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
    skipEscalationTask: (...args: unknown[]) => skipEscalationTaskMock(...args),
    makeRenewalsDeps: () => ({}),
  };
});

const ADMIN_CTX = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-w2-skip',
  correlationId: 'corr-w2-skip',
};

const TASK_UUID = '00000000-0000-0000-0000-0000000d0001';
const VALID_REASON = 'Member unreachable; will revisit at T-30';

function makeReq(body: string | null = JSON.stringify({ skipped_reason: VALID_REASON })): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/renewals/tasks/${TASK_UUID}/skip`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ?? '',
    },
  );
}

function makeCtx() {
  return { params: Promise.resolve({ taskId: TASK_UUID }) };
}

async function loadHandler() {
  const mod = await import(
    '@/app/api/admin/renewals/tasks/[taskId]/skip/route'
  );
  return mod.POST;
}

describe('POST /api/admin/renewals/tasks/[taskId]/skip — contract (R10 W2)', () => {
  beforeEach(() => {
    f8FeatureFlag.value = true;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('503 when feature flag off', { timeout: 30_000 }, async () => {
    f8FeatureFlag.value = false;
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(503);
  });

  it('passes through 403 from helper for manager', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: { code: 'forbidden' } }), {
        status: 403,
      }),
    });
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(403);
  });

  it('200 happy path with snake_case', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    skipEscalationTaskMock.mockResolvedValueOnce(
      ok({
        taskId: TASK_UUID,
        closedAt: '2026-05-15T10:00:00.000Z',
      }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task_id).toBe(TASK_UUID);
    expect(body.closed_at).toBe('2026-05-15T10:00:00.000Z');
  });

  it('400 invalid_body on malformed JSON', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(makeReq('not-json'), makeCtx());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
  });

  it('400 invalid_body when skipped_reason missing (REQUIRED)', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(makeReq(JSON.stringify({})), makeCtx());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
  });

  it('400 invalid_body when skipped_reason empty', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(
      makeReq(JSON.stringify({ skipped_reason: '   ' })),
      makeCtx(),
    );
    expect(res.status).toBe(400);
  });

  it('400 invalid_body when skipped_reason > 500 chars', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(
      makeReq(JSON.stringify({ skipped_reason: 'x'.repeat(501) })),
      makeCtx(),
    );
    expect(res.status).toBe(400);
  });

  it('404 task_not_found', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    skipEscalationTaskMock.mockResolvedValueOnce(err({ kind: 'task_not_found' }));
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(404);
  });

  it('409 task_not_open', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    skipEscalationTaskMock.mockResolvedValueOnce(err({ kind: 'task_not_open' }));
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(409);
  });

  it('500 server_error', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    skipEscalationTaskMock.mockResolvedValueOnce(
      err({ kind: 'server_error', message: 'boom' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(500);
  });
});

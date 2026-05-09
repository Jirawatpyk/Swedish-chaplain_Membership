/**
 * F8 Phase 8 R10 W2 close — contract test for
 * `POST /api/admin/renewals/tasks/[taskId]/done`.
 *
 * Pins the wire shape (snake_case body + response keys), HTTP status
 * mapping for every Result.error kind, RBAC pass-through, and the
 * feature-flag short-circuit. Mirrors the precedent set by
 * `admin-cancel-route.test.ts` (Phase 3 T065).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireRenewalAdminContextMock = vi.fn();
const completeEscalationTaskMock = vi.fn();
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
    completeEscalationTask: (...args: unknown[]) =>
      completeEscalationTaskMock(...args),
    makeRenewalsDeps: () => ({}),
  };
});

const ADMIN_CTX = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-w2-done',
  correlationId: 'corr-w2-done',
};

const TASK_UUID = '00000000-0000-0000-0000-0000000d0000';

function makeReq(body: string | null = JSON.stringify({})): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/renewals/tasks/${TASK_UUID}/done`,
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
    '@/app/api/admin/renewals/tasks/[taskId]/done/route'
  );
  return mod.POST;
}

describe('POST /api/admin/renewals/tasks/[taskId]/done — contract (R10 W2)', () => {
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
    expect((await res.json()).error.code).toBe('feature_disabled');
  });

  it('passes through 403 from helper for manager (RBAC write)', async () => {
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
    completeEscalationTaskMock.mockResolvedValueOnce(
      ok({
        taskId: TASK_UUID,
        closedAt: '2026-05-15T10:00:00.000Z',
      }),
    );
    const POST = await loadHandler();
    const res = await POST(
      makeReq(JSON.stringify({ outcome_note: 'Spoke with member' })),
      makeCtx(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task_id).toBe(TASK_UUID);
    expect(body.closed_at).toBe('2026-05-15T10:00:00.000Z');
  });

  it('200 happy path with no outcome_note (optional)', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    completeEscalationTaskMock.mockResolvedValueOnce(
      ok({
        taskId: TASK_UUID,
        closedAt: '2026-05-15T10:00:00.000Z',
      }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(JSON.stringify({})), makeCtx());
    expect(res.status).toBe(200);
    // Confirm that an absent outcome_note is NOT forwarded (kept off
    // the use-case input shape — see route handler conditional spread).
    const callArg = completeEscalationTaskMock.mock.calls[0]?.[1];
    expect(callArg).not.toHaveProperty('outcomeNote');
  });

  it('400 invalid_body when outcome_note > 1000 chars', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(
      makeReq(JSON.stringify({ outcome_note: 'x'.repeat(1001) })),
      makeCtx(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
  });

  it('404 task_not_found', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    completeEscalationTaskMock.mockResolvedValueOnce(
      err({ kind: 'task_not_found' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('task_not_found');
  });

  it('409 task_not_open (already done/skipped)', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    completeEscalationTaskMock.mockResolvedValueOnce(
      err({ kind: 'task_not_open' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('task_not_open');
  });

  it('500 server_error from use-case', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    completeEscalationTaskMock.mockResolvedValueOnce(
      err({ kind: 'server_error', message: 'audit-DB-down' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('server_error');
  });

  it('500 unexpected throw is mapped to server_error response', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    completeEscalationTaskMock.mockRejectedValueOnce(new Error('boom'));
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('server_error');
  });
});

/**
 * F8 Phase 8 R10 W2 close — contract test for
 * `POST /api/admin/renewals/tasks/[taskId]/reassign`.
 *
 * Reassign requires `to_user_id` (UUID) — no UUID = 400 invalid_body.
 * Successful response includes both `from_user_id` and `to_user_id`
 * for forensic chain (FR-044 + AS3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireRenewalAdminContextMock = vi.fn();
const reassignEscalationTaskMock = vi.fn();
const userRepoFindByIdMock = vi.fn();
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
// Commit f4d0d114 (#42 P2-completion) added a server-side assignee staff-guard
// to the route — `userRepo.findById` from @/lib/auth-deps. Mock it so the
// contract tests that pass body-validation and reach the guard don't make a
// real Neon query (which silently timed out the suite for 30s in the
// non-blocking pre-push contract gate). importActual+spread preserves every
// other auth-deps export (rateLimiter, hasher, …) used elsewhere in the graph.
vi.mock('@/lib/auth-deps', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth-deps')>('@/lib/auth-deps');
  return {
    ...actual,
    userRepo: {
      ...actual.userRepo,
      findById: (...args: unknown[]) => userRepoFindByIdMock(...args),
    },
  };
});
vi.mock('@/modules/renewals', async () => {
  const actual = await vi.importActual<typeof import('@/modules/renewals')>(
    '@/modules/renewals',
  );
  return {
    ...actual,
    reassignEscalationTask: (...args: unknown[]) =>
      reassignEscalationTaskMock(...args),
    makeRenewalsDeps: () => ({}),
  };
});

const ADMIN_CTX = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-w2-reassign',
  correlationId: 'corr-w2-reassign',
};

const TASK_UUID = '00000000-0000-0000-0000-0000000d0002';
const TO_USER_UUID = '00000000-0000-0000-0000-0000000a0001';
const FROM_USER_UUID = '00000000-0000-0000-0000-0000000a0002';

function makeReq(body: string | null = JSON.stringify({ to_user_id: TO_USER_UUID })): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/renewals/tasks/${TASK_UUID}/reassign`,
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
    '@/app/api/admin/renewals/tasks/[taskId]/reassign/route'
  );
  return mod.POST;
}

describe('POST /api/admin/renewals/tasks/[taskId]/reassign — contract (R10 W2)', () => {
  beforeEach(() => {
    f8FeatureFlag.value = true;
    // Default: the reassign target is an active staff user, so the #42
    // assignee guard passes and tests reach the (mocked) use-case. Individual
    // tests override with mockResolvedValueOnce to exercise the reject path.
    userRepoFindByIdMock.mockResolvedValue({
      id: TO_USER_UUID,
      status: 'active',
      role: 'admin',
      email: 'assignee@b.co',
      displayName: 'Assignee',
    });
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

  it('200 happy path returns both from/to user_id snake_case', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    reassignEscalationTaskMock.mockResolvedValueOnce(
      ok({
        taskId: TASK_UUID,
        fromUserId: FROM_USER_UUID,
        toUserId: TO_USER_UUID,
      }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task_id).toBe(TASK_UUID);
    expect(body.from_user_id).toBe(FROM_USER_UUID);
    expect(body.to_user_id).toBe(TO_USER_UUID);
  });

  it('200 happy path with from_user_id null (was unassigned)', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    reassignEscalationTaskMock.mockResolvedValueOnce(
      ok({
        taskId: TASK_UUID,
        fromUserId: null,
        toUserId: TO_USER_UUID,
      }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.from_user_id).toBeNull();
    expect(body.to_user_id).toBe(TO_USER_UUID);
  });

  it('400 invalid_input when assignee is not an active staff user (#42 guard)', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    // Unknown / non-staff target — userRepo.findById returns null.
    userRepoFindByIdMock.mockResolvedValueOnce(null);
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_input');
    // The tenant-scoped reassign use-case MUST NOT run when the guard rejects.
    expect(reassignEscalationTaskMock).not.toHaveBeenCalled();
  });

  it('400 invalid_input when assignee is a DISABLED staff user (#42 guard — status branch)', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    // Exists + correct role, but disabled — the guard rejects on status !== 'active'.
    userRepoFindByIdMock.mockResolvedValueOnce({
      id: TO_USER_UUID,
      status: 'disabled',
      role: 'admin',
      email: 'disabled@b.co',
      displayName: 'Disabled Admin',
    });
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_input');
    expect(reassignEscalationTaskMock).not.toHaveBeenCalled();
  });

  it('400 invalid_input when assignee is an active MEMBER, not staff (#42 guard — role branch)', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    // Active, but role 'member' — not an admin/manager → the guard rejects (a
    // renewal escalation task must never be assigned to a portal member).
    userRepoFindByIdMock.mockResolvedValueOnce({
      id: TO_USER_UUID,
      status: 'active',
      role: 'member',
      email: 'member@b.co',
      displayName: 'Portal Member',
    });
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_input');
    expect(reassignEscalationTaskMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body on malformed JSON', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(makeReq('not-json'), makeCtx());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
  });

  it('400 invalid_body when to_user_id is not a UUID', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(
      makeReq(JSON.stringify({ to_user_id: 'not-a-uuid' })),
      makeCtx(),
    );
    expect(res.status).toBe(400);
  });

  it('400 invalid_body when to_user_id is missing', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(makeReq(JSON.stringify({})), makeCtx());
    expect(res.status).toBe(400);
  });

  it('404 task_not_found', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    reassignEscalationTaskMock.mockResolvedValueOnce(
      err({ kind: 'task_not_found' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(404);
  });

  it('409 task_not_open', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    reassignEscalationTaskMock.mockResolvedValueOnce(
      err({ kind: 'task_not_open' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(409);
  });

  it('500 server_error', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    reassignEscalationTaskMock.mockResolvedValueOnce(
      err({ kind: 'server_error', message: 'boom' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(500);
  });
});

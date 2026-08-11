/**
 * 107-auto-invoice Task 18 — Contract test: the `unenrol_auto_invoice` arm
 * of POST /api/members/bulk.
 *
 * Same shape as the Task 15 `enrol_auto_invoice` contract suite, and for
 * the same reason: the un-enrol arm must reuse the SHARED transport
 * mechanisms (RBAC chokepoint, ≤100 cap, per-actor rate limit,
 * Idempotency-Key) rather than inventing parallel ones. Each test here
 * pins one of those wirings.
 *
 * RBAC note: un-enrolling is strictly de-escalating (it can only STOP
 * automated billing), but it stays admin-only anyway — the endpoint is
 * admin-gated as a whole, and a manager who could flip the flag off could
 * also mask a member's billing state from the treasurer's queue.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireApiPermissionMock = vi.fn();
const bulkUnenrolMock = vi.fn();
const rateLimitCheckMock = vi.fn();
type Classification =
  | { kind: 'first' }
  | { kind: 'conflict' }
  | {
      kind: 'replay';
      previousResponse: { status: number; body: unknown };
    };
const classifyMock = vi.fn(
  async (): Promise<Classification> => ({ kind: 'first' }),
);

vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
}));
const auditRecordMock = vi.fn().mockResolvedValue({ ok: true, value: undefined });
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: vi.fn(() => ({
    tenant: { slug: 'test' },
    memberRepo: {},
    contactRepo: {},
    audit: { record: auditRecordMock, recordInTx: auditRecordMock },
    plans: {},
    membershipAccess: {},
    clock: { now: () => new Date() },
  })),
}));
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    bulkUnenrolAutoInvoice: (...args: unknown[]) => bulkUnenrolMock(...args),
  };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test', __brand: true }),
}));
vi.mock('@/lib/idempotency', () => ({
  parseIdempotencyKey: (headers: Headers) => {
    const key = headers.get('idempotency-key');
    if (!key) return { ok: false, reason: 'missing' };
    return { ok: true, key };
  },
  classifyIdempotencyRequest: (...args: unknown[]) => classifyMock(...(args as [])),
  reserveIdempotencyRecord: vi.fn(async () => ({
    ok: true,
    value: { kind: 'reserved' as const },
  })),
  rememberIdempotentResponse: vi.fn(async () => undefined),
  hashRequestBody: vi.fn(() => 'hash'),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter', () => ({
  rateLimiter: { check: (...args: unknown[]) => rateLimitCheckMock(...args) },
}));
vi.mock('@/modules/auth', async () => {
  const actual = await vi.importActual<typeof import('@/modules/auth')>(
    '@/modules/auth',
  );
  return {
    ...actual,
    rateLimiter: { check: (...args: unknown[]) => rateLimitCheckMock(...args) },
  };
});

const adminContext = {
  current: {
    user: {
      id: 'admin-1',
      email: 'a@b.co',
      role: 'admin',
      status: 'active',
      displayName: 'A',
    },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-unenrol-1',
};

function makeRequest(
  body: unknown,
  headers: Record<string, string> = { 'idempotency-key': 'idem-unenrol' },
): NextRequest {
  return new NextRequest('http://localhost/api/members/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const allowRateLimit = () =>
  rateLimitCheckMock.mockResolvedValueOnce({
    success: true,
    remaining: 9,
    reset: Date.now() + 600_000,
  });

describe('contract: POST /api/members/bulk — unenrol_auto_invoice arm', () => {
  afterEach(() => {
    vi.clearAllMocks();
    classifyMock.mockImplementation(async () => ({ kind: 'first' }));
  });

  it('200 happy path — returns snake_case bucket counts', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    allowRateLimit();
    bulkUnenrolMock.mockResolvedValueOnce(
      ok({ unenrolled: 2, skippedNotEnrolled: 1 }),
    );
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({
        action: 'unenrol_auto_invoice',
        member_ids: ['id-1', 'id-2', 'id-3'],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ unenrolled: 2, skipped_not_enrolled: 1 });
  });

  it('403 when the actor is not an admin', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({
      response: new (await import('next/server')).NextResponse(
        JSON.stringify({ error: 'forbidden' }),
        { status: 403 },
      ),
    });
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({ action: 'unenrol_auto_invoice', member_ids: ['id-1'] }),
    );
    expect(res.status).toBe(403);
    expect(bulkUnenrolMock).not.toHaveBeenCalled();
  });

  it('400 bulk_cap_exceeded when > 100 member_ids — before the use-case runs', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({ action: 'unenrol_auto_invoice', member_ids: ids }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('bulk_cap_exceeded');
    expect(bulkUnenrolMock).not.toHaveBeenCalled();
  });

  it('400 when the Idempotency-Key header is missing', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({ action: 'unenrol_auto_invoice', member_ids: ['id-1'] }, {}),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('missing_idempotency_key');
    expect(bulkUnenrolMock).not.toHaveBeenCalled();
  });

  it('replays a cached response without re-running the un-enrolment', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    classifyMock.mockImplementationOnce(async () => ({
      kind: 'replay' as const,
      previousResponse: {
        status: 200,
        body: { unenrolled: 2, skipped_not_enrolled: 0 },
      },
    }));
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({
        action: 'unenrol_auto_invoice',
        member_ids: ['id-1', 'id-2'],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.unenrolled).toBe(2);
    expect(bulkUnenrolMock).not.toHaveBeenCalled();
  });

  it('429 when the per-actor bulk rate limit is exhausted', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    rateLimitCheckMock.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      reset: Date.now() + 300_000,
    });
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({ action: 'unenrol_auto_invoice', member_ids: ['id-1'] }),
    );
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('bulk_rate_limit_exceeded');
    expect(bulkUnenrolMock).not.toHaveBeenCalled();
  });

  it('404 when a member id in the batch does not exist', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    allowRateLimit();
    bulkUnenrolMock.mockResolvedValueOnce(
      err({ type: 'not_found', memberId: 'ghost-1' }),
    );
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({ action: 'unenrol_auto_invoice', member_ids: ['ghost-1'] }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
    expect(body.error.details.member_id).toBe('ghost-1');
  });

  it('does NOT route an unenrol body into the enrol arm', async () => {
    // The two arms are dispatched by string equality on `action`. A
    // copy-paste that left the enrol arm's literal in place would send
    // un-enrol requests to the ENROL use-case — turning "stop billing me"
    // into a no-op that reports success. Cheap to pin, catastrophic to miss.
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    allowRateLimit();
    bulkUnenrolMock.mockResolvedValueOnce(
      ok({ unenrolled: 1, skippedNotEnrolled: 0 }),
    );
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({ action: 'unenrol_auto_invoice', member_ids: ['id-1'] }),
    );
    expect(res.status).toBe(200);
    expect(bulkUnenrolMock).toHaveBeenCalledTimes(1);
    // The body it received must be the un-enrol body, not a rewritten one.
    expect(bulkUnenrolMock.mock.calls[0]?.[0]).toMatchObject({
      action: 'unenrol_auto_invoice',
    });
  });
});

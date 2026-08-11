/**
 * 107-auto-invoice Task 15 — Contract test: the `enrol_auto_invoice` arm
 * of POST /api/members/bulk.
 *
 * The enrolment arm reuses the SAME transport mechanisms as the existing
 * `archive` / `change_plan` arms (RBAC chokepoint, ≤100 cap, per-actor
 * rate limit, Idempotency-Key) rather than inventing parallel ones — so
 * this suite asserts the arm is genuinely wired THROUGH them:
 *
 *   - 200 happy path, snake_case bucket counts on the wire
 *   - 403 non-admin rejected (the enrolment flag drives automated
 *     billing, so it must not be reachable by a manager)
 *   - 400 bulk_cap_exceeded (>100 member_ids), rejected BEFORE the
 *     use-case runs
 *   - 400 missing Idempotency-Key
 *   - replayed Idempotency-Key returns the cached response WITHOUT
 *     re-running the use-case (double-enrolment guard)
 *   - 429 rate-limited
 *   - 404 not_found propagates the all-or-nothing abort
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireApiPermissionMock = vi.fn();
const bulkEnrolMock = vi.fn();
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
    bulkEnrolAutoInvoice: (...args: unknown[]) => bulkEnrolMock(...args),
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
  requestId: 'req-enrol-1',
};

function makeRequest(
  body: unknown,
  headers: Record<string, string> = { 'idempotency-key': 'idem-enrol' },
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

describe('contract: POST /api/members/bulk — enrol_auto_invoice arm', () => {
  afterEach(() => {
    vi.clearAllMocks();
    classifyMock.mockImplementation(async () => ({ kind: 'first' }));
  });

  it('200 happy path — returns snake_case bucket counts', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    allowRateLimit();
    bulkEnrolMock.mockResolvedValueOnce(
      ok({
        enrolled: 2,
        skippedAlready: 1,
        skippedTerminated: 1,
        skippedErased: 0,
      }),
    );
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({
        action: 'enrol_auto_invoice',
        member_ids: ['id-1', 'id-2', 'id-3', 'id-4'],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // `toEqual` on the WHOLE body, not key-by-key: this is the only test that
    // pins the wire shape of the enrolment response, so an added/dropped key
    // must fail here.
    //
    // The mock MUST supply `skippedErased` even though it is zero here. This
    // suite previously omitted it, which made the assertion vacuous: the route
    // mapped `skipped_erased: undefined`, `JSON.stringify` dropped the key
    // entirely, and a three-key `toEqual` passed against a three-key body — so
    // deleting the route's mapping left the suite GREEN. `ok()` infers its type
    // from the literal, so typecheck could not see the hole either.
    //
    // Verified by mutation: dropping the route's `skipped_erased` mapping now
    // fails THIS case. The separate non-zero case below covers what a zero
    // cannot — a mapping hardcoded to a constant instead of reading the
    // use-case value (that mutation passes here and fails only there).
    expect(body).toEqual({
      enrolled: 2,
      skipped_already: 1,
      skipped_terminated: 1,
      skipped_erased: 0,
    });
  });

  it('200 — surfaces a non-zero GDPR-erased skip bucket on the wire', async () => {
    // The erased bucket is reported SEPARATELY from `skipped_terminated`: an
    // erased member can never be enrolled, whereas a terminated one can after
    // renewing (see the use-case + the toast branch in bulk-action-bar.tsx).
    // Non-zero BY DESIGN: this is the only case that fails when the mapping is
    // hardcoded to a constant rather than read from the use-case result.
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    allowRateLimit();
    bulkEnrolMock.mockResolvedValueOnce(
      ok({
        enrolled: 1,
        skippedAlready: 0,
        skippedTerminated: 1,
        skippedErased: 2,
      }),
    );
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({
        action: 'enrol_auto_invoice',
        member_ids: ['id-1', 'id-2', 'id-3', 'id-4'],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      enrolled: 1,
      skipped_already: 0,
      skipped_terminated: 1,
      skipped_erased: 2,
    });
  });

  it('403 when the actor is not an admin', async () => {
    // The RBAC chokepoint short-circuits with its own response object.
    requireApiPermissionMock.mockResolvedValueOnce({
      response: new (await import('next/server')).NextResponse(
        JSON.stringify({ error: 'forbidden' }),
        { status: 403 },
      ),
    });
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({ action: 'enrol_auto_invoice', member_ids: ['id-1'] }),
    );
    expect(res.status).toBe(403);
    expect(bulkEnrolMock).not.toHaveBeenCalled();
  });

  it('400 bulk_cap_exceeded when > 100 member_ids — before the use-case runs', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({ action: 'enrol_auto_invoice', member_ids: ids }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('bulk_cap_exceeded');
    expect(bulkEnrolMock).not.toHaveBeenCalled();
  });

  it('400 when the Idempotency-Key header is missing', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({ action: 'enrol_auto_invoice', member_ids: ['id-1'] }, {}),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('missing_idempotency_key');
    expect(bulkEnrolMock).not.toHaveBeenCalled();
  });

  it('replays a cached response without re-running the enrolment', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    classifyMock.mockImplementationOnce(async () => ({
      kind: 'replay' as const,
      previousResponse: {
        status: 200,
        body: { enrolled: 2, skipped_already: 0, skipped_terminated: 0 },
      },
    }));
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({
        action: 'enrol_auto_invoice',
        member_ids: ['id-1', 'id-2'],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enrolled).toBe(2);
    // The whole point of the idempotency guard: no second write.
    expect(bulkEnrolMock).not.toHaveBeenCalled();
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
      makeRequest({ action: 'enrol_auto_invoice', member_ids: ['id-1'] }),
    );
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('bulk_rate_limit_exceeded');
    expect(bulkEnrolMock).not.toHaveBeenCalled();
  });

  it('404 when a member id in the batch does not exist', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    allowRateLimit();
    bulkEnrolMock.mockResolvedValueOnce(
      err({ type: 'not_found', memberId: 'ghost-1' }),
    );
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({ action: 'enrol_auto_invoice', member_ids: ['ghost-1'] }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
    expect(body.error.details.member_id).toBe('ghost-1');
  });
});

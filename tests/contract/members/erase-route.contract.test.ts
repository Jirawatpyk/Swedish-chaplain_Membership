/**
 * Contract test: POST /api/members/[memberId]/erase (COMP-1 US3-A).
 *
 * Admin-only GDPR Art.17 / PDPA §33 erasure trigger. The route's strict
 * `eraseRouteSchema` REQUIRES the Art.12 identity attestation
 * (`identityVerified === true` + a known `verificationMethod`) at the boundary —
 * the core eraseMemberSchema keeps it optional for the reconciler re-drive, so a
 * request missing or falsifying the attestation MUST be rejected 400 invalid_body
 * BEFORE eraseMember is ever called.
 *
 * Mocks the admin-context, idempotency helpers, tenant resolver, deps builder,
 * and the `eraseMember` use case so the handler runs without touching the real
 * DB / session. Asserts response shape + HTTP status + that eraseMember is/isn't
 * invoked per branch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const eraseMemberMock = vi.fn();
const buildEraseMemberDepsMock = vi.fn();
// Loosely typed so a single mock can return any idempotency classification
// shape (first / replay / conflict) across cases without a TS narrowing fight.
const classifyIdempotencyRequestMock: ReturnType<typeof vi.fn> = vi.fn(
  async (): Promise<Record<string, unknown>> => ({ kind: 'first' }),
);
// Named + overridable so the 503 reservation-outage branch can force `ok:false`.
const reserveIdempotencyRecordMock: ReturnType<typeof vi.fn> = vi.fn(
  async (): Promise<Record<string, unknown>> => ({
    ok: true,
    value: { kind: 'reserved' as const },
  }),
);

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildEraseMemberDeps: (...args: unknown[]) => buildEraseMemberDepsMock(...args),
}));
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    eraseMember: (...args: unknown[]) => eraseMemberMock(...args),
  };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/idempotency', () => ({
  parseIdempotencyKey: (headers: Headers) => {
    const key = headers.get('idempotency-key');
    if (!key) return { ok: false, reason: 'missing' };
    return { ok: true, key };
  },
  classifyIdempotencyRequest: (...args: unknown[]) =>
    classifyIdempotencyRequestMock(...args),
  reserveIdempotencyRecord: (...args: unknown[]) =>
    reserveIdempotencyRecordMock(...args),
  rememberIdempotentResponse: vi.fn(async () => undefined),
  hashRequestBody: vi.fn(() => 'hash'),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

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
  requestId: 'req-1',
};

const MEMBER_ID = '11111111-1111-4111-8111-111111111111';

function makeRequest(
  body: unknown,
  headers: Record<string, string> = { 'idempotency-key': 'idem-1' },
): NextRequest {
  const path = `/api/members/${MEMBER_ID}/erase`;
  if (body === undefined) {
    return new NextRequest(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
    });
  }
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  reason: 'gdpr_erasure_request',
  identityVerified: true,
  verificationMethod: 'in_person',
  note: 'DPO-2026-014',
};

const erasedAt = new Date('2026-06-19T00:00:00Z');

describe('contract: POST /api/members/[memberId]/erase (COMP-1 US3-A)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    classifyIdempotencyRequestMock.mockResolvedValue({ kind: 'first' });
    reserveIdempotencyRecordMock.mockResolvedValue({
      ok: true,
      value: { kind: 'reserved' as const },
    });
  });

  async function invoke(
    body: unknown,
    headers?: Record<string, string>,
  ) {
    const { POST } = await import('@/app/api/members/[memberId]/erase/route');
    return POST(makeRequest(body, headers), {
      params: Promise.resolve({ memberId: MEMBER_ID }),
    });
  }

  it('200 happy path — erase succeeds, attestation forwarded to eraseMember', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildEraseMemberDepsMock.mockReturnValueOnce({});
    eraseMemberMock.mockResolvedValueOnce(
      ok({ memberId: MEMBER_ID, erasedAt, cascadesComplete: true }),
    );

    const res = await invoke(VALID_BODY);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      memberId: MEMBER_ID,
      erasedAt: erasedAt.toISOString(),
      cascadesComplete: true,
    });
    expect(eraseMemberMock).toHaveBeenCalledTimes(1);
    expect(eraseMemberMock.mock.calls[0]![1]).toMatchObject({
      reason: 'gdpr_erasure_request',
      identityVerified: true,
      verificationMethod: 'in_person',
      note: 'DPO-2026-014',
    });
  });

  it('200 cascadesComplete:false is still 200', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildEraseMemberDepsMock.mockReturnValueOnce({});
    eraseMemberMock.mockResolvedValueOnce(
      ok({ memberId: MEMBER_ID, erasedAt, cascadesComplete: false }),
    );

    const res = await invoke(VALID_BODY);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cascadesComplete).toBe(false);
  });

  it('401 no session — eraseMember not called', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'no-session' }), {
        status: 401,
      }),
    });

    const res = await invoke(VALID_BODY);

    expect(res.status).toBe(401);
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('403 manager — eraseMember not called', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
      }),
    });

    const res = await invoke(VALID_BODY);

    expect(res.status).toBe(403);
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body — reason missing, eraseMember not called', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);

    const res = await invoke({
      identityVerified: true,
      verificationMethod: 'in_person',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body — identityVerified:false cannot bypass attestation', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);

    const res = await invoke({ ...VALID_BODY, identityVerified: false });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body — identityVerified absent', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);

    const res = await invoke({
      reason: 'gdpr_erasure_request',
      verificationMethod: 'in_person',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body — unknown verificationMethod', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);

    const res = await invoke({ ...VALID_BODY, verificationMethod: 'telepathy' });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body — note > 500 chars', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);

    const res = await invoke({ ...VALID_BODY, note: 'x'.repeat(501) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('400 missing_idempotency_key', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);

    const res = await invoke(VALID_BODY, {});

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('missing_idempotency_key');
  });

  it('404 not_found — cross-tenant or missing member', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildEraseMemberDepsMock.mockReturnValueOnce({});
    eraseMemberMock.mockResolvedValueOnce(err({ type: 'not_found' }));

    const res = await invoke(VALID_BODY);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
  });

  it('500 server_error on unexpected failure', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildEraseMemberDepsMock.mockReturnValueOnce({});
    eraseMemberMock.mockResolvedValueOnce(
      err({ type: 'server_error', message: 'boom' }),
    );

    const res = await invoke(VALID_BODY);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('server_error');
  });

  it('409 idempotency_conflict — eraseMember not called', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    classifyIdempotencyRequestMock.mockResolvedValueOnce({ kind: 'conflict' });

    const res = await invoke(VALID_BODY);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('idempotency_conflict');
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('200 replay — returns previous response, eraseMember not called', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    classifyIdempotencyRequestMock.mockResolvedValueOnce({
      kind: 'replay',
      previousResponse: {
        status: 200,
        body: {
          memberId: MEMBER_ID,
          erasedAt: erasedAt.toISOString(),
          cascadesComplete: true,
        },
      },
    });

    const res = await invoke(VALID_BODY);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memberId).toBe(MEMBER_ID);
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('503 idempotency_reservation_failed — Upstash outage, eraseMember not called', async () => {
    // Destructive GDPR surface: a reservation outage MUST fail closed (503 +
    // Retry-After) and NOT fall through to an unprotected erase. (speckit tests #1)
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    reserveIdempotencyRecordMock.mockResolvedValueOnce({ ok: false });

    const res = await invoke(VALID_BODY);

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    const body = await res.json();
    expect(body.error.code).toBe('idempotency_reservation_failed');
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body — malformed JSON body, eraseMember not called', async () => {
    // The route's `JSON.parse` try/catch → 400 path (distinct from the schema
    // 400 path). The header docstring lists malformed JSON as a 400 trigger. (#2)
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { POST } = await import('@/app/api/members/[memberId]/erase/route');
    const req = new NextRequest(
      `http://localhost/api/members/${MEMBER_ID}/erase`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'idem-malformed',
        },
        body: '{ not valid json',
      },
    );

    const res = await POST(req, {
      params: Promise.resolve({ memberId: MEMBER_ID }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
    expect(body.error.message).toMatch(/valid JSON/i);
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('404 not_found — non-UUID memberId param, eraseMember not called', async () => {
    // The route's `paramsSchema` (uuid) rejects a tampered/non-UUID path param
    // BEFORE any body/idempotency work — a reachable HTTP branch (direct API
    // call with a bad id), distinct from the use-case `not_found` (a real but
    // missing/cross-tenant member).
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { POST } = await import('@/app/api/members/[memberId]/erase/route');

    const res = await POST(makeRequest(VALID_BODY), {
      params: Promise.resolve({ memberId: 'not-a-uuid' }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });
});

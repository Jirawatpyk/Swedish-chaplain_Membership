/**
 * Round-2 review I-10: Contract test for PATCH /api/members/[memberId]/inline-edit.
 *
 * Covers:
 *   - 200 happy path
 *   - 400 invalid_body (non-whitelisted field)
 *   - 400 validation_error (invalid status value)
 *   - 404 not_found
 *   - 404 invalid UUID format
 *   - 403 non-admin rejected (FR-042)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const inlineEditMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: vi.fn(() => ({
    tenant: { slug: 'test' },
    memberRepo: {},
    audit: {},
    clock: { now: () => new Date() },
  })),
}));
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    inlineEdit: (...args: unknown[]) => inlineEditMock(...args),
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
  classifyIdempotencyRequest: vi.fn(async () => ({ kind: 'first' })),
  reserveIdempotencyRecord: vi.fn(async () => undefined),
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
  requestId: 'req-ie',
};

const managerForbiddenContext = {
  response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
};

const memberForbiddenContext = {
  response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
};

const validMemberId = '11111111-2222-3333-4444-555555555555';

const stubMember = {
  tenantId: 'test',
  memberId: validMemberId,
  companyName: 'X',
  legalEntityType: null,
  country: 'TH',
  taxId: null,
  website: null,
  description: null,
  foundedYear: null,
  turnoverThb: null,
  planId: 'plan-1',
  planYear: 2026,
  registrationDate: new Date('2026-01-01'),
  registrationFeePaid: false,
  lastActivityAt: null,
  notes: null,
  status: 'inactive' as const,
  archivedAt: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-16'),
};

function makeRequest(
  body: unknown,
  memberId: string = validMemberId,
): NextRequest {
  return new NextRequest(`http://localhost/api/members/${memberId}/inline-edit`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const routeParams = (memberId: string = validMemberId) =>
  async () => ({ memberId });

describe('contract: PATCH /api/members/[memberId]/inline-edit (round-2 review I-10)', () => {
  afterEach(() => vi.clearAllMocks());

  it('200 on status change — happy path', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    inlineEditMock.mockResolvedValueOnce(ok(stubMember));
    const { PATCH } = await import('@/app/api/members/[memberId]/inline-edit/route');
    const res = await PATCH(
      makeRequest({ field: 'status', value: 'inactive' }),
      { params: routeParams()() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('inactive');
  });

  it('400 invalid_body on non-whitelisted field', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    inlineEditMock.mockResolvedValueOnce(
      err({
        type: 'invalid_body',
        issues: [{ path: 'field', message: 'invalid' }],
      }),
    );
    const { PATCH } = await import('@/app/api/members/[memberId]/inline-edit/route');
    const res = await PATCH(
      makeRequest({ field: 'plan_id', value: 'x' }),
      { params: routeParams()() },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
  });

  it('400 validation_error on invalid field value', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    inlineEditMock.mockResolvedValueOnce(
      err({
        type: 'invalid_field_value',
        field: 'status',
        reason: 'Cannot set to archived via inline edit',
      }),
    );
    const { PATCH } = await import('@/app/api/members/[memberId]/inline-edit/route');
    const res = await PATCH(
      makeRequest({ field: 'status', value: 'archived' }),
      { params: routeParams()() },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
  });

  it('404 on not_found', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    inlineEditMock.mockResolvedValueOnce(err({ type: 'not_found' }));
    const { PATCH } = await import('@/app/api/members/[memberId]/inline-edit/route');
    const res = await PATCH(
      makeRequest({ field: 'status', value: 'inactive' }),
      { params: routeParams()() },
    );
    expect(res.status).toBe(404);
  });

  it('404 on invalid UUID format (short-circuits before use case)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { PATCH } = await import('@/app/api/members/[memberId]/inline-edit/route');
    const res = await PATCH(
      makeRequest({ field: 'status', value: 'inactive' }, 'not-a-uuid'),
      { params: routeParams('not-a-uuid')() },
    );
    expect(res.status).toBe(404);
    // Use case MUST NOT have been called
    expect(inlineEditMock).not.toHaveBeenCalled();
  });

  it('403 manager rejected (FR-042 RBAC separation)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(managerForbiddenContext);
    const { PATCH } = await import('@/app/api/members/[memberId]/inline-edit/route');
    const res = await PATCH(
      makeRequest({ field: 'status', value: 'inactive' }),
      { params: routeParams()() },
    );
    expect(res.status).toBe(403);
    expect(inlineEditMock).not.toHaveBeenCalled();
  });

  it('403 member rejected (FR-042 RBAC separation)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(memberForbiddenContext);
    const { PATCH } = await import('@/app/api/members/[memberId]/inline-edit/route');
    const res = await PATCH(
      makeRequest({ field: 'status', value: 'inactive' }),
      { params: routeParams()() },
    );
    expect(res.status).toBe(403);
  });

  it('409 state_error when archived member status change attempted', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    inlineEditMock.mockResolvedValueOnce(
      err({ type: 'state_error', code: 'state.undelete_only_from_archived' }),
    );
    const { PATCH } = await import('@/app/api/members/[memberId]/inline-edit/route');
    const res = await PATCH(
      makeRequest({ field: 'status', value: 'active' }),
      { params: routeParams()() },
    );
    expect(res.status).toBe(409);
  });

  it('400 on malformed JSON body (round-2 review I-3)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const req = new NextRequest(`http://localhost/api/members/${validMemberId}/inline-edit`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{ not valid json',
    });
    const { PATCH } = await import('@/app/api/members/[memberId]/inline-edit/route');
    const res = await PATCH(req, { params: routeParams()() });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
  });
});

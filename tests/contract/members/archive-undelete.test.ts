/**
 * T134 — Contract test: POST /api/members/[memberId]/archive +
 * POST /api/members/[memberId]/undelete (US7).
 *
 * Mocks the admin-context, idempotency helpers, tenant resolver, and the
 * `archiveMember` + `undeleteMember` use cases so the handlers run
 * without touching the real DB / session. Asserts response shape +
 * HTTP status for each branch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireApiPermissionMock = vi.fn();
const archiveMemberMock = vi.fn();
const undeleteMemberMock = vi.fn();
const buildMembersDepsMock = vi.fn();

vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: (...args: unknown[]) => buildMembersDepsMock(...args),
}));
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    archiveMember: (...args: unknown[]) => archiveMemberMock(...args),
    undeleteMember: (...args: unknown[]) => undeleteMemberMock(...args),
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
  classifyIdempotencyRequest: vi.fn(async () => ({ kind: 'first' })),
  reserveIdempotencyRecord: vi.fn(async () => ({ ok: true, value: { kind: 'reserved' as const } })),
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
  path: string,
  body: unknown,
  headers: Record<string, string> = { 'idempotency-key': 'idem-1' },
): NextRequest {
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

const archivedMember = {
  tenantId: 'test-swecham',
  memberId: MEMBER_ID,
  companyName: 'Fogmaker International',
  legalEntityType: null,
  country: 'SE',
  taxId: null,
  website: null,
  description: null,
  foundedYear: null,
  turnoverThb: null,
  planId: 'premium',
  planYear: 2026,
  registrationDate: new Date('2026-01-01'),
  registrationFeePaid: false,
  lastActivityAt: new Date('2026-04-01'),
  notes: null,
  status: 'archived' as const,
  archivedAt: new Date('2026-04-10'),
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-04-10'),
};

const activeMember = { ...archivedMember, status: 'active' as const, archivedAt: null };

describe('contract: POST /api/members/[memberId]/archive (T134)', () => {
  afterEach(() => vi.clearAllMocks());

  async function invokeArchive(body: unknown, headers?: Record<string, string>) {
    const { POST } = await import(
      '@/app/api/members/[memberId]/archive/route'
    );
    return POST(makeRequest(`/api/members/${MEMBER_ID}/archive`, body, headers), {
      params: Promise.resolve({ memberId: MEMBER_ID }),
    });
  }

  it('200 happy path — archive succeeds', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    archiveMemberMock.mockResolvedValueOnce(ok(archivedMember));
    const res = await invokeArchive({ reason: 'Company closed' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('archived');
    expect(body.member_id).toBe(MEMBER_ID);
  });

  it('200 happy path without reason (empty body allowed)', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    archiveMemberMock.mockResolvedValueOnce(ok(archivedMember));
    const res = await invokeArchive({});
    expect(res.status).toBe(200);
  });

  it('400 missing Idempotency-Key', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    const res = await invokeArchive({}, {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('missing_idempotency_key');
  });

  it('400 invalid_body when zod rejects payload', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    archiveMemberMock.mockResolvedValueOnce(
      err({
        type: 'invalid_body',
        issues: [{ path: 'reason', message: 'Too long' }],
      }),
    );
    const res = await invokeArchive({ reason: 'x'.repeat(501) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
  });

  it('404 not_found — cross-tenant or missing member', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    archiveMemberMock.mockResolvedValueOnce(err({ type: 'not_found' }));
    const res = await invokeArchive({});
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
  });

  it('409 state_error — already archived', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    archiveMemberMock.mockResolvedValueOnce(
      err({
        type: 'state_error',
        code: 'state.cannot_archive_already_archived',
      }),
    );
    const res = await invokeArchive({});
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('state_error');
  });

  it('500 server_error on unexpected failure', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    archiveMemberMock.mockResolvedValueOnce(
      err({ type: 'server_error', message: 'boom' }),
    );
    const res = await invokeArchive({});
    expect(res.status).toBe(500);
  });
});

describe('contract: POST /api/members/[memberId]/undelete (T134)', () => {
  afterEach(() => vi.clearAllMocks());

  async function invokeUndelete(headers?: Record<string, string>) {
    const { POST } = await import(
      '@/app/api/members/[memberId]/undelete/route'
    );
    return POST(
      makeRequest(`/api/members/${MEMBER_ID}/undelete`, undefined, headers),
      { params: Promise.resolve({ memberId: MEMBER_ID }) },
    );
  }

  it('200 happy path — undelete succeeds', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    undeleteMemberMock.mockResolvedValueOnce(ok({ member: activeMember, designatedContactId: null }));
    const res = await invokeUndelete();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('active');
  });

  it('400 missing Idempotency-Key', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    const res = await invokeUndelete({});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('missing_idempotency_key');
  });

  it('403 archive_window_expired — > 90 days', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    undeleteMemberMock.mockResolvedValueOnce(
      err({
        type: 'state_error',
        code: 'state.undelete_window_expired',
        daysSinceArchive: 95,
      }),
    );
    const res = await invokeUndelete();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('archive_window_expired');
    expect(body.error.details.daysSinceArchive).toBe(95);
  });

  it('404 not_found', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    undeleteMemberMock.mockResolvedValueOnce(err({ type: 'not_found' }));
    const res = await invokeUndelete();
    expect(res.status).toBe(404);
  });

  it('409 state_error — not archived', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    undeleteMemberMock.mockResolvedValueOnce(
      err({
        type: 'state_error',
        code: 'state.undelete_only_from_archived',
      }),
    );
    const res = await invokeUndelete();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('state_error');
  });

  it('500 server_error', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    undeleteMemberMock.mockResolvedValueOnce(
      err({ type: 'server_error', message: 'boom' }),
    );
    const res = await invokeUndelete();
    expect(res.status).toBe(500);
  });

  // --- 108 T033 (US2 / FR-014) — designate a primary while unarchiving ------

  async function invokeUndeleteWithBody(
    body: unknown,
    headers: Record<string, string> = { 'idempotency-key': 'idem-1' },
  ) {
    const { POST } = await import(
      '@/app/api/members/[memberId]/undelete/route'
    );
    return POST(
      makeRequest(`/api/members/${MEMBER_ID}/undelete`, body, headers),
      { params: Promise.resolve({ memberId: MEMBER_ID }) },
    );
  }

  const CONTACT_A = '66666666-6666-4666-8666-666666666666';
  const CONTACT_B = '77777777-7777-4777-8777-777777777777';

  it('409 no_primary_contact — carries the designatable contacts for the dialog', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    undeleteMemberMock.mockResolvedValueOnce(
      err({
        type: 'state_error',
        code: 'no_primary_contact',
        designatable: [
          { contactId: CONTACT_A, firstName: 'Ann', lastName: 'Alpha' },
          { contactId: CONTACT_B, firstName: 'Bo', lastName: 'Beta' },
        ],
      }),
    );
    const res = await invokeUndelete();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('no_primary_contact');
    // The dialog cannot offer a choice it was not given; the shape is part of
    // the contract, not an implementation detail of the banner.
    expect(body.error.details.designatable).toEqual([
      { contact_id: CONTACT_A, first_name: 'Ann', last_name: 'Alpha' },
      { contact_id: CONTACT_B, first_name: 'Bo', last_name: 'Beta' },
    ]);
  });

  it('409 no_primary_contact with an empty list when the member has no live contacts', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    undeleteMemberMock.mockResolvedValueOnce(
      err({ type: 'state_error', code: 'no_primary_contact', designatable: [] }),
    );
    const res = await invokeUndelete();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.details.designatable).toEqual([]);
  });

  it('200 — forwards designate_primary_contact_id to the use case', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    undeleteMemberMock.mockResolvedValueOnce(ok({ member: activeMember, designatedContactId: null }));
    const res = await invokeUndeleteWithBody({
      designate_primary_contact_id: CONTACT_B,
    });
    expect(res.status).toBe(200);
    expect(undeleteMemberMock).toHaveBeenCalledWith(
      MEMBER_ID,
      expect.objectContaining({ actorUserId: 'admin-1' }),
      expect.anything(),
      { designatePrimaryContactId: CONTACT_B },
    );
  });

  it('400 when designate_primary_contact_id is not a uuid', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    const res = await invokeUndeleteWithBody({
      designate_primary_contact_id: 'not-a-uuid',
    });
    expect(res.status).toBe(400);
    expect(undeleteMemberMock).not.toHaveBeenCalled();
  });

  it('the idempotency body hash covers the designation, so two designations do not collide', async () => {
    const { hashRequestBody } = await import('@/lib/idempotency');
    const hashMock = vi.mocked(hashRequestBody);
    hashMock.mockClear();

    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    undeleteMemberMock.mockResolvedValueOnce(ok({ member: activeMember, designatedContactId: null }));
    await invokeUndeleteWithBody({ designate_primary_contact_id: CONTACT_A });

    // A hash computed over `{}` would make "restore designating A" and
    // "restore designating B" the same request under one Idempotency-Key —
    // the second would replay the first's response having designated nobody.
    expect(hashMock).toHaveBeenCalledWith(
      { designate_primary_contact_id: CONTACT_A },
      expect.stringContaining('/undelete'),
    );
  });

  // --- T041 review round 1 -------------------------------------------------

  it('409 no_primary_contact IS remembered under the key (security M2): the key is already reserved', async () => {
    // `reserveIdempotencyRecord` has already written the key. Not remembering
    // the response leaves `response: null`, so a replay with the same key gets
    // `idempotency_conflict` — the opposite of what "not remembered" claimed.
    // The 409 is non-mutating and safe to replay; a NEW designation is a NEW
    // key (the UI mints one per click).
    const { rememberIdempotentResponse } = await import('@/lib/idempotency');
    const remember = vi.mocked(rememberIdempotentResponse);
    remember.mockClear();
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    undeleteMemberMock.mockResolvedValueOnce(
      err({ type: 'state_error', code: 'no_primary_contact', designatable: [] }),
    );
    const res = await invokeUndelete();
    expect(res.status).toBe(409);
    expect(remember).toHaveBeenCalledWith(
      expect.anything(),
      'idem-1',
      expect.anything(),
      expect.objectContaining({ status: 409 }),
    );
  });

  it('409 designatable entries carry the email (UX M5)', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    undeleteMemberMock.mockResolvedValueOnce(
      err({
        type: 'state_error',
        code: 'no_primary_contact',
        designatable: [
          { contactId: CONTACT_A, firstName: 'Ann', lastName: 'Alpha', email: 'ann@example.com' },
        ],
      }),
    );
    const res = await invokeUndelete();
    const body = await res.json();
    expect(body.error.details.designatable).toEqual([
      { contact_id: CONTACT_A, first_name: 'Ann', last_name: 'Alpha', email: 'ann@example.com' },
    ]);
  });

  it('200 body names the designated contact, or null when none was needed (reliability L4c)', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    undeleteMemberMock.mockResolvedValueOnce(
      ok({ member: activeMember, designatedContactId: CONTACT_B }),
    );
    const res = await invokeUndeleteWithBody({ designate_primary_contact_id: CONTACT_B });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('active');
    expect(body.designated_primary_contact_id).toBe(CONTACT_B);

    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    undeleteMemberMock.mockResolvedValueOnce(
      ok({ member: activeMember, designatedContactId: null }),
    );
    const res2 = await invokeUndelete();
    const body2 = await res2.json();
    expect(body2.designated_primary_contact_id).toBeNull();
  });

  it('409 state_error undelete_erased for an erased member (reliability L5)', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    undeleteMemberMock.mockResolvedValueOnce(
      err({ type: 'state_error', code: 'undelete_erased' }),
    );
    const res = await invokeUndelete();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('state_error');
    expect(body.error.details.code).toBe('undelete_erased');
  });

  it('200 — super_admin may designate and restore', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({
      ...adminContext,
      current: {
        ...adminContext.current,
        user: { ...adminContext.current.user, id: 'super-1', role: 'super_admin' },
      },
    });
    buildMembersDepsMock.mockReturnValueOnce({});
    undeleteMemberMock.mockResolvedValueOnce(ok({ member: activeMember, designatedContactId: null }));
    const res = await invokeUndeleteWithBody({
      designate_primary_contact_id: CONTACT_A,
    });
    expect(res.status).toBe(200);
    expect(undeleteMemberMock).toHaveBeenCalledWith(
      MEMBER_ID,
      expect.objectContaining({ actorUserId: 'super-1' }),
      expect.anything(),
      { designatePrimaryContactId: CONTACT_A },
    );
  });
});

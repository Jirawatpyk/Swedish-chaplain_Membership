/**
 * Contract test: GET /api/members/[memberId]
 *
 * Mocks all dependencies. Verifies every HTTP response branch:
 *   - 200 on successful fetch (member + contacts serialised)
 *   - 401 when admin-context gate returns a short-circuit response
 *   - 404 when memberId is not a valid UUID
 *   - 404 when use case reports not_found (incl. cross-tenant probe)
 *   - 500 when use case reports server_error
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

// ---------------------------------------------------------------------------
// Hoist mocks
// ---------------------------------------------------------------------------

const requireApiPermissionMock = vi.fn();
const getMemberMock = vi.fn();
const buildMembersDepsMock = vi.fn(() => ({
  contactRepo: {},
  tokens: {},
  emails: {},
  clock: { now: () => new Date() },
}));

/**
 * Post-remediation re-review B — the leg this suite runs `canPerform` on.
 * Mutable so individual tests can pin the ON leg; reset in `afterEach`.
 */
const rbacLeg = { v2: false };

vi.mock('@/lib/rbac', async () => {
  // 016 re-review finding B — the earlier factory exported ONLY
  // `requireApiPermission`, which left `canPerform` as `undefined` in the
  // route module. Every test passed because none exercised the DoB arm (the
  // short-circuit on `include !== 'date_of_birth'` never reached the call),
  // so the one PII egress decision this route makes had no net at all — and
  // any test that DID reach it would have crashed on the mock instead of
  // asserting anything. `canPerform` now delegates to the REAL pure-Domain
  // evaluator (same pattern as palette-search.test.ts), keeping the role
  // semantics under test on both legs via `rbacLeg`.
  const { hasPermission } = await vi.importActual<
    typeof import('@/modules/auth/domain/permissions/evaluator')
  >('@/modules/auth/domain/permissions/evaluator');
  return {
    requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
    canPerform: (role: unknown, key: unknown, legacy: unknown) =>
      hasPermission(role as never, key as never, {
        rbacV2: rbacLeg.v2,
        legacy: legacy as never,
      }),
  };
});

vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: buildMembersDepsMock,
}));

vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    getMember: getMemberMock,
  };
});

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const adminContext = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-1',
};

const MEMBER_ID = '11111111-1111-1111-1111-111111111111';

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3100/api/members/${MEMBER_ID}`,
    { method: 'GET' },
  );
}

const routeParams = Promise.resolve({ memberId: MEMBER_ID });

const MEMBER_FIXTURE = {
  member: {
    memberId: MEMBER_ID,
    memberNumber: 42,
    tenantId: 'test-swecham',
    companyName: 'Fogmaker AB',
    legalEntityType: 'limited',
    country: 'SE',
    taxId: null,
    website: null,
    description: null,
    foundedYear: null,
    turnoverThb: null,
    planId: 'plan-1',
    planYear: 2026,
    registrationDate: new Date('2026-01-15'),
    registrationFeePaid: true,
    status: 'active',
    archivedAt: null,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastActivityAt: null,
  },
  contacts: [
    {
      contactId: 'c1',
      memberId: MEMBER_ID,
      tenantId: 'test-swecham',
      firstName: 'Anna',
      lastName: 'Svensson',
      email: 'anna@fogmaker.se',
      phone: null,
      roleTitle: 'CEO',
      preferredLanguage: 'sv',
      isPrimary: true,
      dateOfBirth: null,
      linkedUserId: null,
      removedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contract: GET /api/members/[memberId]', () => {
  afterEach(() => {
    vi.clearAllMocks();
    rbacLeg.v2 = false;
  });

  it('200 — returns serialised member with contacts on success', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    getMemberMock.mockResolvedValueOnce(ok(MEMBER_FIXTURE));

    const { GET } = await import('@/app/api/members/[memberId]/route');
    const res = await GET(makeRequest(), { params: routeParams });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.member_id).toBe(MEMBER_ID);
    // Human-readable display id — MUST be present in the admin payload
    // (design §8.3: serializer divergence already bit tax_id once).
    expect(body.member_number).toBe(42);
    expect(body.contacts).toHaveLength(1);
    expect(body.contacts[0].first_name).toBe('Anna');
  });

  it('401 — admin-context gate short-circuits before reaching use case', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({
      response: NextResponse.json(
        { error: { code: 'unauthenticated', message: 'Not signed in.' } },
        { status: 401 },
      ),
    });

    const { GET } = await import('@/app/api/members/[memberId]/route');
    const res = await GET(makeRequest(), { params: routeParams });

    expect(res.status).toBe(401);
    expect(getMemberMock).not.toHaveBeenCalled();
  });

  it('404 — invalid UUID memberId param', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);

    const { GET } = await import('@/app/api/members/[memberId]/route');
    const res = await GET(
      new NextRequest('http://localhost:3100/api/members/not-a-uuid', { method: 'GET' }),
      { params: Promise.resolve({ memberId: 'not-a-uuid' }) },
    );

    expect(res.status).toBe(404);
    expect(getMemberMock).not.toHaveBeenCalled();
  });

  it('404 — use case reports not_found (cross-tenant probe)', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    getMemberMock.mockResolvedValueOnce(err({ type: 'not_found' }));

    const { GET } = await import('@/app/api/members/[memberId]/route');
    const res = await GET(makeRequest(), { params: routeParams });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
  });

  it('500 — use case reports server_error', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    getMemberMock.mockResolvedValueOnce(
      err({ type: 'server_error', message: 'db timeout' }),
    );

    const { GET } = await import('@/app/api/members/[memberId]/route');
    const res = await GET(makeRequest(), { params: routeParams });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('server_error');
  });

  /**
   * 016 re-review B — the DoB projection is the one PII egress decision this
   * route makes, PR 2 rewrote it (row `legacySessionOnly` → `legacyAdminOnly`,
   * conjunct dropped), and until now no test reached it on either leg. These
   * pins use the REAL evaluator (see the rbac mock above), so a future row
   * swap back to `legacySessionOnly` — which would hand every contact's date
   * of birth to manager on the OFF leg — goes red here instead of shipping.
   */
  describe('016 DoB projection (members.pii_sensitive sub-gate)', () => {
    const DOB_FIXTURE = {
      ...MEMBER_FIXTURE,
      contacts: [
        {
          ...MEMBER_FIXTURE.contacts[0]!,
          dateOfBirth: new Date('1980-04-01T00:00:00Z'),
        },
      ],
    };

    function makeDobRequest(): NextRequest {
      return new NextRequest(
        `http://localhost:3100/api/members/${MEMBER_ID}?include=date_of_birth`,
        { method: 'GET' },
      );
    }

    function contextFor(role: string) {
      return {
        ...adminContext,
        current: {
          ...adminContext.current,
          user: { ...adminContext.current.user, role },
        },
      };
    }

    async function dobRequestAs(role: string, leg: 'off' | 'on') {
      rbacLeg.v2 = leg === 'on';
      requireApiPermissionMock.mockResolvedValueOnce(contextFor(role));
      getMemberMock.mockResolvedValueOnce(ok(DOB_FIXTURE));
      const { GET } = await import('@/app/api/members/[memberId]/route');
      const res = await GET(makeDobRequest(), {
        params: Promise.resolve({ memberId: MEMBER_ID }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      return body.contacts[0] as Record<string, unknown>;
    }

    it('OFF leg — admin receives date_of_birth', async () => {
      const contact = await dobRequestAs('admin', 'off');
      expect(contact.date_of_birth).toBe('1980-04-01');
    });

    it('OFF leg — super_admin receives date_of_birth (D16 totalisation)', async () => {
      const contact = await dobRequestAs('super_admin', 'off');
      expect(contact.date_of_birth).toBe('1980-04-01');
    });

    it('OFF leg — manager does NOT receive the field (legacyAdminOnly row)', async () => {
      const contact = await dobRequestAs('manager', 'off');
      expect('date_of_birth' in contact).toBe(false);
    });

    it('ON leg — super_admin receives date_of_birth (E1 bypass)', async () => {
      const contact = await dobRequestAs('super_admin', 'on');
      expect(contact.date_of_birth).toBe('1980-04-01');
    });

    it('ON leg — manager is stripped (bundle lacks members.pii_sensitive)', async () => {
      const contact = await dobRequestAs('manager', 'on');
      expect('date_of_birth' in contact).toBe(false);
    });

    it('ON leg — marketing is stripped (US3/T057 single-member read)', async () => {
      const contact = await dobRequestAs('marketing', 'on');
      expect('date_of_birth' in contact).toBe(false);
    });

    it('without ?include=date_of_birth the field is absent even for admin', async () => {
      requireApiPermissionMock.mockResolvedValueOnce(contextFor('admin'));
      getMemberMock.mockResolvedValueOnce(ok(DOB_FIXTURE));
      const { GET } = await import('@/app/api/members/[memberId]/route');
      const res = await GET(makeRequest(), { params: routeParams });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect('date_of_birth' in body.contacts[0]).toBe(false);
    });
  });
});

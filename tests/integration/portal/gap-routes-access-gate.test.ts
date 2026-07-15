/**
 * 059-membership-suspension Task 7b — closes the 3-route gap Task 7 left
 * tracked in `scripts/lib/portal-guard-core.ts`.
 *
 * `timeline`, `directory`, and `directory/logo` each resolve their member via
 * a bespoke `requireSession`/`getCurrentSession` + `findByLinkedUserId` lookup
 * instead of `requireMemberContext` (`src/lib/member-context.ts`), so they
 * never inherited that helper's `checkPortalAccess` enforcement — a
 * terminated member could still reach them. Task 7b wires `checkPortalAccess`
 * DIRECTLY into each route (same `buildPortalAccessDeps` composition, same
 * ctx shape, same fail-open-on-DB-error behaviour as `requireMemberContext`).
 *
 * This suite drives the REAL exported route handlers (not just the gate
 * function in isolation) against real Postgres rows, mirroring
 * `require-member-context-access-gate.test.ts` (Task 7): a `terminated`
 * member (lapsed cycle, `expiresAt` in the past) must get 403
 * `membership_access_restricted`; a `full`-access member (no renewal cycle
 * row) must pass the gate unaffected.
 *
 * Mocked: `@/lib/auth-session` (session lookup needs a real Next.js request
 * scope this test doesn't have) and the downstream USE-CASE calls each route
 * makes AFTER the gate (`timelineList`, `updateDirectoryListing`,
 * `setDirectoryLogo`, `removeDirectoryLogo`) — those have their own dedicated
 * test suites elsewhere; this file's job is exclusively to prove the NEW
 * `checkPortalAccess` wiring blocks/allows correctly. Everything the gate
 * itself touches (member resolution via `findByLinkedUserId`,
 * `checkPortalAccess` → `deriveMembershipAccess` →
 * `findLatestCycleForMember`, audit emit) runs against live Neon.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { ok } from '@/lib/result';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const requireSessionMock = vi.fn();
const getCurrentSessionMock = vi.fn();
vi.mock('@/lib/auth-session', () => ({
  requireSession: (...a: unknown[]) => requireSessionMock(...a),
  getCurrentSession: (...a: unknown[]) => getCurrentSessionMock(...a),
}));

const timelineListMock = vi.hoisted(() => vi.fn());
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>('@/modules/members');
  return { ...actual, timelineList: (...a: unknown[]) => timelineListMock(...a) };
});

const updateDirectoryListingMock = vi.hoisted(() => vi.fn());
const setDirectoryLogoMock = vi.hoisted(() => vi.fn());
const removeDirectoryLogoMock = vi.hoisted(() => vi.fn());
vi.mock('@/modules/insights', async () => {
  const actual = await vi.importActual<typeof import('@/modules/insights')>('@/modules/insights');
  return {
    ...actual,
    updateDirectoryListing: (...a: unknown[]) => updateDirectoryListingMock(...a),
    setDirectoryLogo: (...a: unknown[]) => setDirectoryLogoMock(...a),
    removeDirectoryLogo: (...a: unknown[]) => removeDirectoryLogoMock(...a),
  };
});

function sessionFor(userId: string): { user: { id: string; role: 'member' }; session: { id: string } } {
  return { user: { id: userId, role: 'member' }, session: { id: 'test-session' } };
}

function makeRequest(
  tenantSlug: string,
  pathname: string,
  init?: { method?: string; body?: unknown },
): NextRequest {
  return new NextRequest(`http://localhost:3100${pathname}`, {
    method: init?.method ?? 'GET',
    headers: {
      'x-tenant': tenantSlug,
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

let tenant: TestTenant;
let seedUser: TestUser;
let terminatedUser: TestUser;
let fullAccessUser: TestUser;

const terminatedMemberId = randomUUID();
const terminatedCycleId = randomUUID();
const fullAccessMemberId = randomUUID();
const planId = `t7b-gap-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  seedUser = await createActiveTestUser('admin');
  terminatedUser = await createActiveTestUser('member');
  fullAccessUser = await createActiveTestUser('member');
  tenant = await createTestTenant('test-swecham');

  await runInTenant(tenant.ctx, (tx) =>
    seedF8MembershipPlan(tx, {
      tenantSlug: tenant.ctx.slug,
      planId,
      planName: { en: 'Task 7b Gap Plan' },
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      createdBy: seedUser.userId,
    }),
  );

  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(members).values([
      {
        tenantId: tenant.ctx.slug,
        memberId: terminatedMemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Terminated Gap Co',
        country: 'TH',
        planId,
        planYear: 2026,
      },
      {
        tenantId: tenant.ctx.slug,
        memberId: fullAccessMemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Full Access Gap Co',
        country: 'TH',
        planId,
        planYear: 2026,
      },
    ]),
  );

  // findByLinkedUserId INNER JOINs contacts on linked_user_id — each member
  // needs a contact linked to its own real user row.
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(contacts).values([
      {
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId: terminatedMemberId,
        firstName: 'Terminated',
        lastName: 'Gap',
        email: `terminated-gap-${randomUUID().slice(0, 8)}@example.com`,
        phone: null,
        roleTitle: null,
        preferredLanguage: 'en',
        isPrimary: true,
        dateOfBirth: null,
        linkedUserId: terminatedUser.userId,
        removedAt: null,
      },
      {
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId: fullAccessMemberId,
        firstName: 'Full',
        lastName: 'Gap',
        email: `full-gap-${randomUUID().slice(0, 8)}@example.com`,
        phone: null,
        roleTitle: null,
        preferredLanguage: 'en',
        isPrimary: true,
        dateOfBirth: null,
        linkedUserId: fullAccessUser.userId,
        removedAt: null,
      },
    ]),
  );

  // Terminated cycle: `lapsed` + `expiresAt` in the past → deriveMembershipAccess
  // classifies `terminated`. fullAccessMemberId deliberately has NO cycle row.
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(renewalCycles).values({
      tenantId: tenant.ctx.slug,
      cycleId: terminatedCycleId,
      memberId: terminatedMemberId,
      status: 'lapsed',
      periodFrom: new Date('2019-01-01T00:00:00Z'),
      periodTo: new Date('2020-01-01T00:00:00Z'),
      expiresAt: new Date('2020-01-01T00:00:00Z'),
      closedAt: new Date('2020-02-01T00:00:00Z'),
      closedReason: 'lapsed',
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: randomUUID(),
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
    }),
  );
}, 120_000);

afterAll(async () => {
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)).catch(() => {});
  await tenant.cleanup().catch(() => {});
  await deleteTestUser(seedUser).catch(() => {});
  await deleteTestUser(terminatedUser).catch(() => {});
  await deleteTestUser(fullAccessUser).catch(() => {});
  vi.restoreAllMocks();
}, 120_000);

beforeEach(() => {
  requireSessionMock.mockReset();
  getCurrentSessionMock.mockReset();
  timelineListMock.mockReset();
  updateDirectoryListingMock.mockReset();
  setDirectoryLogoMock.mockReset();
  removeDirectoryLogoMock.mockReset();
  timelineListMock.mockResolvedValue(ok({ events: [], nextCursor: null, total: 0 }));
  updateDirectoryListingMock.mockResolvedValue(ok(undefined));
  setDirectoryLogoMock.mockResolvedValue(ok({ logoUrl: 'https://example.test/logo.png' }));
  removeDirectoryLogoMock.mockResolvedValue(ok(undefined));
});

describe('GET /api/portal/timeline — checkPortalAccess wiring (Task 7b, live Neon)', () => {
  it('terminated member → 403 membership_access_restricted', async () => {
    requireSessionMock.mockResolvedValue(sessionFor(terminatedUser.userId));
    const { GET } = await import('@/app/api/portal/timeline/route');
    const res = await GET(makeRequest(tenant.ctx.slug, '/api/portal/timeline'));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('membership_access_restricted');
    expect(timelineListMock).not.toHaveBeenCalled();
  });

  it('full-access member (no cycle) → NOT blocked by the gate', async () => {
    requireSessionMock.mockResolvedValue(sessionFor(fullAccessUser.userId));
    const { GET } = await import('@/app/api/portal/timeline/route');
    const res = await GET(makeRequest(tenant.ctx.slug, '/api/portal/timeline'));
    expect(res.status).toBe(200);
    expect(timelineListMock).toHaveBeenCalledTimes(1);
  });

  it('terminated member + blocked request → emits lapsed_member_action_blocked audit', async () => {
    requireSessionMock.mockResolvedValue(sessionFor(terminatedUser.userId));
    const { GET } = await import('@/app/api/portal/timeline/route');
    await GET(makeRequest(tenant.ctx.slug, '/api/portal/timeline'));

    const rows = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug));
    const blocked = rows.filter((r) => (r.eventType as string) === 'lapsed_member_action_blocked');
    expect(blocked.length).toBeGreaterThan(0);
  });
});

describe('POST /api/portal/directory — checkPortalAccess wiring (Task 7b, live Neon)', () => {
  it('terminated member → 403 membership_access_restricted', async () => {
    getCurrentSessionMock.mockResolvedValue(sessionFor(terminatedUser.userId));
    const { POST } = await import('@/app/api/portal/directory/route');
    const res = await POST(
      makeRequest(tenant.ctx.slug, '/api/portal/directory', {
        method: 'POST',
        body: { listed: true },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('membership_access_restricted');
    expect(updateDirectoryListingMock).not.toHaveBeenCalled();
  });

  it('full-access member (no cycle) → NOT blocked by the gate', async () => {
    getCurrentSessionMock.mockResolvedValue(sessionFor(fullAccessUser.userId));
    const { POST } = await import('@/app/api/portal/directory/route');
    const res = await POST(
      makeRequest(tenant.ctx.slug, '/api/portal/directory', {
        method: 'POST',
        body: { listed: true },
      }),
    );
    expect(res.status).toBe(200);
    expect(updateDirectoryListingMock).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/portal/directory/logo — checkPortalAccess wiring (Task 7b, live Neon)', () => {
  it('terminated member → 403 membership_access_restricted', async () => {
    getCurrentSessionMock.mockResolvedValue(sessionFor(terminatedUser.userId));
    const { DELETE } = await import('@/app/api/portal/directory/logo/route');
    const res = await DELETE(
      makeRequest(tenant.ctx.slug, '/api/portal/directory/logo', { method: 'DELETE' }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('membership_access_restricted');
    expect(removeDirectoryLogoMock).not.toHaveBeenCalled();
  });

  it('full-access member (no cycle) → NOT blocked by the gate', async () => {
    getCurrentSessionMock.mockResolvedValue(sessionFor(fullAccessUser.userId));
    const { DELETE } = await import('@/app/api/portal/directory/logo/route');
    const res = await DELETE(
      makeRequest(tenant.ctx.slug, '/api/portal/directory/logo', { method: 'DELETE' }),
    );
    expect(res.status).toBe(200);
    expect(removeDirectoryLogoMock).toHaveBeenCalledTimes(1);
  });
});

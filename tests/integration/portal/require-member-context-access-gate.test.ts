/**
 * 059-membership-suspension Task 7 — the two production access-gate
 * chokepoints (live Neon).
 *
 * Task 3 built `checkPortalAccess` (`src/lib/lapsed-portal-scope.ts`) with
 * ZERO production callers. Task 7 wires it into:
 *   - `requireMemberContext` (`src/lib/member-context.ts`) — the ALWAYS-ON
 *     API chokepoint every `/api/portal/**` route resolves its member
 *     through.
 *   - `enforcePortalPageAccess` (`src/lib/portal-page-access.ts`) — the
 *     SSR-load page chokepoint called once from `(member)/portal/layout.tsx`.
 *
 * This suite drives BOTH real functions (not mocked) against real Postgres
 * rows to prove the wiring actually blocks/allows as intended. The mocked
 * contract tests elsewhere (`tests/contract/portal/**`) all `vi.mock('@/lib/
 * member-context', …)`, so none of them ever exercise this new branch.
 *
 * Mocked: `@/lib/auth-session` (Next.js `cookies()`-based session lookup
 * cannot run outside a real request), `next/headers` + `next/navigation`
 * (request-scoped APIs `enforcePortalPageAccess` needs). Everything else
 * (member resolution, contacts lookup, `checkPortalAccess` →
 * `deriveMembershipAccess` → `findLatestCycleForMember`, audit emit) runs
 * against live Neon.
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
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

vi.mock('@/lib/auth-session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-session')>(
    '@/lib/auth-session',
  );
  return { ...actual, getCurrentSession: vi.fn() };
});

// `enforcePortalPageAccess` reads `headers()` (for x-pathname + x-tenant
// resolution) and calls `redirect()` on a blocked decision. Both are
// Next.js request-scoped APIs that cannot run outside a real request, so
// they are mocked here; every other dependency (member resolution,
// checkPortalAccess, live DB reads) runs for real.
const fakeHeaders = new Map<string, string>();
vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => fakeHeaders.get(name) ?? null,
    has: (name: string) => fakeHeaders.has(name),
    // `resolveTenantFromHeaders` flattens via `forEach` to build a synthetic
    // Request — required by the ReadonlyHeaders shape it depends on.
    forEach: (cb: (value: string, key: string) => void) => {
      for (const [key, value] of fakeHeaders) cb(value, key);
    },
  }),
}));
const redirectMock = vi.fn();
vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirectMock(url),
}));

import { getCurrentSession } from '@/lib/auth-session';
import { requireMemberContext } from '@/lib/member-context';
import { enforcePortalPageAccess } from '@/lib/portal-page-access';

function setFakeHeaders(tenantSlug: string, pathname: string): void {
  fakeHeaders.clear();
  fakeHeaders.set('x-tenant', tenantSlug);
  fakeHeaders.set('x-pathname', pathname);
}

function mockSessionFor(userId: string): void {
  vi.mocked(getCurrentSession).mockResolvedValue({
    user: { id: userId, role: 'member' } as never,
    session: { id: 'test-session' } as never,
  });
}

function makeRequest(tenantSlug: string, pathname: string): NextRequest {
  return new NextRequest(`http://localhost:3100${pathname}`, {
    headers: { 'x-tenant': tenantSlug },
  });
}

// Shared fixture state — seeded ONCE and consumed by BOTH describe blocks
// below (requireMemberContext API-chokepoint tests + enforcePortalPageAccess
// page-chokepoint tests), since they exercise the SAME two members
// (terminated / full-access) through two different production entry points.
let tenant: TestTenant;
let seedUser: TestUser;
let terminatedUser: TestUser;
let fullAccessUser: TestUser;

const terminatedMemberId = randomUUID();
const terminatedCycleId = randomUUID();
const fullAccessMemberId = randomUUID();
const planId = `t7-gate-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  seedUser = await createActiveTestUser('admin');
  terminatedUser = await createActiveTestUser('member');
  fullAccessUser = await createActiveTestUser('member');
  tenant = await createTestTenant('test-swecham');

  await runInTenant(tenant.ctx, (tx) =>
    seedF8MembershipPlan(tx, {
      tenantSlug: tenant.ctx.slug,
      planId,
      planName: { en: 'Task 7 Gate Plan' },
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
        companyName: 'Terminated Co',
        country: 'TH',
        planId,
        planYear: 2026,
      },
      {
        tenantId: tenant.ctx.slug,
        memberId: fullAccessMemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Full Access Co',
        country: 'TH',
        planId,
        planYear: 2026,
      },
    ]),
  );

  // Each member's primary contact links to its own real user row, so
  // `requireMemberContext`'s post-checkPortalAccess `ownContact` lookup
  // (findByLinkedUserId → listByMember → find own contact) also succeeds
  // for the ALLOWED-branch assertions below.
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(contacts).values([
      {
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId: terminatedMemberId,
        firstName: 'Terminated',
        lastName: 'Contact',
        email: `terminated-${randomUUID().slice(0, 8)}@example.com`,
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
        lastName: 'Access',
        email: `full-access-${randomUUID().slice(0, 8)}@example.com`,
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

  // Terminated cycle: `lapsed` + `expiresAt` in the past. The DB CHECK
  // `renewal_cycles_closed_at_iff_terminal_check` requires `closed_at` on
  // a terminal status. `findLatestCycleForMember` (Task 2) returns this
  // row (unlike the superseded `findActiveForMember`), so
  // `deriveMembershipAccess` classifies it `terminated`.
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
  // fullAccessMemberId deliberately has NO renewal_cycles row → `full`.
}, 120_000);

afterAll(async () => {
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)).catch(() => {});
  await tenant.cleanup().catch(() => {});
  await deleteTestUser(seedUser).catch(() => {});
  await deleteTestUser(terminatedUser).catch(() => {});
  await deleteTestUser(fullAccessUser).catch(() => {});
  vi.restoreAllMocks();
}, 120_000);

describe('requireMemberContext — checkPortalAccess wiring (Task 7, live Neon)', () => {
  it('terminated member + non-allowlisted route → 403 membership_access_restricted', async () => {
    mockSessionFor(terminatedUser.userId);
    const result = await requireMemberContext(
      makeRequest(tenant.ctx.slug, '/api/portal/timeline'),
    );
    expect(result.response).toBeDefined();
    if (!result.response) return;
    expect(result.response.status).toBe(403);
    const body = (await result.response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('membership_access_restricted');
  });

  it('terminated member + non-allowlisted route → emits lapsed_member_action_blocked audit', async () => {
    mockSessionFor(terminatedUser.userId);
    await requireMemberContext(makeRequest(tenant.ctx.slug, '/api/portal/directory'));

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug));
    // Cast to `string` — this repo's `audit_event_type` DB enum has more
    // members than the currently-recognised F8 TS union in some drift
    // windows (see reference_audit_enum_tuple_db_drift); a raw literal `===`
    // here would be a TS2367 "no overlap" error if the compile-time union
    // narrows. `lapsed_member_action_blocked` is a long-shipped F8 event —
    // this is purely a type-check accommodation, not a runtime concern.
    const blocked = rows.filter((r) => (r.eventType as string) === 'lapsed_member_action_blocked');
    expect(blocked.length).toBeGreaterThan(0);
  });

  it('terminated member + allowlisted /api/portal/renewal route → NOT rejected by the access gate', async () => {
    mockSessionFor(terminatedUser.userId);
    const result = await requireMemberContext(
      makeRequest(tenant.ctx.slug, '/api/portal/renewal/redeem-link'),
    );
    // The allowlist lets the request through the checkPortalAccess gate —
    // the full MemberContext resolves (no rejection response).
    expect(result.response).toBeUndefined();
    if (result.response) return;
    expect(result.memberId).toBe(terminatedMemberId);
  });

  it('full-access member (no cycle) + any route → NOT rejected', async () => {
    mockSessionFor(fullAccessUser.userId);
    const result = await requireMemberContext(
      makeRequest(tenant.ctx.slug, '/api/portal/timeline'),
    );
    expect(result.response).toBeUndefined();
    if (result.response) return;
    expect(result.memberId).toBe(fullAccessMemberId);
  });
});

describe('enforcePortalPageAccess — SSR-load page chokepoint (Task 7, live Neon)', () => {
  beforeEach(() => {
    redirectMock.mockClear();
  });

  it('terminated member on a non-allowlisted page → redirects to /portal', async () => {
    mockSessionFor(terminatedUser.userId);
    setFakeHeaders(tenant.ctx.slug, '/portal/timeline');
    await enforcePortalPageAccess({
      user: { id: terminatedUser.userId, role: 'member' } as never,
      session: { id: 'test-session' } as never,
    });
    expect(redirectMock).toHaveBeenCalledWith('/portal');
  });

  it('terminated member on the bare /portal dashboard → NOT redirected (exact-match allowlist)', async () => {
    mockSessionFor(terminatedUser.userId);
    setFakeHeaders(tenant.ctx.slug, '/portal');
    await enforcePortalPageAccess({
      user: { id: terminatedUser.userId, role: 'member' } as never,
      session: { id: 'test-session' } as never,
    });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('full-access member (no cycle) on any page → NOT redirected', async () => {
    mockSessionFor(fullAccessUser.userId);
    setFakeHeaders(tenant.ctx.slug, '/portal/timeline');
    await enforcePortalPageAccess({
      user: { id: fullAccessUser.userId, role: 'member' } as never,
      session: { id: 'test-session' } as never,
    });
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

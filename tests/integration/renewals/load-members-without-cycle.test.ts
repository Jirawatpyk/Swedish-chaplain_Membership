/**
 * DV-18 — `listMembersWithoutCycle` / `loadMembersWithoutCycle` integration
 * test (live Neon).
 *
 * The "Members without renewal cycle" admin tray surfaces members who have
 * NO `renewal_cycles` row at all (typically pre-F8 members never onboarded
 * into the cycle lifecycle, or members whose onboarding bridge silently
 * no-op'd). It is an OPERATIONAL admin enumeration, so it must:
 *   - INCLUDE a member that has no cycle (the whole point)
 *   - EXCLUDE a member that HAS a cycle (anti-join)
 *   - EXCLUDE `status='archived'` members (archived ≠ a renewal gap)
 *   - EXCLUDE GDPR-erased members (`erased_at IS NOT NULL`, COMP-1 H4 trap —
 *     erasure keeps status='active' so a status filter alone won't hide them)
 *   - report `totalCount` matching the included set
 *
 * Anti-join SQL leads from `members` (NOT `renewal_cycles`) with a correlated
 * `NOT EXISTS` against the cycle table, so it reads only the two tables RLS
 * scopes (Constitution Principle I two-layer isolation; the Drizzle adapter
 * threads `tx` from `runInTenant`, never the global `db`).
 *
 * RED before the port method exists (TS won't compile the call) → GREEN after
 * the adapter + use-case ship. Live Neon — the anti-join + separate `count(*)`
 * aggregate shape needs real-DB validation (a mock can't catch a wrong NOT
 * EXISTS).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  loadMembersWithoutCycle,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('DV-18 listMembersWithoutCycle — integration (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let planId: string;

  // tenantA fixtures
  let withCycleId: string; // has a cycle → EXCLUDED
  let withoutCycleNewerId: string; // no cycle, newer registration → INCLUDED
  let withoutCycleOlderId: string; // no cycle, older registration → INCLUDED
  let archivedNoCycleId: string; // no cycle but archived → EXCLUDED
  let erasedNoCycleId: string; // no cycle but GDPR-erased → EXCLUDED

  // tenantB fixture (cross-tenant isolation control)
  let tenantBNoCycleId: string;

  /** Insert a member; the renewal cycle is seeded separately so absence is explicit. */
  async function seedMember(
    t: TestTenant,
    args: {
      readonly memberId: string;
      readonly registrationDate: string; // YYYY-MM-DD
      readonly status?: 'active' | 'inactive' | 'archived';
      readonly erasedAt?: Date | null;
      readonly companyName?: string;
    },
  ) {
    const status = args.status ?? 'active';
    await runInTenant(t.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: t.ctx.slug,
        memberId: args.memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: args.companyName ?? `Co ${args.memberId.slice(0, 6)}`,
        country: 'TH',
        planId,
        planYear: 2026,
        registrationDate: args.registrationDate,
        status,
        // CHECK `members_archived_at_iff_archived`: an archived row MUST
        // carry archived_at (and a non-archived row MUST NOT).
        archivedAt: status === 'archived' ? new Date() : null,
        erasedAt: args.erasedAt ?? null,
      }),
    );
  }

  async function seedCycleFor(t: TestTenant, memberId: string) {
    await runInTenant(t.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: t.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'upcoming',
        periodFrom: new Date(Date.now() - 30 * MS_PER_DAY),
        periodTo: new Date(Date.now() + 335 * MS_PER_DAY),
        expiresAt: new Date(Date.now() + 335 * MS_PER_DAY),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      }),
    );
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;
    planId = `dv18-${randomUUID().slice(0, 8)}`;

    for (const t of [tenantA, tenantB]) {
      await runInTenant(t.ctx, (tx) =>
        seedF8MembershipPlan(tx, {
          tenantSlug: t.ctx.slug,
          planId,
          planName: { en: 'DV18 Plan' },
          renewalTierBucket: 'regular',
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: user.userId,
        }),
      );
    }

    withCycleId = randomUUID();
    withoutCycleNewerId = randomUUID();
    withoutCycleOlderId = randomUUID();
    archivedNoCycleId = randomUUID();
    erasedNoCycleId = randomUUID();
    tenantBNoCycleId = randomUUID();

    // tenantA seed
    await seedMember(tenantA, {
      memberId: withCycleId,
      registrationDate: '2026-01-15',
      companyName: 'Has Cycle Co',
    });
    await seedCycleFor(tenantA, withCycleId);

    await seedMember(tenantA, {
      memberId: withoutCycleNewerId,
      registrationDate: '2026-03-20',
      companyName: 'No Cycle Newer Co',
    });
    await seedMember(tenantA, {
      memberId: withoutCycleOlderId,
      registrationDate: '2026-02-01',
      companyName: 'No Cycle Older Co',
    });
    await seedMember(tenantA, {
      memberId: archivedNoCycleId,
      registrationDate: '2026-01-01',
      status: 'archived',
      companyName: 'Archived No Cycle Co',
    });
    await seedMember(tenantA, {
      memberId: erasedNoCycleId,
      registrationDate: '2026-01-05',
      status: 'active', // erasure keeps status active
      erasedAt: new Date(),
      companyName: '[erased]',
    });

    // tenantB control — a no-cycle member that tenantA must NOT see.
    await seedMember(tenantB, {
      memberId: tenantBNoCycleId,
      registrationDate: '2026-03-01',
      companyName: 'Tenant B No Cycle Co',
    });
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      const slug = t.ctx.slug;
      await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, slug)).catch(() => {});
      await db.delete(members).where(eq(members.tenantId, slug)).catch(() => {});
      await db.delete(membershipPlans).where(eq(membershipPlans.tenantId, slug)).catch(() => {});
      await db.delete(auditLog).where(eq(auditLog.tenantId, slug)).catch(() => {});
      await t.cleanup().catch(() => {});
    }
  }, 120_000);

  it('includes no-cycle members, excludes cycle-having / archived / erased', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const result = await loadMembersWithoutCycle(deps, {
      tenantId: tenantA.ctx.slug,
      limit: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.items.map((i) => i.memberId);

    // (b) a member with NO cycle is INCLUDED
    expect(ids).toContain(withoutCycleNewerId);
    expect(ids).toContain(withoutCycleOlderId);

    // (a) a member WITH a cycle is EXCLUDED
    expect(ids).not.toContain(withCycleId);

    // (c) archived members EXCLUDED
    expect(ids).not.toContain(archivedNoCycleId);

    // (d) erased_at IS NOT NULL members EXCLUDED (COMP-1 H4 trap)
    expect(ids).not.toContain(erasedNoCycleId);
  });

  it('orders registration_date DESC, member_id ASC', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const result = await loadMembersWithoutCycle(deps, {
      tenantId: tenantA.ctx.slug,
      limit: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ours = result.value.items.filter(
      (i) =>
        i.memberId === withoutCycleNewerId ||
        i.memberId === withoutCycleOlderId,
    );
    expect(ours).toHaveLength(2);
    // Newer registration (2026-03-20) sorts before older (2026-02-01).
    expect(ours[0]!.memberId).toBe(withoutCycleNewerId);
    expect(ours[1]!.memberId).toBe(withoutCycleOlderId);
  });

  it('reports companyName + registrationDate on each row', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const result = await loadMembersWithoutCycle(deps, {
      tenantId: tenantA.ctx.slug,
      limit: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const newer = result.value.items.find(
      (i) => i.memberId === withoutCycleNewerId,
    );
    expect(newer).toBeDefined();
    expect(newer!.companyName).toBe('No Cycle Newer Co');
    // registrationDate is a date column — surfaced as a YYYY-MM-DD string.
    expect(newer!.registrationDate).toContain('2026-03-20');
  });

  it('(e) totalCount equals the number of included no-cycle members', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const result = await loadMembersWithoutCycle(deps, {
      tenantId: tenantA.ctx.slug,
      limit: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // tenantA has EXACTLY 2 includable no-cycle members (newer + older);
    // with-cycle / archived / erased are all excluded. The tenant slug is
    // fresh per run, so no cross-test pollution can inflate the count.
    expect(result.value.totalCount).toBe(2);
    expect(result.value.items).toHaveLength(2);
  });

  it('cross-tenant: tenantA never sees tenantB no-cycle member', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const result = await loadMembersWithoutCycle(deps, {
      tenantId: tenantA.ctx.slug,
      limit: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.items.map((i) => i.memberId);
    expect(ids).not.toContain(tenantBNoCycleId);
  });
});

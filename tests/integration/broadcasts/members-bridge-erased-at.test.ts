/**
 * Spec 139 DE6 / Constitution Principle I — the send-standing gate's erasure
 * read (`membersBridge.getMemberErasedAt`) never answers for another tenant's
 * member, on LIVE Postgres (Neon `dev`).
 *
 * The read goes through the members barrel's `findErasedAtById`: `runInTenant`
 * (RLS + FORCE, `SET LOCAL app.current_tenant`) plus an explicit `tenant_id`
 * predicate. Two tenants, one member each — A's erased, B's live:
 *
 *   - each tenant reads its OWN member truthfully (A's `erased_at`, B's null);
 *   - a read of the OTHER tenant's member id, from either side, answers `null`
 *     ("no such member here"), never that member's erasure state. A `null`
 *     is undecided at dispatch and refused at submit / approve / confirm
 *     (P4), so a cross-tenant id can never unlock a send either.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { membersBridge } from '@/modules/broadcasts/infrastructure/members-bridge';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const ERASED_AT = new Date('2026-10-01T00:00:00.000Z');

describe('spec 139 DE6 — getMemberErasedAt is tenant-scoped (live Neon, two tenants)', () => {
  let user: TestUser;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let erasedInA: string;
  let liveInB: string;

  async function seedMember(tenant: TestTenant, erasedAt: Date | null): Promise<string> {
    const planId = `p139-de6-${randomUUID().slice(0, 8)}`;
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'DE6 Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `DE6 ${erasedAt === null ? 'Live' : 'Erased'} Co`,
        country: 'TH',
        planId,
        planYear: 2026,
        erasedAt,
      });
    });
    return memberId;
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    ({ a: tenantA, b: tenantB } = await createTwoTestTenants());
    erasedInA = await seedMember(tenantA, ERASED_AT);
    liveInB = await seedMember(tenantB, null);
  }, 120_000);

  afterAll(async () => {
    await tenantA?.cleanup().catch(() => {});
    await tenantB?.cleanup().catch(() => {});
    if (user) await deleteTestUser(user).catch(() => {});
  }, 120_000);

  it('each tenant reads its own member truthfully', async () => {
    expect(await membersBridge.getMemberErasedAt(tenantA.ctx, erasedInA)).toEqual({ erasedAt: ERASED_AT });
    expect(await membersBridge.getMemberErasedAt(tenantB.ctx, liveInB)).toEqual({ erasedAt: null });
  });

  it.each([
    { reader: 'A', owner: 'B (live)' },
    { reader: 'B', owner: 'A (erased)' },
  ])('tenant $reader reading tenant $owner\'s member id → null (no such member here), never its state', async ({ reader }) => {
    const [ctx, foreignId] = reader === 'A' ? [tenantA.ctx, liveInB] : [tenantB.ctx, erasedInA];
    expect(await membersBridge.getMemberErasedAt(ctx, foreignId)).toBeNull();
  });
});

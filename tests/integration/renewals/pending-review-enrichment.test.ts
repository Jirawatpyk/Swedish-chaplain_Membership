/**
 * 070 F8 item #18 perf — pending-review member-name BATCH enrichment
 * (live Neon Singapore).
 *
 * Proves the `/admin/renewals?view=pending-review` company-name enrichment
 * resolves ALL pending cycles' member names with a SINGLE member-batch read
 * (F3 `findManyByIdsInTx`), killing the prior per-row `fetchMemberDisplay`
 * N+1 (which ran two sequential `runInTenant` queries per cycle and
 * discarded the unused primary-contact result).
 *
 * Coverage:
 *   1. ≥2 pending cycles for ≥2 members → all company names resolve, and
 *      `findManyByIdsInTx` is invoked EXACTLY ONCE with all distinct ids.
 *   2. A member id not present in the tenant (deleted / unknown) is ABSENT
 *      from the returned map → caller degrades gracefully (no throw).
 *   3. Empty id list → no DB round-trip, empty map.
 *   4. Cross-tenant isolation: tenant B's slug cannot resolve tenant A's
 *      members (RLS hides the rows → absent from the map).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { f3DrizzleMemberRepo } from '@/modules/members';
import { fetchPendingReviewCompanyNames } from '@/app/(staff)/admin/renewals/_lib/pending-review-enrichment';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

interface SeededMember {
  readonly memberId: string;
  readonly companyName: string;
}

async function seedMember(
  tenant: TestTenant,
  user: TestUser,
  companyName: string,
): Promise<SeededMember> {
  const memberId = randomUUID();
  const planId = `f8-pre-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant.ctx, (tx) =>
    seedF8MembershipPlan(tx, {
      tenantSlug: tenant.ctx.slug,
      planId,
      planName: { en: 'Pending Review Enrichment Plan' },
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      createdBy: user.userId,
    }),
  );
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName,
      country: 'TH',
      planId,
      planYear: 2026,
    }),
  );
  return { memberId, companyName };
}

describe('F8 pending-review company-name batch enrichment (070 perf)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let m1: SeededMember;
  let m2: SeededMember;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant();
    tenantB = await createTestTenant();
    m1 = await seedMember(tenantA, user, 'Alpha Holdings Co., Ltd.');
    m2 = await seedMember(tenantA, user, 'Beta Trading Partners');
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const t of [tenantA, tenantB]) {
      if (!t) continue;
      await db
        .delete(members)
        .where(eq(members.tenantId, t.ctx.slug))
        .catch(() => {});
      await t.cleanup().catch(() => {});
    }
  }, 120_000);

  it('resolves all pending-cycle company names in ONE batched read', async () => {
    const spy = vi.spyOn(f3DrizzleMemberRepo, 'findManyByIdsInTx');
    try {
      // Two cycles for two members PLUS a duplicate id (same member can
      // appear once per cycle) — the helper must dedupe to a single query.
      const map = await fetchPendingReviewCompanyNames({
        tenantSlug: tenantA.ctx.slug,
        memberIds: [m1.memberId, m2.memberId, m1.memberId],
      });

      expect(map.get(m1.memberId)).toBe(m1.companyName);
      expect(map.get(m2.memberId)).toBe(m2.companyName);

      // THE N+1 INVARIANT: exactly one batch read for N cycles (not 2N).
      expect(spy).toHaveBeenCalledOnce();
      // Called with the DISTINCT ids only.
      const calledWith = spy.mock.calls[0]?.[1] ?? [];
      expect([...calledWith].sort()).toEqual([m1.memberId, m2.memberId].sort());
    } finally {
      spy.mockRestore();
    }
  });

  it('degrades gracefully when a member id is absent (missing → not in map)', async () => {
    const ghostId = randomUUID();
    const map = await fetchPendingReviewCompanyNames({
      tenantSlug: tenantA.ctx.slug,
      memberIds: [m1.memberId, ghostId],
    });

    expect(map.get(m1.memberId)).toBe(m1.companyName);
    // Missing member is simply absent — caller supplies the cycle-id
    // fallback; the helper does NOT throw or blank the whole result.
    expect(map.has(ghostId)).toBe(false);
  });

  it('empty id list → no DB round-trip, empty map', async () => {
    const spy = vi.spyOn(f3DrizzleMemberRepo, 'findManyByIdsInTx');
    try {
      const map = await fetchPendingReviewCompanyNames({
        tenantSlug: tenantA.ctx.slug,
        memberIds: [],
      });
      expect(map.size).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('cross-tenant: tenant B cannot resolve tenant A members (RLS hides rows)', async () => {
    const map = await fetchPendingReviewCompanyNames({
      tenantSlug: tenantB.ctx.slug,
      memberIds: [m1.memberId, m2.memberId],
    });
    // RLS hides tenant A's rows from tenant B's scope → both absent.
    expect(map.has(m1.memberId)).toBe(false);
    expect(map.has(m2.memberId)).toBe(false);
  });
});

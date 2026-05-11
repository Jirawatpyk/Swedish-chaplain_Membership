/**
 * F8 Phase 6 verify-run follow-up — `recomputeAtRiskScoresBatch`
 * end-to-end write proof.
 *
 * Closes the regression risk surfaced by `/speckit.review` Gap 1: the
 * production fix for `bulkSetRiskScores` (Date.toISOString cast) was
 * only covered by `at-risk-recompute-perf.test.ts`, which is gated on
 * `RUN_PERF=1` and skipped in the standard CI run. A revert of the
 * cast back to a raw `Date` would not be caught.
 *
 * This test runs in the standard `pnpm test:integration` suite,
 * exercises the full batched pipeline (gather → score → bulk UPDATE →
 * bulk audit emit), and asserts both the use-case tally AND the
 * post-run DB state. Re-introducing the postgres-js Date-binding bug
 * (or any equivalent regression that silently writes 0 rows) will
 * fail this test in <5s.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import { eq, gt, sql as drizzleSql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  recomputeAtRiskScoresBatch,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW_MS = Date.now();
const PERIOD_FROM = new Date(NOW_MS - 30 * MS_PER_DAY);
const PERIOD_TO = new Date(NOW_MS + 30 * MS_PER_DAY);

async function seedMembers(
  tenant: TestTenant,
  user: TestUser,
  count: number,
): Promise<ReadonlyArray<string>> {
  const planId = `f8-bulk-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant.ctx, async (tx) => {
    await seedF8MembershipPlan(tx, {
      tenantSlug: tenant.ctx.slug,
      planId,
      planName: { en: 'Bulk Plan' },
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      createdBy: user.userId,
    });
  });
  const memberIds: string[] = [];
  await runInTenant(tenant.ctx, async (tx) => {
    for (let i = 0; i < count; i++) {
      const memberId = randomUUID();
      memberIds.push(memberId);
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: `Bulk Co ${i}`,
        country: 'TH',
        planId,
        planYear: 2026,
        // Backdate so all members clear FR-035 min-tenure gate.
        createdAt: new Date(NOW_MS - 60 * MS_PER_DAY),
        // >365d for FR-029 line 7 → +5 score.
        lastActivityAt: new Date(NOW_MS - 400 * MS_PER_DAY),
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Bulk',
        lastName: `M${i}`,
        email: `bulk-${memberId.slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'upcoming',
        periodFrom: PERIOD_FROM,
        periodTo: PERIOD_TO,
        expiresAt: PERIOD_TO,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
    }
  });
  return memberIds;
}

describe('F8 at-risk batched recompute — DB write proof (Date regression guard)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenant.ctx);
  }, 180_000);

  afterAll(async () => {
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  afterEach(async () => {
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
  });

  it('writes risk_score_last_computed_at to every recomputed member (regression guard)', async () => {
    await seedMembers(tenant, user, 5);
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const cronStartDate = new Date(Date.now() - 1000); // 1s slack

    const result = await recomputeAtRiskScoresBatch(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.membersRecomputed).toBeGreaterThan(0);
    expect(result.value.membersSkippedBelowTenure).toBe(0);
    expect(result.value.membersFailed).toBe(0);

    // The actual regression catch: post-run query confirms the bulk
    // UPDATE landed. A reverted Date binding would throw + skip writes,
    // and this assertion would fail with writtenCount=0 vs >0 expected.
    const writtenCount = await runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx
        .select({ count: drizzleSql<number>`count(*)::int` })
        .from(members)
        .where(gt(members.riskScoreLastComputedAt, cronStartDate));
      return rows[0]?.count ?? 0;
    });
    expect(writtenCount).toBe(result.value.membersRecomputed);
  });
});

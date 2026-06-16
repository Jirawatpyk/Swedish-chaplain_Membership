/**
 * COMP-1 R3 — risk-score WRITE path must no-op on a GDPR-erased member.
 *
 * The H4 round added `erased_at IS NULL` to the at-risk candidate-LIST
 * queries (`listActiveMemberIdsForAtRiskRecompute` +
 * `gatherAtRiskFactorsForTenant`) but NOT to the at-risk WRITE path. A
 * member erased AFTER candidate-listing but BEFORE the score write would
 * get the scrubbed risk columns re-populated — re-leaking the quasi-
 * identifiers (`risk_score` / `risk_score_band` / `risk_score_factors`)
 * that `scrubPiiInTx` NULLed. This is a TOCTOU re-leak across the
 * recompute-vs-erase race.
 *
 * Defence-in-depth fix: both `setRiskScore` AND `bulkSetRiskScores` add
 * `isNull(members.erasedAt)` to their UPDATE WHERE so the write is a no-op
 * on an erased tombstone (re-checks erased state at write time).
 *
 * This test seeds a member, stamps `erased_at = NOW()` via a raw UPDATE,
 * then drives both write paths and asserts:
 *   (a) the UPDATE affects 0 rows for the erased member, and
 *   (b) a raw SELECT shows the risk columns UNCHANGED (still NULL — the
 *       seed leaves them NULL, exactly as the scrub would have).
 *
 * For `bulkSetRiskScores`, a batch containing BOTH the erased member AND
 * a non-erased member proves the guard is per-row: only the non-erased
 * member's row is written.
 *
 * RED before the guard (the write lands on the erased row) → GREEN after.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, isNotNull, sql as drizzleSql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { makeDrizzleMemberRenewalFlagsRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-member-renewal-flags-repo';
import type { SetRiskScoreInput } from '@/modules/renewals/application/ports/member-renewal-flags-repo';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const SCORE_INPUT: SetRiskScoreInput = {
  score: 88,
  band: 'critical',
  factors: { invoices_overdue_count_gt_zero: 25 },
  computedAt: '2026-06-16T00:00:00.000Z',
};

async function seedMember(
  tenant: TestTenant,
  planId: string,
  opts: { erased: boolean },
): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: opts.erased ? 'Erased Co' : 'Live Co',
      country: 'TH',
      planId,
      planYear: 2026,
      // risk_score* intentionally left NULL — mirrors a scrubbed tombstone.
    });
    if (opts.erased) {
      // Raw UPDATE to stamp erased_at (the production scrub path is the
      // members module's eraseMember; here we only need the tombstone marker).
      await tx
        .update(members)
        .set({ erasedAt: new Date() })
        .where(eq(members.memberId, memberId));
    }
  });
  return memberId;
}

interface RiskRow {
  riskScore: number | null;
  riskScoreBand: string | null;
  riskScoreFactors: unknown;
  riskScoreLastComputedAt: Date | null;
}

async function readRiskRow(
  tenant: TestTenant,
  memberId: string,
): Promise<RiskRow | undefined> {
  return runInTenant(tenant.ctx, async (tx) => {
    const rows = await tx
      .select({
        riskScore: members.riskScore,
        riskScoreBand: members.riskScoreBand,
        riskScoreFactors: members.riskScoreFactors,
        riskScoreLastComputedAt: members.riskScoreLastComputedAt,
      })
      .from(members)
      .where(eq(members.memberId, memberId))
      .limit(1);
    return rows[0];
  });
}

describe('COMP-1 R3 — risk-score write no-ops on an erased member', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    planId = `r3-plan-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'R3 Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
    });
  }, 180_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  beforeEach(async () => {
    // Clear seeded members between tests so each starts from a clean slate.
    await db.delete(members).where(eq(members.tenantId, tenant.ctx.slug));
  });

  it('setRiskScore: erased member → affectedRows 0 + risk columns UNCHANGED (still NULL)', async () => {
    const erasedId = await seedMember(tenant, planId, { erased: true });
    const repo = makeDrizzleMemberRenewalFlagsRepo(tenant.ctx);

    const result = await runInTenant(tenant.ctx, (tx) =>
      repo.setRiskScore(tx, tenant.ctx.slug, erasedId, SCORE_INPUT),
    );

    // (a) the write is a no-op on the tombstone.
    expect(result.affectedRows).toBe(0);
    expect(result.previousBand).toBe(null);

    // (b) the risk columns were NOT populated.
    const row = await readRiskRow(tenant, erasedId);
    expect(row).toBeDefined();
    expect(row?.riskScore).toBe(null);
    expect(row?.riskScoreBand).toBe(null);
    expect(row?.riskScoreFactors).toBe(null);
    expect(row?.riskScoreLastComputedAt).toBe(null);
  });

  it('setRiskScore: non-erased member → affectedRows 1 + risk columns written (control)', async () => {
    const liveId = await seedMember(tenant, planId, { erased: false });
    const repo = makeDrizzleMemberRenewalFlagsRepo(tenant.ctx);

    const result = await runInTenant(tenant.ctx, (tx) =>
      repo.setRiskScore(tx, tenant.ctx.slug, liveId, SCORE_INPUT),
    );

    expect(result.affectedRows).toBe(1);

    const row = await readRiskRow(tenant, liveId);
    expect(row?.riskScore).toBe(88);
    expect(row?.riskScoreBand).toBe('critical');
    expect(row?.riskScoreLastComputedAt).not.toBe(null);
  });

  it('bulkSetRiskScores: batch with erased + live member → only the live row is written', async () => {
    const erasedId = await seedMember(tenant, planId, { erased: true });
    const liveId = await seedMember(tenant, planId, { erased: false });
    const repo = makeDrizzleMemberRenewalFlagsRepo(tenant.ctx);

    const result = await runInTenant(tenant.ctx, (tx) =>
      repo.bulkSetRiskScores(
        tx,
        tenant.ctx.slug,
        [
          { memberId: erasedId, score: 90, band: 'critical', factors: { invoices_overdue_count_gt_zero: 25 } },
          { memberId: liveId, score: 60, band: 'at-risk', factors: { invoices_overdue_count_gt_zero: 25 } },
        ],
        new Date('2026-06-16T00:00:00.000Z'),
      ),
    );

    // Only the live member's row should have been UPDATEd.
    expect(result.affectedRows).toBe(1);

    const erasedRow = await readRiskRow(tenant, erasedId);
    expect(erasedRow?.riskScore).toBe(null);
    expect(erasedRow?.riskScoreBand).toBe(null);
    expect(erasedRow?.riskScoreFactors).toBe(null);
    expect(erasedRow?.riskScoreLastComputedAt).toBe(null);

    const liveRow = await readRiskRow(tenant, liveId);
    expect(liveRow?.riskScore).toBe(60);
    expect(liveRow?.riskScoreBand).toBe('at-risk');
    expect(liveRow?.riskScoreLastComputedAt).not.toBe(null);

    // Cross-check via a raw COUNT: exactly one member in this tenant carries
    // a non-null risk_score after the bulk write.
    const writtenCount = await runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx
        .select({ count: drizzleSql<number>`count(*)::int` })
        .from(members)
        .where(isNotNull(members.riskScore));
      return rows[0]?.count ?? 0;
    });
    expect(writtenCount).toBe(1);
  });
});

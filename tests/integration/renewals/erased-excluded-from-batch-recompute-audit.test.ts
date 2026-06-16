/**
 * COMP-1 (companion to R3) — the batched at-risk recompute must NOT emit a
 * spurious `at_risk_score_recomputed` audit for a member that was WRITE-SKIPPED
 * because it was GDPR-erased.
 *
 * Background: `gatherAtRiskFactorsForTenant` already excludes erased members
 * (H4), and `bulkSetRiskScores` re-checks `erased_at IS NULL` at write time
 * (R3). But the use-case's audit loop iterated the in-memory `computed` list,
 * NOT the actual write result — so a member erased in the TOCTOU window
 * (after candidate-listing but before the bulk write) was write-SKIPPED yet
 * still got a "recompute succeeded" audit. Not a PII/integrity bug (the risk
 * columns are NOT re-populated — R3 holds), just an inaccurate audit.
 *
 * This test reproduces the race deterministically: it wraps
 * `gatherAtRiskFactorsForTenant` so that, immediately AFTER the real gather
 * returns the live member's factors (on the same tx), it stamps `erased_at`
 * on the target member. By the time `bulkSetRiskScores` + the audit loop run
 * inside the same `runInTenant`, the member is erased → the write is a no-op →
 * the audit MUST NOT be emitted for it.
 *
 * Two members are seeded: one stays live (control — must get the audit), one
 * is erased mid-batch (must NOT get the audit). RED before the audit-gate fix
 * (both get the audit) → GREEN after (only the live member does).
 *
 * Live Neon.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql as drizzleSql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { recomputeAtRiskScoresBatch, makeRenewalsDeps } from '@/modules/renewals';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW_MS = Date.now();
const PERIOD_FROM = new Date(NOW_MS - 30 * MS_PER_DAY);
const PERIOD_TO = new Date(NOW_MS + 30 * MS_PER_DAY);

async function seedMember(
  tenant: TestTenant,
  planId: string,
  label: string,
): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `${label} Co`,
      country: 'TH',
      planId,
      planYear: 2026,
      // Backdate so the member clears the FR-035 min-tenure gate and lands
      // in `computed` (not skippedBelowTenure).
      createdAt: new Date(NOW_MS - 60 * MS_PER_DAY),
      // >365d aged so FR-029 line 7 contributes a non-zero score.
      lastActivityAt: new Date(NOW_MS - 400 * MS_PER_DAY),
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: 'Batch',
      lastName: label,
      email: `batch-${memberId.slice(0, 6)}@acme.example`,
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
  });
  return memberId;
}

async function recomputedAuditMemberIds(
  tenant: TestTenant,
): Promise<Set<string>> {
  const audits = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenantId, tenant.ctx.slug),
        eq(auditLog.eventType, 'at_risk_score_recomputed' as never),
      ),
    );
  const ids = new Set<string>();
  for (const a of audits) {
    const memberId = (a.payload as Record<string, unknown> | null)?.member_id;
    if (typeof memberId === 'string') ids.add(memberId);
  }
  return ids;
}

describe('F8 batched at-risk recompute does NOT audit a write-skipped erased member (COMP-1)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenant.ctx);
    planId = `f8-batch-erase-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Batch Erase Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
  }, 180_000);

  afterAll(async () => {
    const slug = tenant.ctx.slug;
    await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  afterEach(async () => {
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug))
      .catch(() => {});
  });

  it('erases a member mid-batch → it is write-skipped AND NOT audited; the live member is', async () => {
    const liveId = await seedMember(tenant, planId, 'Live');
    const erasedId = await seedMember(tenant, planId, 'Erased');

    const baseDeps = makeRenewalsDeps(tenant.ctx.slug);

    // Wrap gatherAtRiskFactorsForTenant: run the real gather (both members
    // are live, so both come back), THEN stamp `erased_at` on the target
    // member ON THE SAME tx so the subsequent bulkSetRiskScores (R3 guard)
    // sees the tombstone and skips the write. This deterministically
    // reproduces the candidate-listing-vs-erase TOCTOU race.
    const deps: RenewalsDeps = {
      ...baseDeps,
      memberRenewalFlagsRepo: {
        ...baseDeps.memberRenewalFlagsRepo,
        async gatherAtRiskFactorsForTenant(tx, tenantId) {
          const factors =
            await baseDeps.memberRenewalFlagsRepo.gatherAtRiskFactorsForTenant(
              tx,
              tenantId,
            );
          // Erase the target member after candidate-listing, before the write.
          await (tx as unknown as typeof db).execute(
            drizzleSql`UPDATE members SET erased_at = NOW() WHERE member_id = ${erasedId}`,
          );
          return factors;
        },
      },
    };

    const result = await recomputeAtRiskScoresBatch(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The audit set must equal the write set: only the live member.
    const auditedIds = await recomputedAuditMemberIds(tenant);
    expect(auditedIds.has(liveId)).toBe(true);
    expect(auditedIds.has(erasedId)).toBe(false);

    // The write-skipped erased member must NOT have its risk columns populated
    // (R3 already covers this; re-assert as the integrity backstop).
    const erasedRiskWritten = await runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx
        .select({ count: drizzleSql<number>`count(*)::int` })
        .from(members)
        .where(
          and(
            eq(members.memberId, erasedId),
            drizzleSql`risk_score IS NOT NULL`,
          ),
        );
      return rows[0]?.count ?? 0;
    });
    expect(erasedRiskWritten).toBe(0);

    // The tally reflects the actual write set (1 live member), not the
    // in-memory computed length (which counted both before the write-skip).
    expect(result.value.membersRecomputed).toBe(1);
  }, 90_000);
});

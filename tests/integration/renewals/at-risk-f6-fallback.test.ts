/**
 * F8 Phase 6 Wave F · T173 — at-risk F6-readiness fallback (live Neon).
 *
 * Verifies FR-029a F6-readiness fallback + FR-030 proportional bands
 * end-to-end: the `computeAtRiskScore` use-case correctly delegates to
 * the AtRiskScorer port (mocked here with controlled factors) and
 * persists the resulting score + band onto F3 `members.risk_score_*`
 * columns + emits `at_risk_score_recomputed` with `active_max: 70 |
 * 100` literal per the audit-port contract.
 *
 * Test scope:
 *   1. F6 active (eventAttendeesAvailable=true) — full 8-factor formula,
 *      max=100; bands at 0–24/25–49/50–74/75–100.
 *   2. F6 inactive — events + cultural-ticket factors skipped, max=70;
 *      bands at 0–17/18–34/35–52/53–70.
 *   3. Band crossing UP (warning → at-risk) emits
 *      `at_risk_score_threshold_crossed` per FR-031.
 *   4. Band crossing DOWN does NOT emit threshold_crossed (FR-031 is
 *      monthly-trend deterioration only).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  computeAtRiskScore,
  computeAtRiskScorePure,
  makeRenewalsDeps,
} from '@/modules/renewals';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type {
  AtRiskFactors,
  AtRiskScoreResult,
} from '@/modules/renewals/domain/at-risk-score';
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

/**
 * Test-controlled AtRiskScorer that runs the canonical Domain function
 * (`computeAtRiskScorePure`) against caller-supplied factors + F6 flag.
 * Lets the integration test pin both inputs without touching live cross-
 * module bridges (F4 invoices, F7 broadcasts, etc.).
 */
function makeTestScorer(
  factors: AtRiskFactors,
  f6Available: boolean,
): RenewalsDeps['atRiskScorer'] {
  const result = computeAtRiskScorePure(factors, {
    minTenureDays: 30,
    eventAttendeesAvailable: f6Available,
  });
  if (!result.ok) throw new Error('test scorer seed failed');
  const value: AtRiskScoreResult = result.value;
  return {
    async scoreMember() {
      return value;
    },
    async *scoreMembers(_tenantId, memberIds) {
      for (const memberId of memberIds) yield { memberId, result: value };
    },
  };
}

async function seedMember(
  tenant: TestTenant,
  user: TestUser,
  initialBand?: 'healthy' | 'warning' | 'at-risk' | 'critical',
): Promise<{ memberId: string }> {
  const memberId = randomUUID();
  const planId = `f8-f6-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant.ctx, async (tx) => {
    await seedF8MembershipPlan(tx, {
      tenantSlug: tenant.ctx.slug,
      planId,
      planName: { en: 'F6 Plan' },
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      createdBy: user.userId,
    });
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'F6 Co',
      country: 'TH',
      planId,
      planYear: 2026,
      ...(initialBand !== undefined
        ? {
            riskScoreBand: initialBand,
            riskScore:
              initialBand === 'healthy'
                ? 10
                : initialBand === 'warning'
                  ? 30
                  : initialBand === 'at-risk'
                    ? 60
                    : 80,
          }
        : {}),
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: 'Test',
      lastName: 'F6',
      email: `f6-${randomUUID().slice(0, 6)}@acme.example`,
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
  return { memberId };
}

describe('F8 at-risk F6-readiness fallback — integration (T173)', () => {
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

  beforeEach(async () => {
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
  });

  it('F6 active: full 8-factor formula reaches active_max=100, bands at 0-24/25-49/50-74/75-100', async () => {
    const seeded = await seedMember(tenant, user);
    const baseDeps = makeRenewalsDeps(tenant.ctx.slug);
    // AS1 spec example: events_12mo=0 + invoices_overdue=1 +
    // days_since_payment=280 ⇒ 25+25+10 = 60 ⇒ band='at-risk'
    const deps: RenewalsDeps = {
      ...baseDeps,
      atRiskScorer: makeTestScorer(
        {
          tenureDays: 365,
          eventsAttendedLast12Months: 0,
          invoicesOverdueCount: 1,
          daysSinceLastPayment: 280,
        },
        true,
      ),
    };

    const r = await computeAtRiskScore(deps, {
      tenantId: tenant.ctx.slug,
      memberId: seeded.memberId,
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.skipped) {
      throw new Error('expected non-skipped result');
    }
    expect(r.value.score).toBe(60);
    expect(r.value.band).toBe('at-risk');
    expect(r.value.f6Active).toBe(true);

    // Verify score persisted to DB.
    const memberRow = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          score: members.riskScore,
          band: members.riskScoreBand,
        })
        .from(members)
        .where(eq(members.memberId, seeded.memberId))
        .limit(1),
    );
    expect(memberRow[0]?.score).toBe(60);
    expect(memberRow[0]?.band).toBe('at-risk');

    // at_risk_score_recomputed audit emitted with active_max=100.
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'at_risk_score_recomputed' as never),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const matching = audits.find(
      (a) =>
        (a.payload as Record<string, unknown> | null)?.member_id ===
        seeded.memberId,
    );
    expect(matching).toBeDefined();
    expect(
      (matching?.payload as Record<string, unknown>)?.active_max,
    ).toBe(100);
    expect(
      (matching?.payload as Record<string, unknown>)?.f6_active,
    ).toBe(true);
  }, 60_000);

  it('F6 inactive: events + cultural_ticket factors skipped; active_max=70 in audit', async () => {
    const seeded = await seedMember(tenant, user);
    const baseDeps = makeRenewalsDeps(tenant.ctx.slug);
    // F6-independent factors only: e-blast(15) + invoices_overdue(25) +
    // days_since_payment(10) = 50; band derivation against max=70 →
    // 50 / 70 = 71% → critical (≥75% would be 53+; 50 is in 35..52
    // range → at-risk band per FR-030 bands 0-17/18-34/35-52/53-70).
    // Actually 50/70 = 71% which IS ≥75%? No 75% of 70 = 52.5 → score
    // 50 < 52.5 → band=at-risk per the implementation.
    const deps: RenewalsDeps = {
      ...baseDeps,
      atRiskScorer: makeTestScorer(
        {
          tenureDays: 365,
          eBlastQuotaPctUsed: 10, // <30% → +15
          invoicesOverdueCount: 1, // >0 → +25
          daysSinceLastPayment: 200, // >180 → +10
          // F6-dependent factors set but should be IGNORED
          eventsAttendedLast12Months: 0,
          culturalTicketQuotaPctUsed: 10,
        },
        false,
      ),
    };

    const r = await computeAtRiskScore(deps, {
      tenantId: tenant.ctx.slug,
      memberId: seeded.memberId,
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.skipped) {
      throw new Error('expected non-skipped result');
    }
    expect(r.value.f6Active).toBe(false);
    // Sum: e_blast 15 + invoices 25 + payment 10 = 50 (events factors
    // dropped per F6-inactive).
    expect(r.value.score).toBe(50);
    // 50/70 = 71.4% → at-risk band (50% ≤ score/max < 75%; 50/70=0.714)
    expect(r.value.band).toBe('at-risk');

    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'at_risk_score_recomputed' as never),
        ),
      );
    const matching = audits.find(
      (a) =>
        (a.payload as Record<string, unknown> | null)?.member_id ===
        seeded.memberId,
    );
    expect(matching).toBeDefined();
    expect(
      (matching?.payload as Record<string, unknown>)?.active_max,
    ).toBe(70);
    expect(
      (matching?.payload as Record<string, unknown>)?.f6_active,
    ).toBe(false);
  }, 60_000);

  it('band crossed UP (warning → at-risk) emits at_risk_score_threshold_crossed (FR-031)', async () => {
    const seeded = await seedMember(tenant, user, 'warning');
    const baseDeps = makeRenewalsDeps(tenant.ctx.slug);
    // Score 60 ⇒ at-risk (F6 active) — UP from prior 'warning'.
    const deps: RenewalsDeps = {
      ...baseDeps,
      atRiskScorer: makeTestScorer(
        {
          tenureDays: 365,
          eventsAttendedLast12Months: 0,
          invoicesOverdueCount: 1,
          daysSinceLastPayment: 280,
        },
        true,
      ),
    };

    const r = await computeAtRiskScore(deps, {
      tenantId: tenant.ctx.slug,
      memberId: seeded.memberId,
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.skipped) return;
    expect(r.value.bandCrossedUp).toBe(true);
    expect(r.value.previousBand).toBe('warning');

    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'at_risk_score_threshold_crossed' as never),
        ),
      );
    const matching = audits.find(
      (a) =>
        (a.payload as Record<string, unknown> | null)?.member_id ===
        seeded.memberId,
    );
    expect(matching).toBeDefined();
    expect(
      (matching?.payload as Record<string, unknown>)?.previous_band,
    ).toBe('warning');
    expect(
      (matching?.payload as Record<string, unknown>)?.new_band,
    ).toBe('at-risk');
  }, 60_000);

  it('band crossed DOWN (critical → healthy) does NOT emit threshold_crossed (FR-031 deterioration-only)', async () => {
    const seeded = await seedMember(tenant, user, 'critical');
    const baseDeps = makeRenewalsDeps(tenant.ctx.slug);
    // Score 0 ⇒ healthy — DOWN crossing, silent per FR-031.
    const deps: RenewalsDeps = {
      ...baseDeps,
      atRiskScorer: makeTestScorer({ tenureDays: 365 }, true),
    };

    const r = await computeAtRiskScore(deps, {
      tenantId: tenant.ctx.slug,
      memberId: seeded.memberId,
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.skipped) return;
    expect(r.value.bandCrossedUp).toBe(false);

    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'at_risk_score_threshold_crossed' as never),
        ),
      );
    const matching = audits.find(
      (a) =>
        (a.payload as Record<string, unknown> | null)?.member_id ===
        seeded.memberId,
    );
    // No threshold_crossed audit for DOWN movement.
    expect(matching).toBeUndefined();
  }, 60_000);
});

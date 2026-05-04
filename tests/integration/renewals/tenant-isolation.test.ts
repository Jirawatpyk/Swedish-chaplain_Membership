/**
 * T052 — F8 Tenant isolation integration test (REVIEW-GATE BLOCKER).
 *
 * Constitution v1.4.0 Principle I clause 3 — cross-tenant probes on
 * every CRUD operation against ALL 9 F8 tables, from both directions.
 *
 * Why this is a blocker: F8 carries renewal lifecycle PII (frozen
 * plan price snapshots, member at-risk scores, escalation task notes,
 * renewal-link tokens). A single missed RLS path leaks renewal data
 * across chambers — a PDPA §28 + GDPR Art. 6 violation, plus exposes
 * member retention strategies between competing chambers (FR-029
 * commercial-sensitive at-risk scoring).
 *
 * Covered surfaces (all 9 F8 tables — Wave C migrations 0086-0094):
 *   - scheduled_plan_changes        (F2 cross-module table per F7 precedent)
 *   - renewal_cycles                (F8 aggregate root)
 *   - renewal_reminder_events       (idempotent reminder log)
 *   - tenant_renewal_settings       (per-tenant config singleton)
 *   - tenant_renewal_schedule_policies (5-bucket reminder ladders)
 *   - at_risk_outreach              (admin outreach log)
 *   - tier_upgrade_suggestions      (6-state upgrade lifecycle)
 *   - renewal_escalation_tasks      (3-state task queue)
 *   - consumed_link_tokens          (HMAC token replay primitive)
 *
 * Per-table probe matrix:
 *   1. A sees only A rows
 *   2. B sees only B rows
 *   3. A.SELECT(B row by id) returns empty (RLS hides)
 *   4. A.UPDATE(B row) affects 0 rows + B row unchanged (where applicable)
 *   5. A.DELETE(B row) affects 0 rows + B row exists (where granted)
 *   6. A.INSERT(row with tenant_id=B) rejected by RLS WITH CHECK
 *
 * Sibling files (same Constitution Principle I clause 3 contract):
 *   - tests/integration/broadcasts/tenant-isolation.test.ts (F7)
 *   - tests/integration/invoicing/tenant-isolation.test.ts  (F4)
 *   - tests/integration/payments/tenant-isolation.test.ts   (F5)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { scheduledPlanChanges } from '@/modules/plans/infrastructure/db/schema-scheduled-plan-changes';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalReminderEvents } from '@/modules/renewals/infrastructure/schema-renewal-reminder-events';
import {
  tenantRenewalSettings,
  tenantRenewalSchedulePolicies,
} from '@/modules/renewals/infrastructure/schema-tenant-renewal-config';
import { atRiskOutreach } from '@/modules/renewals/infrastructure/schema-at-risk-outreach';
import { tierUpgradeSuggestions } from '@/modules/renewals/infrastructure/schema-tier-upgrade-suggestions';
import { renewalEscalationTasks } from '@/modules/renewals/infrastructure/schema-renewal-escalation-tasks';
import { consumedLinkTokens } from '@/modules/renewals/infrastructure/schema-consumed-link-tokens';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

const F8_ISOLATION_MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

interface TenantSeed {
  readonly memberId: string;
  readonly planId: string;
  readonly cycleId: string;
  readonly reminderEventId: string;
  readonly outreachId: string;
  readonly suggestionId: string;
  readonly taskId: string;
  readonly tokenSha256: Buffer;
  readonly schedChangeId: string;
}

describe('F8 Tenant isolation — REVIEW-GATE BLOCKER (T052)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let seedA: TenantSeed;
  let seedB: TenantSeed;

  async function seedTenant(t: TestTenant): Promise<TenantSeed> {
    const planId = `f8-iso-${randomUUID().slice(0, 8)}`;
    const memberId = randomUUID();
    const cycleId = randomUUID();
    const reminderEventId = randomUUID();
    const outreachId = randomUUID();
    const suggestionId = randomUUID();
    const taskId = randomUUID();
    // Build a 32-byte SHA-256-shaped digest from 2 random UUID halves —
    // matches the consumed_link_tokens.token_sha256 length CHECK.
    const fullToken = Buffer.alloc(32);
    Buffer.from(randomUUID().replace(/-/g, ''), 'hex').copy(fullToken, 0);
    Buffer.from(randomUUID().replace(/-/g, ''), 'hex').copy(fullToken, 16);
    const schedChangeId = randomUUID();

    // F2 plan + F3 member
    await runInTenant(t.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: t.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'F8 Iso Plan' },
        description: { en: '' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: F8_ISOLATION_MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      }),
    );
    await runInTenant(t.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: t.ctx.slug,
        memberId,
        companyName: 'F8 Iso Member',
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );

    // F8 cross-module: scheduled_plan_changes
    await runInTenant(t.ctx, (tx) =>
      tx.insert(scheduledPlanChanges).values({
        tenantId: t.ctx.slug,
        scheduledChangeId: schedChangeId,
        memberId,
        effectiveAtCycleId: cycleId,
        fromPlanId: planId,
        toPlanId: 'corporate-premier',
        scheduledByUserId: user.userId,
        status: 'pending',
      }),
    );

    // F8 renewal_cycles
    await runInTenant(t.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: t.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming',
        periodFrom: new Date('2026-06-01T00:00:00Z'),
        periodTo: new Date('2027-06-01T00:00:00Z'),
        expiresAt: new Date('2027-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      }),
    );

    // F8 renewal_reminder_events
    await runInTenant(t.ctx, (tx) =>
      tx.insert(renewalReminderEvents).values({
        tenantId: t.ctx.slug,
        reminderEventId,
        cycleId,
        stepId: 't-30.email',
        channel: 'email',
        templateId: 'renewal.t-30.regular',
        status: 'pending',
        yearInCycle: 1,
      }),
    );

    // F8 tenant_renewal_settings + tenant_renewal_schedule_policies
    await runInTenant(t.ctx, (tx) =>
      tx.insert(tenantRenewalSettings).values({
        tenantId: t.ctx.slug,
        gracePeriodDays: 14,
      }),
    );
    await runInTenant(t.ctx, (tx) =>
      tx.insert(tenantRenewalSchedulePolicies).values({
        tenantId: t.ctx.slug,
        tierBucket: 'regular',
        stepsJsonb: [
          {
            step_id: 't-30.email',
            offset_days: -30,
            channel: 'email',
            template_id: 'renewal.t-30.regular',
          },
        ],
      }),
    );

    // F8 at_risk_outreach
    await runInTenant(t.ctx, (tx) =>
      tx.insert(atRiskOutreach).values({
        tenantId: t.ctx.slug,
        outreachId,
        memberId,
        channel: 'phone',
        actorUserId: user.userId,
      }),
    );

    // F8 tier_upgrade_suggestions
    await runInTenant(t.ctx, (tx) =>
      tx.insert(tierUpgradeSuggestions).values({
        tenantId: t.ctx.slug,
        suggestionId,
        memberId,
        fromPlanId: randomUUID(),
        toPlanId: randomUUID(),
        reasonCode: 'declared_turnover_above_threshold',
        evidenceJsonb: { turnoverThb: 50_000_000 },
        status: 'open',
      }),
    );

    // F8 renewal_escalation_tasks
    await runInTenant(t.ctx, (tx) =>
      tx.insert(renewalEscalationTasks).values({
        tenantId: t.ctx.slug,
        taskId,
        memberId,
        cycleId,
        taskType: 'phone_call',
        assignedToRole: 'admin',
        dueAt: new Date('2026-06-01T00:00:00Z'),
        status: 'open',
      }),
    );

    // F8 consumed_link_tokens
    await runInTenant(t.ctx, (tx) =>
      tx.insert(consumedLinkTokens).values({
        tenantId: t.ctx.slug,
        tokenSha256: fullToken,
        consumedByMemberId: memberId,
        cycleId,
      }),
    );

    return {
      memberId,
      planId,
      cycleId,
      reminderEventId,
      outreachId,
      suggestionId,
      taskId,
      tokenSha256: fullToken,
      schedChangeId,
    };
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;
    seedA = await seedTenant(tenantA);
    seedB = await seedTenant(tenantB);
  }, 120_000);

  afterAll(async () => {
    // Cycle-related child tables clean up via CASCADE; cleanup helper in
    // test-tenant.ts already wipes scheduled_plan_changes + renewal config
    // tables. Manually purge consumed_link_tokens rows since they have no
    // FK cascades.
    for (const t of [tenantA, tenantB]) {
      await db
        .delete(consumedLinkTokens)
        .where(eq(consumedLinkTokens.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(renewalEscalationTasks)
        .where(eq(renewalEscalationTasks.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(atRiskOutreach)
        .where(eq(atRiskOutreach.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(renewalReminderEvents)
        .where(eq(renewalReminderEvents.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(renewalCycles)
        .where(eq(renewalCycles.tenantId, t.ctx.slug))
        .catch(() => {});
    }
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  }, 120_000);

  // ===========================================================================
  // 1. scheduled_plan_changes (F2 cross-module table)
  // ===========================================================================

  describe('scheduled_plan_changes', () => {
    it('A sees only A row', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx.select().from(scheduledPlanChanges),
      );
      expect(rows.map((r) => r.scheduledChangeId)).toEqual([seedA.schedChangeId]);
    });

    it('B sees only B row', async () => {
      const rows = await runInTenant(tenantB.ctx, (tx) =>
        tx.select().from(scheduledPlanChanges),
      );
      expect(rows.map((r) => r.scheduledChangeId)).toEqual([seedB.schedChangeId]);
    });

    it('A cannot SELECT B row by id', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .select()
          .from(scheduledPlanChanges)
          .where(eq(scheduledPlanChanges.scheduledChangeId, seedB.schedChangeId)),
      );
      expect(rows).toHaveLength(0);
    });

    it('A.UPDATE(B row) affects 0 rows', async () => {
      const updated = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .update(scheduledPlanChanges)
          .set({ status: 'cancelled', cancelledAt: new Date() })
          .where(eq(scheduledPlanChanges.scheduledChangeId, seedB.schedChangeId))
          .returning(),
      );
      expect(updated).toHaveLength(0);
    });

    it('A.DELETE(B row) affects 0 rows', async () => {
      const deleted = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .delete(scheduledPlanChanges)
          .where(eq(scheduledPlanChanges.scheduledChangeId, seedB.schedChangeId))
          .returning(),
      );
      expect(deleted).toHaveLength(0);
    });

    it('A.INSERT(tenant_id=B) rejected by RLS WITH CHECK', async () => {
      await expect(
        runInTenant(tenantA.ctx, (tx) =>
          tx.insert(scheduledPlanChanges).values({
            tenantId: tenantB.ctx.slug,
            memberId: seedB.memberId,
            effectiveAtCycleId: randomUUID(),
            fromPlanId: 'p1',
            toPlanId: 'p2',
            scheduledByUserId: user.userId,
            status: 'pending',
          }),
        ),
      ).rejects.toThrow();
    });
  });

  // ===========================================================================
  // 2. renewal_cycles
  // ===========================================================================

  describe('renewal_cycles', () => {
    it('A sees only A row', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx.select().from(renewalCycles),
      );
      expect(rows.map((r) => r.cycleId)).toEqual([seedA.cycleId]);
    });

    it('B sees only B row', async () => {
      const rows = await runInTenant(tenantB.ctx, (tx) =>
        tx.select().from(renewalCycles),
      );
      expect(rows.map((r) => r.cycleId)).toEqual([seedB.cycleId]);
    });

    it('A cannot SELECT B row by id', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx.select().from(renewalCycles).where(eq(renewalCycles.cycleId, seedB.cycleId)),
      );
      expect(rows).toHaveLength(0);
    });

    it('A.UPDATE(B row) affects 0 rows + B unchanged', async () => {
      const updated = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .update(renewalCycles)
          .set({ status: 'cancelled' })
          .where(eq(renewalCycles.cycleId, seedB.cycleId))
          .returning(),
      );
      expect(updated).toHaveLength(0);
      const check = await runInTenant(tenantB.ctx, (tx) =>
        tx.select().from(renewalCycles).where(eq(renewalCycles.cycleId, seedB.cycleId)),
      );
      expect(check[0]?.status).toBe('upcoming');
    });

    it('A.DELETE(B row) affects 0 rows + B exists', async () => {
      const deleted = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .delete(renewalCycles)
          .where(eq(renewalCycles.cycleId, seedB.cycleId))
          .returning(),
      );
      expect(deleted).toHaveLength(0);
      const check = await runInTenant(tenantB.ctx, (tx) =>
        tx.select().from(renewalCycles).where(eq(renewalCycles.cycleId, seedB.cycleId)),
      );
      expect(check).toHaveLength(1);
    });

    it('A.INSERT(tenant_id=B) rejected by RLS WITH CHECK', async () => {
      await expect(
        runInTenant(tenantA.ctx, (tx) =>
          tx.insert(renewalCycles).values({
            tenantId: tenantB.ctx.slug,
            memberId: seedB.memberId,
            status: 'upcoming',
            periodFrom: new Date('2026-06-01T00:00:00Z'),
            periodTo: new Date('2027-06-01T00:00:00Z'),
            expiresAt: new Date('2027-06-01T00:00:00Z'),
            cycleLengthMonths: 12,
            tierAtCycleStart: 'regular',
            planIdAtCycleStart: randomUUID(),
            frozenPlanPriceThb: '50000.00',
            frozenPlanTermMonths: 12,
            frozenPlanCurrency: 'THB',
          }),
        ),
      ).rejects.toThrow();
    });
  });

  // ===========================================================================
  // 3. renewal_reminder_events
  // ===========================================================================

  describe('renewal_reminder_events', () => {
    it('A sees only A row', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx.select().from(renewalReminderEvents),
      );
      expect(rows.map((r) => r.reminderEventId)).toEqual([seedA.reminderEventId]);
    });

    it('B sees only B row', async () => {
      const rows = await runInTenant(tenantB.ctx, (tx) =>
        tx.select().from(renewalReminderEvents),
      );
      expect(rows.map((r) => r.reminderEventId)).toEqual([seedB.reminderEventId]);
    });

    it('A cannot SELECT B row by id', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .select()
          .from(renewalReminderEvents)
          .where(
            eq(renewalReminderEvents.reminderEventId, seedB.reminderEventId),
          ),
      );
      expect(rows).toHaveLength(0);
    });

    it('A.UPDATE(B row) affects 0 rows', async () => {
      const updated = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .update(renewalReminderEvents)
          .set({ status: 'failed', failureReason: 'rogue', dispatchedAt: null })
          .where(
            eq(renewalReminderEvents.reminderEventId, seedB.reminderEventId),
          )
          .returning(),
      );
      expect(updated).toHaveLength(0);
    });

    it('A.DELETE(B row) affects 0 rows + B exists', async () => {
      const deleted = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .delete(renewalReminderEvents)
          .where(
            eq(renewalReminderEvents.reminderEventId, seedB.reminderEventId),
          )
          .returning(),
      );
      expect(deleted).toHaveLength(0);
      const check = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select()
          .from(renewalReminderEvents)
          .where(
            eq(renewalReminderEvents.reminderEventId, seedB.reminderEventId),
          ),
      );
      expect(check).toHaveLength(1);
    });

    it('A.INSERT(tenant_id=B) rejected by RLS WITH CHECK', async () => {
      await expect(
        runInTenant(tenantA.ctx, (tx) =>
          tx.insert(renewalReminderEvents).values({
            tenantId: tenantB.ctx.slug,
            cycleId: seedB.cycleId,
            stepId: 'rogue.email',
            channel: 'email',
            templateId: 'rogue',
            status: 'pending',
            yearInCycle: 1,
          }),
        ),
      ).rejects.toThrow();
    });
  });

  // ===========================================================================
  // 4. tenant_renewal_settings
  // ===========================================================================

  describe('tenant_renewal_settings', () => {
    it('A sees only A row', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx.select().from(tenantRenewalSettings),
      );
      expect(rows.map((r) => r.tenantId)).toEqual([tenantA.ctx.slug]);
    });

    it('B sees only B row', async () => {
      const rows = await runInTenant(tenantB.ctx, (tx) =>
        tx.select().from(tenantRenewalSettings),
      );
      expect(rows.map((r) => r.tenantId)).toEqual([tenantB.ctx.slug]);
    });

    it('A cannot SELECT B row', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .select()
          .from(tenantRenewalSettings)
          .where(eq(tenantRenewalSettings.tenantId, tenantB.ctx.slug)),
      );
      expect(rows).toHaveLength(0);
    });

    it('A.UPDATE(B row) affects 0 rows', async () => {
      const updated = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .update(tenantRenewalSettings)
          .set({ gracePeriodDays: 90 })
          .where(eq(tenantRenewalSettings.tenantId, tenantB.ctx.slug))
          .returning(),
      );
      expect(updated).toHaveLength(0);
    });

    it('A.INSERT(tenant_id=B) rejected by RLS WITH CHECK', async () => {
      await expect(
        runInTenant(tenantA.ctx, (tx) =>
          tx.insert(tenantRenewalSettings).values({
            tenantId: tenantB.ctx.slug,
            gracePeriodDays: 14,
          }),
        ),
      ).rejects.toThrow();
    });
  });

  // ===========================================================================
  // 5. tenant_renewal_schedule_policies
  // ===========================================================================

  describe('tenant_renewal_schedule_policies', () => {
    it('A sees only A row', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx.select().from(tenantRenewalSchedulePolicies),
      );
      expect(rows.every((r) => r.tenantId === tenantA.ctx.slug)).toBe(true);
    });

    it('B sees only B row', async () => {
      const rows = await runInTenant(tenantB.ctx, (tx) =>
        tx.select().from(tenantRenewalSchedulePolicies),
      );
      expect(rows.every((r) => r.tenantId === tenantB.ctx.slug)).toBe(true);
    });

    it('A cannot SELECT B row by composite key', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .select()
          .from(tenantRenewalSchedulePolicies)
          .where(
            and(
              eq(tenantRenewalSchedulePolicies.tenantId, tenantB.ctx.slug),
              eq(tenantRenewalSchedulePolicies.tierBucket, 'regular'),
            ),
          ),
      );
      expect(rows).toHaveLength(0);
    });

    it('A.INSERT(tenant_id=B) rejected by RLS WITH CHECK', async () => {
      await expect(
        runInTenant(tenantA.ctx, (tx) =>
          tx.insert(tenantRenewalSchedulePolicies).values({
            tenantId: tenantB.ctx.slug,
            tierBucket: 'partnership',
            stepsJsonb: [],
          }),
        ),
      ).rejects.toThrow();
    });
  });

  // ===========================================================================
  // 6. at_risk_outreach
  // ===========================================================================

  describe('at_risk_outreach', () => {
    it('A sees only A row', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx.select().from(atRiskOutreach),
      );
      expect(rows.map((r) => r.outreachId)).toEqual([seedA.outreachId]);
    });

    it('B sees only B row', async () => {
      const rows = await runInTenant(tenantB.ctx, (tx) =>
        tx.select().from(atRiskOutreach),
      );
      expect(rows.map((r) => r.outreachId)).toEqual([seedB.outreachId]);
    });

    it('A cannot SELECT B row by id', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .select()
          .from(atRiskOutreach)
          .where(eq(atRiskOutreach.outreachId, seedB.outreachId)),
      );
      expect(rows).toHaveLength(0);
    });

    it('A.UPDATE(B row) affects 0 rows', async () => {
      const updated = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .update(atRiskOutreach)
          .set({ outcomeNote: 'tampered' })
          .where(eq(atRiskOutreach.outreachId, seedB.outreachId))
          .returning(),
      );
      expect(updated).toHaveLength(0);
    });

    it('A.DELETE(B row) affects 0 rows + B exists', async () => {
      const deleted = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .delete(atRiskOutreach)
          .where(eq(atRiskOutreach.outreachId, seedB.outreachId))
          .returning(),
      );
      expect(deleted).toHaveLength(0);
      const check = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select()
          .from(atRiskOutreach)
          .where(eq(atRiskOutreach.outreachId, seedB.outreachId)),
      );
      expect(check).toHaveLength(1);
    });

    it('A.INSERT(tenant_id=B) rejected by RLS WITH CHECK', async () => {
      await expect(
        runInTenant(tenantA.ctx, (tx) =>
          tx.insert(atRiskOutreach).values({
            tenantId: tenantB.ctx.slug,
            memberId: seedB.memberId,
            channel: 'phone',
            actorUserId: user.userId,
          }),
        ),
      ).rejects.toThrow();
    });
  });

  // ===========================================================================
  // 7. tier_upgrade_suggestions
  // ===========================================================================

  describe('tier_upgrade_suggestions', () => {
    it('A sees only A row', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx.select().from(tierUpgradeSuggestions),
      );
      expect(rows.map((r) => r.suggestionId)).toEqual([seedA.suggestionId]);
    });

    it('B sees only B row', async () => {
      const rows = await runInTenant(tenantB.ctx, (tx) =>
        tx.select().from(tierUpgradeSuggestions),
      );
      expect(rows.map((r) => r.suggestionId)).toEqual([seedB.suggestionId]);
    });

    it('A cannot SELECT B row by id', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .select()
          .from(tierUpgradeSuggestions)
          .where(eq(tierUpgradeSuggestions.suggestionId, seedB.suggestionId)),
      );
      expect(rows).toHaveLength(0);
    });

    it('A.UPDATE(B row) affects 0 rows', async () => {
      const updated = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .update(tierUpgradeSuggestions)
          .set({
            status: 'dismissed',
            dismissedReason: 'tampered',
            closedAt: new Date(),
          })
          .where(eq(tierUpgradeSuggestions.suggestionId, seedB.suggestionId))
          .returning(),
      );
      expect(updated).toHaveLength(0);
    });

    it('A.DELETE(B row) affects 0 rows + B exists', async () => {
      const deleted = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .delete(tierUpgradeSuggestions)
          .where(eq(tierUpgradeSuggestions.suggestionId, seedB.suggestionId))
          .returning(),
      );
      expect(deleted).toHaveLength(0);
      const check = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select()
          .from(tierUpgradeSuggestions)
          .where(eq(tierUpgradeSuggestions.suggestionId, seedB.suggestionId)),
      );
      expect(check).toHaveLength(1);
    });

    it('A.INSERT(tenant_id=B) rejected by RLS WITH CHECK', async () => {
      await expect(
        runInTenant(tenantA.ctx, (tx) =>
          tx.insert(tierUpgradeSuggestions).values({
            tenantId: tenantB.ctx.slug,
            memberId: seedB.memberId,
            fromPlanId: randomUUID(),
            toPlanId: randomUUID(),
            reasonCode: 'declared_turnover_above_threshold',
            evidenceJsonb: { rogue: true },
            status: 'open',
          }),
        ),
      ).rejects.toThrow();
    });
  });

  // ===========================================================================
  // 8. renewal_escalation_tasks
  // ===========================================================================

  describe('renewal_escalation_tasks', () => {
    it('A sees only A row', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx.select().from(renewalEscalationTasks),
      );
      expect(rows.map((r) => r.taskId)).toEqual([seedA.taskId]);
    });

    it('B sees only B row', async () => {
      const rows = await runInTenant(tenantB.ctx, (tx) =>
        tx.select().from(renewalEscalationTasks),
      );
      expect(rows.map((r) => r.taskId)).toEqual([seedB.taskId]);
    });

    it('A cannot SELECT B row by id', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .select()
          .from(renewalEscalationTasks)
          .where(eq(renewalEscalationTasks.taskId, seedB.taskId)),
      );
      expect(rows).toHaveLength(0);
    });

    it('A.UPDATE(B row) affects 0 rows', async () => {
      const updated = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .update(renewalEscalationTasks)
          .set({ assignedToRole: 'executive_director' })
          .where(eq(renewalEscalationTasks.taskId, seedB.taskId))
          .returning(),
      );
      expect(updated).toHaveLength(0);
    });

    it('A.DELETE(B row) affects 0 rows + B exists', async () => {
      const deleted = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .delete(renewalEscalationTasks)
          .where(eq(renewalEscalationTasks.taskId, seedB.taskId))
          .returning(),
      );
      expect(deleted).toHaveLength(0);
      const check = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select()
          .from(renewalEscalationTasks)
          .where(eq(renewalEscalationTasks.taskId, seedB.taskId)),
      );
      expect(check).toHaveLength(1);
    });

    it('A.INSERT(tenant_id=B) rejected by RLS WITH CHECK', async () => {
      await expect(
        runInTenant(tenantA.ctx, (tx) =>
          tx.insert(renewalEscalationTasks).values({
            tenantId: tenantB.ctx.slug,
            memberId: seedB.memberId,
            cycleId: seedB.cycleId,
            taskType: 'rogue',
            assignedToRole: 'admin',
            dueAt: new Date('2026-06-01T00:00:00Z'),
            status: 'open',
          }),
        ),
      ).rejects.toThrow();
    });
  });

  // ===========================================================================
  // 9. consumed_link_tokens
  // ===========================================================================

  describe('consumed_link_tokens', () => {
    it('A sees only A row', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx.select().from(consumedLinkTokens),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenSha256.equals(seedA.tokenSha256)).toBe(true);
    });

    it('B sees only B row', async () => {
      const rows = await runInTenant(tenantB.ctx, (tx) =>
        tx.select().from(consumedLinkTokens),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenSha256.equals(seedB.tokenSha256)).toBe(true);
    });

    it("A cannot SELECT B's token by sha256", async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .select()
          .from(consumedLinkTokens)
          .where(eq(consumedLinkTokens.tokenSha256, seedB.tokenSha256)),
      );
      expect(rows).toHaveLength(0);
    });

    it('A.DELETE(B token) affects 0 rows + B token exists', async () => {
      const deleted = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .delete(consumedLinkTokens)
          .where(eq(consumedLinkTokens.tokenSha256, seedB.tokenSha256))
          .returning(),
      );
      expect(deleted).toHaveLength(0);
      const check = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select()
          .from(consumedLinkTokens)
          .where(eq(consumedLinkTokens.tokenSha256, seedB.tokenSha256)),
      );
      expect(check).toHaveLength(1);
    });

    it('A.INSERT(tenant_id=B) rejected by RLS WITH CHECK', async () => {
      const rogueToken = Buffer.alloc(32, 0xff);
      await expect(
        runInTenant(tenantA.ctx, (tx) =>
          tx.insert(consumedLinkTokens).values({
            tenantId: tenantB.ctx.slug,
            tokenSha256: rogueToken,
            consumedByMemberId: seedB.memberId,
            cycleId: seedB.cycleId,
          }),
        ),
      ).rejects.toThrow();
    });
  });
});

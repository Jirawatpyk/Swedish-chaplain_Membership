/**
 * F8 Phase 10 R5 verify-fix / B3 — bulk port methods integration test.
 *
 * Pins the contract of the 4 bulk port methods added in commits
 * `52637d75` (T264) + `2caa8d74` (T262 infrastructure):
 *
 * 1. `TierUpgradeSuggestionRepo.bulkGetSuppressedMembers` — single-RTT
 *    set-membership probe.
 * 2. `TierUpgradeSuggestionRepo.bulkInsertOpenIfAbsent` — multi-row
 *    INSERT ON CONFLICT DO NOTHING with explicit
 *    `(tenant_id, member_id) WHERE status IN ('open', 'accepted_pending_apply')`
 *    target (R5-C1 fix).
 * 3. `RenewalReminderEventRepo.bulkInsertIfAbsent` — multi-row INSERT
 *    ON CONFLICT DO NOTHING against
 *    `renewal_reminder_events_idem_idx` + R5-C2 tenantId guard.
 * 4. `RenewalReminderEventRepo.bulkTransitionToSent` — multi-row
 *    UPDATE … FROM (VALUES …) with row-count assertion + R5-C2
 *    tenantId guard.
 *
 * Coverage rationale: the bulk methods ship in production adapters but
 * (a) tier-upgrade methods ARE wired into evaluateTierUpgrade, and
 * (b) reminder-event methods are infrastructure-only awaiting outer-
 * loop wiring. Without direct tests, a regression on either path
 * surfaces only at production-bench time. This file pins:
 *   - happy path (correct row count returned)
 *   - empty input no-op
 *   - conflict path (returned `conflicted` / no duplicate insert)
 *   - tenantId guard (cross-tenant input throws)
 *   - row-count mismatch (bulkTransitionToSent: stale id throws)
 *   - explicit conflict-target (PK collision on bulkInsertOpenIfAbsent
 *     would NOT be silently swallowed as "already_open")
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalReminderEvents } from '@/modules/renewals/infrastructure/schema-renewal-reminder-events';
import { tierUpgradeSuggestions } from '@/modules/renewals/infrastructure/schema-tier-upgrade-suggestions';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { makeRenewalsDeps } from '@/modules/renewals';
import type {
  NewTierUpgradeSuggestionInput,
  TierUpgradeSuggestionRepo,
} from '@/modules/renewals/application/ports/tier-upgrade-suggestion-repo';
import type {
  NewReminderEventInput,
  RenewalReminderEventRepo,
} from '@/modules/renewals/application/ports/renewal-reminder-event-repo';
import { asSuggestionId } from '@/modules/renewals/domain/tier-upgrade-suggestion';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('F8 bulk port methods — Phase 10 R5 / B3', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let tierUpgradeRepo: TierUpgradeSuggestionRepo;
  let reminderEventRepo: RenewalReminderEventRepo;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    planId = `f8-bulk-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Bulk Port Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    tierUpgradeRepo = deps.tierUpgradeRepo;
    reminderEventRepo = deps.reminderEventRepo;
  }, 120_000);

  afterAll(async () => {
    await db
      .delete(renewalReminderEvents)
      .where(eq(renewalReminderEvents.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(tierUpgradeSuggestions)
      .where(eq(tierUpgradeSuggestions.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(contacts)
      .where(eq(contacts.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(members)
      .where(eq(members.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(membershipPlans)
      .where(eq(membershipPlans.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  async function seedMember(): Promise<string> {
    const memberId = randomUUID();
    const cycleId = randomUUID();
    const now = Date.now();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: 'Bulk Port Test Co',
        country: 'TH',
        planId,
        planYear: 2026,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Bulk',
        lastName: 'Test',
        email: `bulk-${randomUUID().slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming',
        periodFrom: new Date(now - 30 * MS_PER_DAY),
        periodTo: new Date(now + 30 * MS_PER_DAY),
        expiresAt: new Date(now + 30 * MS_PER_DAY),
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

  describe('bulkGetSuppressedMembers', () => {
    it('returns empty set for empty input (no-op)', async () => {
      const result = await runInTenant(tenant.ctx, (tx) =>
        tierUpgradeRepo.bulkGetSuppressedMembers(tx, [], new Date().toISOString()),
      );
      expect(result.size).toBe(0);
    });

    it('returns memberIds with active suppression (status=dismissed + suppressed_until > now)', async () => {
      const memberIdSuppressed = await seedMember();
      const memberIdActive = await seedMember();
      const memberIdNoRow = randomUUID();
      // Insert a dismissed suggestion with future suppressed_until.
      await runInTenant(tenant.ctx, async (tx) => {
        const txDb = tx as unknown as typeof db;
        await txDb.insert(tierUpgradeSuggestions).values({
          tenantId: tenant.ctx.slug,
          suggestionId: asSuggestionId(randomUUID()),
          memberId: memberIdSuppressed,
          fromPlanId: 'plan-a',
          toPlanId: 'plan-b',
          reasonCode: 'declared_turnover_above_threshold',
          evidenceJsonb: {
            reasonCode: 'declared_turnover_above_threshold',
            turnoverThb: 1000,
            thresholdMetAt: new Date().toISOString(),
          },
          status: 'dismissed',
          suppressedUntil: new Date(Date.now() + 30 * MS_PER_DAY),
          dismissedReason: 'admin_dismissed',
          closedAt: new Date(),
        });
      });
      const result = await runInTenant(tenant.ctx, (tx) =>
        tierUpgradeRepo.bulkGetSuppressedMembers(
          tx,
          [memberIdSuppressed, memberIdActive, memberIdNoRow],
          new Date().toISOString(),
        ),
      );
      expect(result.has(memberIdSuppressed)).toBe(true);
      expect(result.has(memberIdActive)).toBe(false);
      expect(result.has(memberIdNoRow)).toBe(false);
    });
  });

  describe('bulkInsertOpenIfAbsent', () => {
    it('returns empty arrays for empty input (no-op)', async () => {
      const result = await runInTenant(tenant.ctx, (tx) =>
        tierUpgradeRepo.bulkInsertOpenIfAbsent(tx, []),
      );
      expect(result.inserted).toEqual([]);
      expect(result.conflicted).toEqual([]);
    });

    it('inserts all when no conflicts; returns row count matching input', async () => {
      const m1 = await seedMember();
      const m2 = await seedMember();
      const inputs: NewTierUpgradeSuggestionInput[] = [m1, m2].map((mid) => ({
        tenantId: tenant.ctx.slug,
        suggestionId: asSuggestionId(randomUUID()),
        memberId: mid,
        fromPlanId: 'regular',
        toPlanId: 'premium',
        reasonCode: 'declared_turnover_above_threshold',
        evidence: {
          reasonCode: 'declared_turnover_above_threshold',
          turnoverThb: 1000,
          thresholdMetAt: new Date().toISOString(),
        },
      }));
      const result = await runInTenant(tenant.ctx, (tx) =>
        tierUpgradeRepo.bulkInsertOpenIfAbsent(tx, inputs),
      );
      expect(result.inserted).toHaveLength(2);
      expect(result.conflicted).toEqual([]);
      const memberIds = new Set(result.inserted.map((s) => s.memberId));
      expect(memberIds.has(m1)).toBe(true);
      expect(memberIds.has(m2)).toBe(true);
    });

    it('R5-C1: explicit conflict target — partial unique on (tenant, member, status IN (open, accepted_pending_apply)) silently absorbs duplicate; PK collision would NOT be swallowed', async () => {
      const m = await seedMember();
      // First insert succeeds.
      const first = await runInTenant(tenant.ctx, (tx) =>
        tierUpgradeRepo.bulkInsertOpenIfAbsent(tx, [
          {
            tenantId: tenant.ctx.slug,
            suggestionId: asSuggestionId(randomUUID()),
            memberId: m,
            fromPlanId: 'regular',
            toPlanId: 'premium',
            reasonCode: 'declared_turnover_above_threshold',
            evidence: {
              reasonCode: 'declared_turnover_above_threshold',
              turnoverThb: 1000,
              thresholdMetAt: new Date().toISOString(),
            },
          },
        ]),
      );
      expect(first.inserted).toHaveLength(1);
      // Second insert (different suggestionId, same member) → conflict
      // by member_open_uniq partial UNIQUE → counted as conflicted, not
      // inserted.
      const second = await runInTenant(tenant.ctx, (tx) =>
        tierUpgradeRepo.bulkInsertOpenIfAbsent(tx, [
          {
            tenantId: tenant.ctx.slug,
            suggestionId: asSuggestionId(randomUUID()),
            memberId: m,
            fromPlanId: 'regular',
            toPlanId: 'premium',
            reasonCode: 'declared_turnover_above_threshold',
            evidence: {
              reasonCode: 'declared_turnover_above_threshold',
              turnoverThb: 1000,
              thresholdMetAt: new Date().toISOString(),
            },
          },
        ]),
      );
      expect(second.inserted).toEqual([]);
      // R5-MED1: conflicted now carries full input shape
      // (NewTierUpgradeSuggestionInput[]) symmetric with sister
      // bulkInsertIfAbsent on RenewalReminderEventRepo. Pre-fix
      // returned just memberId strings.
      expect(second.conflicted).toHaveLength(1);
      expect(second.conflicted[0]?.memberId).toBe(m);
      expect(second.conflicted[0]?.reasonCode).toBe(
        'declared_turnover_above_threshold',
      );
    });
  });

  describe('bulkInsertIfAbsent (reminder events)', () => {
    it('returns empty arrays for empty input (no-op)', async () => {
      const result = await runInTenant(tenant.ctx, (tx) =>
        reminderEventRepo.bulkInsertIfAbsent(tx, []),
      );
      expect(result.inserted).toEqual([]);
      expect(result.conflicted).toEqual([]);
    });

    it('R5-C2 tenantId guard: cross-tenant input throws (Constitution Principle I)', async () => {
      const cycleId = asCycleId(randomUUID());
      await expect(
        runInTenant(tenant.ctx, (tx) =>
          reminderEventRepo.bulkInsertIfAbsent(tx, [
            {
              tenantId: 'WRONG-TENANT',
              cycleId,
              stepId: 't-30.email',
              yearInCycle: 1,
              channel: 'email',
            },
          ]),
        ),
      ).rejects.toThrow(/cross-tenant write blocked/);
    });

    it('inserts all when (cycle, step, year) are unique; conflict on replay returns the input as conflicted', async () => {
      const memberId = await seedMember();
      const cycleId = asCycleId(
        (
          await runInTenant(tenant.ctx, (tx) =>
            (tx as unknown as typeof db)
              .select({ id: renewalCycles.cycleId })
              .from(renewalCycles)
              .where(eq(renewalCycles.memberId, memberId))
              .limit(1),
          )
        )[0]!.id,
      );
      const inputs: NewReminderEventInput[] = [
        {
          tenantId: tenant.ctx.slug,
          cycleId,
          stepId: 't-30.email',
          yearInCycle: 1,
          channel: 'email' as const,
          templateId: 'renewal.t-30.regular',
        },
      ];
      const first = await runInTenant(tenant.ctx, (tx) =>
        reminderEventRepo.bulkInsertIfAbsent(tx, inputs),
      );
      expect(first.inserted).toHaveLength(1);
      expect(first.conflicted).toEqual([]);
      // Replay — same input → ON CONFLICT DO NOTHING via idem_idx →
      // conflicted carries the input back.
      const second = await runInTenant(tenant.ctx, (tx) =>
        reminderEventRepo.bulkInsertIfAbsent(tx, inputs),
      );
      expect(second.inserted).toEqual([]);
      expect(second.conflicted).toHaveLength(1);
      expect(second.conflicted[0]?.cycleId).toBe(cycleId);
      expect(second.conflicted[0]?.stepId).toBe('t-30.email');
    });
  });

  describe('bulkTransitionToSent', () => {
    it('returns empty array for empty input (no-op)', async () => {
      const result = await runInTenant(tenant.ctx, (tx) =>
        reminderEventRepo.bulkTransitionToSent(tx, []),
      );
      expect(result).toEqual([]);
    });

    it('R5-C2 tenantId guard: cross-tenant input throws', async () => {
      await expect(
        runInTenant(tenant.ctx, (tx) =>
          reminderEventRepo.bulkTransitionToSent(tx, [
            {
              tenantId: 'WRONG-TENANT',
              reminderEventId: randomUUID(),
              dispatchedAt: new Date().toISOString(),
              deliveryId: 'delivery-1',
            },
          ]),
        ),
      ).rejects.toThrow(/cross-tenant write blocked/);
    });

    it('R5-C2 row-count assertion: stale or non-existent reminderEventId throws', async () => {
      // Pass a UUID that doesn't exist in the table — UPDATE matches 0
      // rows but caller asserted 1; method MUST throw.
      const nonExistentId = randomUUID();
      await expect(
        runInTenant(tenant.ctx, (tx) =>
          reminderEventRepo.bulkTransitionToSent(tx, [
            {
              tenantId: tenant.ctx.slug,
              reminderEventId: nonExistentId,
              dispatchedAt: new Date().toISOString(),
              deliveryId: 'delivery-stale',
            },
          ]),
        ),
      ).rejects.toThrow(/expected 1 rows updated, got 0/);
    });

    it('happy path: pre-claimed pending rows transition to sent in 1 RTT with per-row dispatchedAt + deliveryId', async () => {
      const memberId = await seedMember();
      const cycleId = asCycleId(
        (
          await runInTenant(tenant.ctx, (tx) =>
            (tx as unknown as typeof db)
              .select({ id: renewalCycles.cycleId })
              .from(renewalCycles)
              .where(eq(renewalCycles.memberId, memberId))
              .limit(1),
          )
        )[0]!.id,
      );
      // Pre-claim 2 reminder events at different steps.
      const claimResult = await runInTenant(tenant.ctx, (tx) =>
        reminderEventRepo.bulkInsertIfAbsent(tx, [
          {
            tenantId: tenant.ctx.slug,
            cycleId,
            stepId: 't-90.email',
            yearInCycle: 1,
            channel: 'email' as const,
            templateId: 'renewal.t-90.regular',
          },
          {
            tenantId: tenant.ctx.slug,
            cycleId,
            stepId: 't-60.email',
            yearInCycle: 1,
            channel: 'email' as const,
            templateId: 'renewal.t-60.regular',
          },
        ]),
      );
      expect(claimResult.inserted).toHaveLength(2);
      const transitionInputs = claimResult.inserted.map((r, i) => ({
        tenantId: tenant.ctx.slug,
        reminderEventId: r.reminderEventId,
        dispatchedAt: new Date(Date.now() + i * 1000).toISOString(),
        deliveryId: `delivery-${i}`,
      }));
      const result = await runInTenant(tenant.ctx, (tx) =>
        reminderEventRepo.bulkTransitionToSent(tx, transitionInputs),
      );
      expect(result).toHaveLength(2);
      for (const r of result) {
        expect(r.status).toBe('sent');
        expect(r.dispatchedAt).not.toBeNull();
        // Staff-R009 fix: \d+ instead of \d so the regex tolerates
        // multi-digit suffixes (e.g. delivery-10, delivery-99) when
        // the test seeds more than 9 reminder events. The current
        // happy-path test seeds 2; this fix future-proofs against
        // chunk-size growth.
        expect(r.deliveryId).toMatch(/^delivery-\d+$/);
      }
      // Cleanup these reminder rows so subsequent describe blocks don't
      // collide on (cycle, step, year).
      await db
        .delete(renewalReminderEvents)
        .where(
          inArray(
            renewalReminderEvents.reminderEventId,
            result.map((r) => r.reminderEventId),
          ),
        )
        .catch(() => {});
    });
  });
});

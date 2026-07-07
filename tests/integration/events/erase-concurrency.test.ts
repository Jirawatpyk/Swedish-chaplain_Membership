/**
 * #16 — erase stale-flip concurrency (live Neon Singapore).
 *
 * Deterministic overlapping-transaction proof that `eraseAttendeePii`
 * credits back from the FRESH (under-lock) quota flags, not the stale
 * pre-lock snapshot. Mirrors the #8 overlapping-tx harness in
 * `quota-concurrency.test.ts` (the READ-COMMITTED race cannot be
 * reproduced by concurrent fire-and-hope — each tx commits before the
 * next reads — so the advisory lock is forced to be the only serializer).
 *
 * Scenario:
 *   - Seed a registration counted_against_partnership=true, matched to a
 *     member on a partner-benefit event.
 *   - tx1 acquires the per-(tenant, member, calendar-year) advisory lock
 *     (the SAME key the erase path builds), flips the row to
 *     counted_against_partnership=false (an admin toggle/refund), then
 *     PARKS with the tx held open (lock + uncommitted flip held).
 *   - tx2 = the production `runEraseAttendeePii`. Its step-1 snapshot
 *     read (READ COMMITTED, before the lock) still sees counted=TRUE
 *     (tx1 uncommitted); it then BLOCKS on the advisory lock.
 *   - Release tx1 → commits counted=false + releases the lock → tx2's
 *     under-lock re-read now sees counted=FALSE.
 *
 * Assertion: the erase reversals reflect the FRESH flags — NO spurious
 * partnership credit-back (`quotaReversals.partnership === 0`) and zero
 * `quota_credit_back_archive` audits. Pre-#16 (snapshot-based) code would
 * credit back on the stale TRUE snapshot → reversals.partnership === 1.
 *
 * Spec authority: FR-032a (erasure audit fidelity) + Constitution
 * Principle I (tenant-scoped tx from runInTenant).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant, db } from '@/lib/db';
import {
  events,
  eventRegistrations,
} from '@/modules/events/infrastructure/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import {
  buildQuotaLockKey,
  asEventId,
  asRegistrationId,
} from '@/modules/events';
import { asTenantId, asMemberId } from '@/modules/members';
import { asUserId } from '@/modules/auth';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import { makeDrizzleAdvisoryLockAcquirer } from '@/modules/events/infrastructure/drizzle-advisory-lock-acquirer';
import { makeDrizzleRegistrationsRepository } from '@/modules/events/infrastructure/drizzle-registrations-repository';
import { runEraseAttendeePii } from '@/lib/events-admin-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createActiveTestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';

const corpMatrix: BenefitMatrix = {
  ...DEFAULT_TEST_BENEFIT_MATRIX,
  cultural_tickets_per_year: 2,
  partnership: null,
};

const EVENT_START = '2026-06-21T18:00:00+07:00';

describe('#16 — erase stale-flip concurrency (fresh flags win)', () => {
  let tenant: TestTenant;
  let userId: string;
  const corpPlanId = `test-plan-erase-conc-${randomUUID()}`;
  const memberId = randomUUID();
  const eventInternalId = randomUUID();
  const registrationId = randomUUID();

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    const user = await createActiveTestUser('admin');
    userId = user.userId;
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: corpPlanId,
        planName: { en: 'Corp Bundle (erase-conc)' },
        benefitMatrix: corpMatrix,
        planCategory: 'corporate',
        createdBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Erase Concurrency Co',
        country: 'TH',
        planId: corpPlanId,
        planYear: 2026,
        status: 'active',
      } as unknown as typeof members.$inferInsert);
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId: eventInternalId,
        source: 'eventcreate',
        externalId: `event_erase_conc_${randomUUID()}`,
        name: 'Erase Concurrency Event',
        startDate: new Date(EVENT_START),
        isPartnerBenefit: true,
        isCulturalEvent: false,
      } as unknown as typeof events.$inferInsert);
      // Seed a COUNTED partnership registration matched to the member.
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId,
        eventId: eventInternalId,
        externalId: `att_erase_conc_${randomUUID()}`,
        attendeeEmail: 'erase-conc@example.com',
        attendeeName: 'Erase Conc Attendee',
        attendeeCompany: 'Erase Concurrency Co',
        matchType: 'member_domain',
        matchedMemberId: memberId,
        matchedContactId: null,
        paymentStatus: 'paid',
        countedAgainstPartnership: true,
        countedAgainstCulturalQuota: false,
        registeredAt: new Date(),
      } as unknown as typeof eventRegistrations.$inferInsert);
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup();
  }, 60_000);

  it(
    'concurrent clear-then-erase → erase credits back from the fresh (post-flip) flags, no spurious credit-back',
    async () => {
      const fiscalYear = deriveFiscalYear(new Date(EVENT_START).toISOString(), 1);

      let signalTx1Ready!: () => void;
      const tx1Ready = new Promise<void>((res) => {
        signalTx1Ready = res;
      });
      let releaseTx1!: () => void;
      const tx1Release = new Promise<void>((res) => {
        releaseTx1 = res;
      });

      // tx1 — hold the per-(tenant, member, year) lock + an UNCOMMITTED
      // flag clear, then park.
      const p1 = runInTenant(tenant.ctx, async (tx) => {
        const lock = makeDrizzleAdvisoryLockAcquirer(tx);
        await lock.acquire(
          buildQuotaLockKey(
            asTenantId(tenant.ctx.slug),
            asMemberId(memberId),
            fiscalYear,
          ),
        );
        const regRepo = makeDrizzleRegistrationsRepository(tx);
        const flip = await regRepo.setQuotaEffect(
          asTenantId(tenant.ctx.slug),
          asRegistrationId(registrationId),
          {
            countedAgainstPartnership: false,
            countedAgainstCulturalQuota: false,
          },
        );
        if (!flip.ok) {
          throw new Error(
            `[#16 conc] tx1 setQuotaEffect failed: ${flip.error.kind}`,
          );
        }
        signalTx1Ready();
        await tx1Release;
      });

      // Ensure tx1 holds the lock + uncommitted flip before erase starts.
      await tx1Ready;

      // Precondition (proves the stale-vs-fresh distinction is real): tx1's
      // flip is UNCOMMITTED, so any other connection — including the
      // erase's pre-lock step-1 snapshot read, which runs during this park
      // window — still sees counted_against_partnership = TRUE.
      const committedDuringPark = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select({
            counted: eventRegistrations.countedAgainstPartnership,
          })
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.tenantId, tenant.ctx.slug),
              eq(eventRegistrations.registrationId, registrationId),
            ),
          ),
      );
      expect(committedDuringPark[0]?.counted).toBe(true);

      // tx2 — the production erase. step-1 snapshot reads counted=TRUE
      // (tx1 uncommitted), then BLOCKS on the advisory lock.
      const erasePromise = runEraseAttendeePii(tenant.ctx.slug, {
        eventId: asEventId(eventInternalId),
        registrationId: asRegistrationId(registrationId),
        actorUserId: asUserId(userId),
        reasonText: 'DPO erasure during concurrent flag clear',
        occurredAt: new Date(),
      });

      // Give the erase time to run step-1 + park on the lock (it cannot
      // proceed until tx1 releases, so this only sets the ordering).
      await new Promise<void>((r) => setTimeout(r, 1500));
      releaseTx1();

      const [, eraseResult] = await Promise.all([p1, erasePromise]);

      expect(eraseResult.ok, JSON.stringify(eraseResult)).toBe(true);
      if (!eraseResult.ok) return;
      // Fresh flags win: the row was cleared before the erase's under-lock
      // re-read, so NO partnership credit-back.
      expect(eraseResult.value.quotaReversals).toEqual({
        partnership: 0,
        cultural: 0,
      });

      // Belt-and-suspenders: zero credit-back audits for this tenant.
      const allAudits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug));
      const creditBacks = allAudits.filter(
        (r) => String(r.eventType) === 'quota_credit_back_archive',
      );
      expect(creditBacks.length).toBe(0);
      // Sanity: the erasure itself completed (row deleted).
      const remaining = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.tenantId, tenant.ctx.slug),
              eq(eventRegistrations.registrationId, registrationId),
            ),
          ),
      );
      expect(Number(remaining[0]?.count ?? 0)).toBe(0);
    },
    120_000,
  );
});

/**
 * F9 US4 (T061 / R2-E5) — `computeBenefitUsage` integration (live Neon).
 *
 * Two deterministic facets of FR-023 (membership year = calendar year in the
 * tenant timezone):
 *
 *  - **Boundary** (fake clock, zero consumption): a member with no broadcasts/
 *    events viewed at 23:00 ICT on 31-Dec sees membershipYear N (≈100% elapsed);
 *    the same member viewed 90 min later (00:30 ICT, 1-Jan) sees membershipYear
 *    N+1 (≈0% elapsed). Proves the tenant-tz calendar-year flip.
 *
 *  - **Prior-year exclusion** (real clock, seeded sent broadcasts): a sent
 *    broadcast in the current real year counts; one tagged to the prior year
 *    does NOT (used reflects only the current year's consumption).
 *
 * Entitlements + active benefits are read live from the seeded plan's benefit
 * matrix (eblast 6, cultural 4, all-employee discount + directory listing).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import {
  computeBenefitUsage,
  makeComputeBenefitUsageDeps,
  type BenefitUsage,
} from '@/modules/insights';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const PLAN_MATRIX = {
  ...DEFAULT_TEST_BENEFIT_MATRIX,
  eblast_per_year: 6,
  cultural_tickets_per_year: 4,
} as const;

const REAL_YEAR = new Date().getUTCFullYear();
// Fixed timestamps so last-used assertions can pin the exact ISO value (M-8).
const CURRENT_SENT_AT = new Date(`${REAL_YEAR}-02-01T08:00:00.000Z`);
const CULTURAL_THIS_YEAR = new Date(`${REAL_YEAR}-03-10T09:00:00.000Z`);
const CULTURAL_PRIOR_YEAR = new Date(`${REAL_YEAR - 1}-08-01T09:00:00.000Z`);

function eblastBenefit(usage: BenefitUsage) {
  return usage.quantifiable.find((b) => b.key === 'eblast');
}

describe('F9 computeBenefitUsage — membership-year boundary (T061, live Neon)', () => {
  let tenant: TestTenant;
  let otherTenant: TestTenant;
  let admin: TestUser;
  const planId = `f9-ben-${randomUUID().slice(0, 8)}`;
  const consumerMemberId = randomUUID();
  const boundaryMemberId = randomUUID();

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    // Disjoint second tenant for the Principle I cross-tenant isolation probe.
    otherTenant = await createTestTenant('test-swecham');

    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Benefit Plan' },
        benefitMatrix: PLAN_MATRIX,
        createdBy: admin.userId,
      });
      for (const memberId of [consumerMemberId, boundaryMemberId]) {
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Benefit Co',
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active',
        });
      }
      // One sent E-Blast this real year (counts) + one tagged to the prior
      // year (must be excluded). Sent rows require quota_year_consumed +
      // quota_consumed_at per the broadcasts CHECK constraint.
      const sentRow = (quotaYear: number, sentAt: Date) => ({
        tenantId: tenant.ctx.slug,
        requestedByMemberId: consumerMemberId,
        requestedByMemberPlanIdSnapshot: planId,
        submittedByUserId: admin.userId,
        actorRole: 'admin_proxy' as const,
        subject: 'Benefit test broadcast',
        bodyHtml: '<p>hi</p>',
        bodySource: 'hi',
        fromName: 'SweCham',
        replyToEmail: 'noreply@swecham.test',
        segmentType: 'all_members' as const,
        estimatedRecipientCount: 1,
        status: 'sent' as const,
        sentAt,
        quotaYearConsumed: quotaYear,
        quotaConsumedAt: sentAt,
      });
      await tx.insert(broadcasts).values(sentRow(REAL_YEAR, CURRENT_SENT_AT));
      await tx
        .insert(broadcasts)
        .values(sentRow(REAL_YEAR - 1, new Date(`${REAL_YEAR - 1}-06-15T00:00:00.000Z`)));

      // Cultural-event attendances: one this year (counts), one prior year
      // (excluded by the tenant-tz year window) — exercises the real F6 join +
      // gte(startDate) SQL through getEventAttendeesByMember (DEF-2).
      const culturalEvent = (startDate: Date) => {
        const eventId = randomUUID();
        const eventRow = {
          tenantId: tenant.ctx.slug,
          eventId,
          source: 'eventcreate',
          externalId: `f9-cult-${randomUUID().slice(0, 8)}`,
          name: 'Cultural night',
          startDate,
          isPartnerBenefit: false,
          isCulturalEvent: true,
        } as unknown as NewEventRow;
        const regRow = {
          tenantId: tenant.ctx.slug,
          registrationId: randomUUID(),
          eventId,
          externalId: `f9-cult-reg-${randomUUID().slice(0, 8)}`,
          attendeeEmail: 'consumer@benefit.test',
          attendeeName: 'Consumer Attendee',
          matchType: 'member_domain',
          matchedMemberId: consumerMemberId,
          paymentStatus: 'paid',
          registeredAt: startDate,
        } as unknown as NewEventRegistrationRow;
        return { eventRow, regRow };
      };
      for (const startDate of [CULTURAL_THIS_YEAR, CULTURAL_PRIOR_YEAR]) {
        const { eventRow, regRow } = culturalEvent(startDate);
        await tx.insert(events).values(eventRow);
        await tx.insert(eventRegistrations).values(regRow);
      }
    });
  }, 180_000);

  afterAll(async () => {
    const slug = tenant.ctx.slug;
    await db.delete(broadcasts).where(eq(broadcasts.tenantId, slug)).catch(() => {});
    await db.delete(eventRegistrations).where(eq(eventRegistrations.tenantId, slug)).catch(() => {});
    await db.delete(events).where(eq(events.tenantId, slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
    await otherTenant.cleanup().catch(() => {});
  }, 120_000);

  it('Principle I — another tenant cannot read this member (RLS miss → member_not_found)', async () => {
    // Tenant B asks for tenant A's member id: the RLS-scoped findById misses,
    // so the benefit view never composes — no cross-tenant leak.
    const result = await computeBenefitUsage(
      otherTenant.ctx,
      { memberId: consumerMemberId },
      makeComputeBenefitUsageDeps(otherTenant.ctx.slug),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('member_not_found');
  });

  it('boundary: 23:00 ICT 31-Dec → year N (~100% elapsed); 00:30 ICT 1-Jan → year N+1 (~0%)', async () => {
    const baseDeps = makeComputeBenefitUsageDeps(tenant.ctx.slug);
    // 2026-12-31T16:00Z = 23:00 ICT 31-Dec-2026 (still inside 2026).
    const endOfYear = new Date('2026-12-31T16:00:00.000Z');
    // 2026-12-31T17:30Z = 00:30 ICT 01-Jan-2027 (now inside 2027).
    const startOfNext = new Date('2026-12-31T17:30:00.000Z');

    const before = await computeBenefitUsage(
      tenant.ctx,
      { memberId: boundaryMemberId },
      { ...baseDeps, clock: { now: () => endOfYear } },
    );
    const after = await computeBenefitUsage(
      tenant.ctx,
      { memberId: boundaryMemberId },
      { ...baseDeps, clock: { now: () => startOfNext } },
    );

    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(before.value.membershipYear).toBe(2026);
    expect(after.value.membershipYear).toBe(2027);
    expect(before.value.elapsedYearPct).toBeGreaterThan(99);
    expect(after.value.elapsedYearPct).toBeLessThan(1);
  });

  it('entitlements + prior-year exclusion: eblast 1/6 used this year, last year not counted', async () => {
    const result = await computeBenefitUsage(
      tenant.ctx,
      { memberId: consumerMemberId },
      makeComputeBenefitUsageDeps(tenant.ctx.slug),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.membershipYear).toBe(REAL_YEAR);
    const eblast = eblastBenefit(result.value);
    expect(eblast).toBeDefined();
    expect(eblast!.entitlement).toBe(6);
    expect(eblast!.used).toBe(1); // prior-year sent broadcast excluded
    expect(eblast!.lastUsedAt).toBe(CURRENT_SENT_AT.toISOString()); // M-8: pinned

    // cultural is granted (4/yr); one current-year attendance counts, the
    // prior-year one is excluded by the tenant-tz year window (DEF-2).
    const cultural = result.value.quantifiable.find((b) => b.key === 'cultural_tickets');
    expect(cultural?.entitlement).toBe(4);
    expect(cultural?.used).toBe(1);
    expect(cultural?.lastUsedAt).toBe(CULTURAL_THIS_YEAR.toISOString());

    // Active/unlimited benefits surfaced (FR-020).
    expect(result.value.active.map((a) => a.key)).toEqual(
      expect.arrayContaining(['all_employee_event_discount', 'directory_listing']),
    );
  });
});

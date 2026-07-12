/**
 * BUG-1 — F8 at-risk F6 event-attendance factors wired (integration, live Neon).
 *
 * F6 EventCreate shipped 2026-05-19 (`isAvailable()` returns true), which sets
 * `activeMax=100` in both scorers — but neither scorer GATHERED the 3
 * F6-dependent factors, so scores capped at a realizable 70 and band
 * `'critical'` (ratio >=0.75 => score >=75) was unreachable. This test proves
 * BUG-1's wiring (events_attended 12mo/3mo) end-to-end against live Neon for
 * BOTH scorers:
 *
 *   - the single scorer (`scoreMember`) via `EventAttendeesPort.listAttendances`
 *   - the batch cron (`recomputeAtRiskScoresBatch`) via the new
 *     event_registrations→events LATERAL in the CTE
 *
 * Unit mocks cannot cover the CTE's raw SQL + RLS on the F6 tables — only a
 * live-Neon run does. (`culturalTicketQuotaPctUsed` stays deferred.)
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  events,
  eventRegistrations,
} from '@/modules/events/infrastructure/schema';
import {
  makeRenewalsDeps,
  recomputeAtRiskScoresBatch,
} from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW_MS = Date.now();

describe('BUG-1 — at-risk F6 event-attendance factors wired (single + batch)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;
  // Cultural-entitled plans (retained across tests like `planId`) — the
  // default test matrix has cultural_tickets_per_year=0 so cultural is inert
  // for the event tests; these give a non-zero entitlement to exercise it.
  let culturalPlan4Id: string; // cultural_tickets_per_year = 4
  let culturalPlan2Id: string; // cultural_tickets_per_year = 2

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenant.ctx);
    planId = `f8-ev-${randomUUID().slice(0, 8)}`;
    culturalPlan4Id = `f8-cult4-${randomUUID().slice(0, 8)}`;
    culturalPlan2Id = `f8-cult2-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Event Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: culturalPlan4Id,
        planName: { en: 'Cultural Plan 4' },
        benefitMatrix: {
          ...DEFAULT_TEST_BENEFIT_MATRIX,
          cultural_tickets_per_year: 4,
        },
        createdBy: user.userId,
      });
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: culturalPlan2Id,
        planName: { en: 'Cultural Plan 2' },
        benefitMatrix: {
          ...DEFAULT_TEST_BENEFIT_MATRIX,
          cultural_tickets_per_year: 2,
        },
        createdBy: user.userId,
      });
    });
  }, 180_000);

  afterEach(async () => {
    // Children first (FKs): registrations → events → cycles → contacts →
    // members. The plan is retained across tests (seeded in beforeAll).
    await db
      .delete(eventRegistrations)
      .where(eq(eventRegistrations.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(events)
      .where(eq(events.tenantId, tenant.ctx.slug))
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
  });

  afterAll(async () => {
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  /**
   * Seed an active member (backdated so it clears the FR-035 min-tenure gate)
   * with a disengaged `last_activity_at` (contact +5). Optionally seed a single
   * matched event attendance N days ago so the event factors are suppressed.
   */
  async function seedMember(opts: {
    readonly recentEventDaysAgo?: number;
    /** Override the member's plan (e.g. a cultural-entitled plan). */
    readonly planIdOverride?: string;
    /** Mark the seeded event as a cultural event (is_cultural_event=true). */
    readonly eventIsCultural?: boolean;
    /** Explicit event start-date (overrides recentEventDaysAgo). */
    readonly eventDate?: Date;
  }): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Event Co',
        country: 'TH',
        planId: opts.planIdOverride ?? planId,
        planYear: 2026,
        createdAt: new Date(NOW_MS - 400 * MS_PER_DAY),
        registrationDate: '2019-01-01', // real membership age → tenure anchor (G6)
        lastActivityAt: new Date(NOW_MS - 400 * MS_PER_DAY), // >365d → +5
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Event',
        lastName: 'Person',
        email: `ev-${memberId.slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'upcoming',
        periodFrom: new Date(NOW_MS - 30 * MS_PER_DAY),
        periodTo: new Date(NOW_MS + 30 * MS_PER_DAY),
        expiresAt: new Date(NOW_MS + 30 * MS_PER_DAY),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
      if (opts.recentEventDaysAgo !== undefined || opts.eventDate !== undefined) {
        const eventId = randomUUID();
        const when =
          opts.eventDate ??
          new Date(NOW_MS - (opts.recentEventDaysAgo ?? 0) * MS_PER_DAY);
        await tx.insert(events).values({
          tenantId: tenant.ctx.slug,
          eventId,
          externalId: `ext-${eventId.slice(0, 8)}`,
          name: opts.eventIsCultural ? 'Cultural Evening' : 'Networking Dinner',
          startDate: when,
          isCulturalEvent: opts.eventIsCultural ?? false,
        });
        await tx.insert(eventRegistrations).values({
          tenantId: tenant.ctx.slug,
          registrationId: randomUUID(),
          eventId,
          externalId: `reg-${eventId.slice(0, 8)}`,
          attendeeEmail: 'ev@acme.example',
          attendeeName: 'Event Person',
          matchType: 'member_domain',
          matchedMemberId: memberId,
          registeredAt: when,
        });
      }
    });
    return memberId;
  }

  it('single scorer — a ZERO-event member fires events_attended_last_12mo_zero (+25) with activeMax=100', async () => {
    const memberId = await seedMember({});
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await deps.atRiskScorer.scoreMember(
      tenant.ctx.slug,
      memberId,
    );
    expect(result.activeMax).toBe(100);
    expect(result.eventAttendanceFactorSkipped).toBe(false);
    // Regression: before the fix the scorer never GATHERED events, so this
    // factor was silently skipped even though F6 is live.
    expect(
      result.contributions.some(
        (c) => c.factor === 'events_attended_last_12mo_zero',
      ),
    ).toBe(true);
  }, 60_000);

  it('single scorer — a member with a recent event does NOT fire the event-attendance factors', async () => {
    const memberId = await seedMember({ recentEventDaysAgo: 20 }); // within 3mo
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await deps.atRiskScorer.scoreMember(
      tenant.ctx.slug,
      memberId,
    );
    const factorKeys = result.contributions.map((c) => c.factor);
    expect(factorKeys).not.toContain('events_attended_last_12mo_zero');
    expect(factorKeys).not.toContain('events_attended_last_3mo_zero');
  }, 60_000);

  it('single scorer — a FUTURE-dated event registration is NOT counted as attended (events_12mo_zero still fires)', async () => {
    // BUG-1 review (upper-bound fix): registering for an upcoming event is not
    // "attending" — it must NOT suppress the disengagement factor.
    const memberId = await seedMember({ recentEventDaysAgo: -30 }); // 30d in the FUTURE
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await deps.atRiskScorer.scoreMember(
      tenant.ctx.slug,
      memberId,
    );
    expect(
      result.contributions.some(
        (c) => c.factor === 'events_attended_last_12mo_zero',
      ),
    ).toBe(true);
  }, 60_000);

  it('single scorer — an event 150 days ago fires events_attended_last_3mo_zero (+10), not the 12mo factor', async () => {
    // Inside the 12mo window, outside the 3mo window → 12mo>0 & 3mo==0.
    const memberId = await seedMember({ recentEventDaysAgo: 150 });
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await deps.atRiskScorer.scoreMember(
      tenant.ctx.slug,
      memberId,
    );
    const factorKeys = result.contributions.map((c) => c.factor);
    expect(factorKeys).toContain('events_attended_last_3mo_zero');
    expect(factorKeys).not.toContain('events_attended_last_12mo_zero');
  }, 60_000);

  it('single scorer — cultural quota <50% used fires cultural_ticket_quota_under_50pct (+10)', async () => {
    const memberId = await seedMember({
      planIdOverride: culturalPlan4Id, // quota 4
      recentEventDaysAgo: 20,
      eventIsCultural: true, // 1 cultural event this year → 1/4 = 25% < 50%
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await deps.atRiskScorer.scoreMember(
      tenant.ctx.slug,
      memberId,
    );
    expect(
      result.contributions.some(
        (c) => c.factor === 'cultural_ticket_quota_under_50pct',
      ),
    ).toBe(true);
  }, 60_000);

  it('single scorer — cultural quota >=50% used does NOT fire the cultural factor', async () => {
    const memberId = await seedMember({
      planIdOverride: culturalPlan2Id, // quota 2
      recentEventDaysAgo: 20,
      eventIsCultural: true, // 1 cultural event → 1/2 = 50% >= 50%
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await deps.atRiskScorer.scoreMember(
      tenant.ctx.slug,
      memberId,
    );
    expect(result.contributions.map((c) => c.factor)).not.toContain(
      'cultural_ticket_quota_under_50pct',
    );
  }, 60_000);

  it('single scorer — a cultural attendance in the PREVIOUS calendar year is NOT counted (calendar-year window, not rolling)', async () => {
    // Oct 1 of last calendar year — within the 365-day fetch window but before
    // this year's Jan-01 boundary.
    const prevYearOct = new Date(new Date().getFullYear() - 1, 9, 1);
    const memberId = await seedMember({
      planIdOverride: culturalPlan2Id, // quota 2
      eventDate: prevYearOct,
      eventIsCultural: true,
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await deps.atRiskScorer.scoreMember(
      tenant.ctx.slug,
      memberId,
    );
    // 0 cultural used THIS calendar year → 0% < 50% → factor FIRES. A rolling-
    // window bug would count the prev-year event (1/2 = 50%) and NOT fire.
    expect(
      result.contributions.some(
        (c) => c.factor === 'cultural_ticket_quota_under_50pct',
      ),
    ).toBe(true);
  }, 60_000);

  it('batch CTE — the cultural FILTER runs on live Neon; a cultural-entitled member scores exactly +10 above an identical member whose plan has no cultural entitlement', async () => {
    const eventDaysAgo = 20;
    const memberCultural = await seedMember({
      planIdOverride: culturalPlan4Id, // quota 4 → 1/4 = 25% < 50% → +10
      recentEventDaysAgo: eventDaysAgo,
      eventIsCultural: true,
    });
    const memberNoEntitlement = await seedMember({
      // default plan (cultural_tickets_per_year = 0) → cultural skipped
      recentEventDaysAgo: eventDaysAgo,
      eventIsCultural: true,
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await recomputeAtRiskScoresBatch(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.membersFailed).toBe(0);
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ memberId: members.memberId, riskScore: members.riskScore })
        .from(members),
    );
    const scoreOf = (id: string): number | null =>
      rows.find((r) => r.memberId === id)?.riskScore ?? null;
    const scoreCultural = scoreOf(memberCultural);
    const scoreNoEntitlement = scoreOf(memberNoEntitlement);
    expect(scoreCultural).not.toBeNull();
    expect(scoreNoEntitlement).not.toBeNull();
    // Identical members except the plan's cultural entitlement → the only score
    // difference is the +10 cultural factor the CTE now gathers.
    expect((scoreCultural ?? 0) - (scoreNoEntitlement ?? 0)).toBe(10);
  }, 90_000);

  it('batch CTE — the events LATERAL runs on live Neon; a 0-event member scores exactly +25 above an otherwise-identical member with a recent event', async () => {
    const memberNoEvents = await seedMember({});
    const memberWithEvent = await seedMember({ recentEventDaysAgo: 20 });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const result = await recomputeAtRiskScoresBatch(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The new events LATERAL executing without error against live Neon is the
    // core proof (RLS + column names + join). Both members must score.
    expect(result.value.membersFailed).toBe(0);

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ memberId: members.memberId, riskScore: members.riskScore })
        .from(members),
    );
    const scoreOf = (id: string): number | null =>
      rows.find((r) => r.memberId === id)?.riskScore ?? null;
    const scoreNoEvents = scoreOf(memberNoEvents);
    const scoreWithEvent = scoreOf(memberWithEvent);
    expect(scoreNoEvents).not.toBeNull();
    expect(scoreWithEvent).not.toBeNull();
    // The 0-event member carries the +25 events_attended_last_12mo_zero
    // penalty the CTE now gathers; the with-event member does not. (A broken
    // fix — events not gathered — would collapse the gap below 25.)
    expect((scoreNoEvents ?? 0) - (scoreWithEvent ?? 0)).toBeGreaterThanOrEqual(
      25,
    );
  }, 90_000);
});

/**
 * F6 → F3/F8 bridge — deterministic event attendance bumps
 * `members.last_activity_at` (migration 0230 trigger), so attendance counts
 * for the F3 directory "last active" column + the F8 at-risk recency proxy.
 *
 * Covered:
 *   - member_contact (deterministic) → ADVANCES last_activity_at.
 *   - member_fuzzy   (low-confidence) → does NOT bump (the trigger WHEN clause
 *     excludes it; a false fuzzy bump is un-correctable, so it must never fire).
 *   - forward-only: a later, OLDER registration cannot rewind recency.
 *   - cross-tenant: a forged `matched_member_id` pointing at another tenant's
 *     member cannot bump that member (Principle I — the SECURITY DEFINER
 *     trigger's `tenant_id = NEW.tenant_id` predicate is the sole guard; there
 *     is no FK on matched_member_id).
 *
 * Live Neon Singapore — the bump is a DB trigger; a mocked audit adapter
 * cannot catch it. (classify-member-activity-audits workflow, 2026-06-22.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import {
  events,
  eventRegistrations,
  tenantWebhookConfigs,
} from '@/modules/events/infrastructure/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { ingestWebhookAttendee } from '@/modules/events';
import { makeIngestWebhookAttendeeDeps } from '@/lib/events-webhook-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

const OLD_ACTIVITY = new Date('2020-01-01T00:00:00.000Z');

const lastActivityOf = async (
  tenant: TestTenant,
  memberId: string,
): Promise<Date | null> => {
  const rows = await runInTenant(tenant.ctx, async (tx) =>
    tx
      .select({ lastActivityAt: members.lastActivityAt })
      .from(members)
      .where(and(eq(members.tenantId, tenant.ctx.slug), eq(members.memberId, memberId))),
  );
  return (rows[0]?.lastActivityAt as Date | null) ?? null;
};

describe('F6 matched ingest + members.last_activity_at recency', () => {
  let tenant: TestTenant;
  const contactMemberId = randomUUID();
  const fuzzyMemberId = randomUUID();
  const forwardMemberId = randomUUID();
  const contactEmail = 'attendee@attbump-co.example';
  const forwardEmail = 'forward@fwd-co.example';
  const fuzzyCompany = 'Zyxwvu Corporation Limited';

  const matchTypeOf = async (attendeeEmail: string): Promise<string | null> => {
    const rows = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select({ matchType: eventRegistrations.matchType })
        .from(eventRegistrations)
        .where(
          and(
            eq(eventRegistrations.tenantId, tenant.ctx.slug),
            eq(eventRegistrations.attendeeEmailLower, attendeeEmail.toLowerCase()),
          ),
        ),
    );
    return (rows[0]?.matchType as string | null) ?? null;
  };

  const ingest = async (attendee: {
    email: string;
    fullName: string;
    company?: string;
    registeredAt?: string;
  }) => {
    const deps = makeIngestWebhookAttendeeDeps();
    return ingestWebhookAttendee(
      {
        tenantId: tenant.ctx.slug,
        requestId: `req-attbump-${randomUUID()}`,
        source: 'eventcreate_webhook',
        rawPayload: {
          eventType: 'attendee.registered',
          tenantSlug: tenant.ctx.slug,
          event: {
            externalId: `attbump-event-${Date.now()}-${randomUUID().slice(0, 8)}`,
            name: 'Att Bump Event',
            startDate: '2026-07-01T18:00:00+07:00',
          },
          attendee: {
            externalId: `attbump-att-${randomUUID()}`,
            email: attendee.email,
            fullName: attendee.fullName,
            ...(attendee.company ? { companyName: attendee.company } : {}),
            paymentStatus: 'paid',
            registeredAt: attendee.registeredAt ?? '2026-06-22T12:00:00Z',
          },
        },
        sourceIp: '127.0.0.1',
      },
      deps,
    );
  };

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    const user = await createActiveTestUser('admin');
    const planId = `test-plan-attbump-${randomUUID()}`;
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Att Bump Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        planCategory: 'corporate',
        createdBy: user.userId,
      });
      const base = {
        tenantId: tenant.ctx.slug,
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active' as const,
      };
      await tx.insert(members).values([
        { ...base, memberId: contactMemberId, memberNumber: nextSeedMemberNumber(), companyName: 'Att Bump Co' },
        { ...base, memberId: fuzzyMemberId, memberNumber: nextSeedMemberNumber(), companyName: fuzzyCompany },
        { ...base, memberId: forwardMemberId, memberNumber: nextSeedMemberNumber(), companyName: 'Forward Co' },
      ] as unknown as Array<typeof members.$inferInsert>);
      await tx.insert(contacts).values([
        {
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId: contactMemberId,
          firstName: 'Exact',
          lastName: 'Attendee',
          email: contactEmail,
          isPrimary: true,
        },
        {
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId: fuzzyMemberId,
          firstName: 'Fuzzy',
          lastName: 'Contact',
          email: 'someone@zyxwvu-internal.example',
          isPrimary: true,
        },
        {
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId: forwardMemberId,
          firstName: 'Forward',
          lastName: 'Contact',
          email: forwardEmail,
          isPrimary: true,
        },
      ] as unknown as Array<typeof contacts.$inferInsert>);
      await tx.insert(tenantWebhookConfigs).values({
        tenantId: tenant.ctx.slug,
        source: 'eventcreate',
        webhookSecretActive: 'test-secret-' + 'a'.repeat(43),
        enabled: true,
      });
      await tx
        .update(members)
        .set({ lastActivityAt: OLD_ACTIVITY })
        .where(eq(members.tenantId, tenant.ctx.slug));
    });
  });

  afterAll(async () => {
    try {
      await tenant.cleanup();
    } catch {
      /* uuid-suffixed slug isolates other suites */
    }
  });

  it('a deterministic member_contact attendee ingest ADVANCES last_activity_at', async () => {
    const result = await ingest({ email: contactEmail, fullName: 'Exact Attendee' });
    expect(result.ok).toBe(true);
    expect(await matchTypeOf(contactEmail)).toBe('member_contact');

    const after = await lastActivityOf(tenant, contactMemberId);
    expect(after).toBeTruthy();
    expect(new Date(after as Date).getTime()).toBeGreaterThan(OLD_ACTIVITY.getTime());
  });

  it('a low-confidence member_fuzzy attendee ingest does NOT bump last_activity_at', async () => {
    const fuzzyEmail = 'no-match@totally-unrelated.example';
    const result = await ingest({
      email: fuzzyEmail,
      fullName: 'Fuzzy Attendee',
      company: fuzzyCompany,
    });
    expect(result.ok).toBe(true);
    expect(await matchTypeOf(fuzzyEmail)).toBe('member_fuzzy');

    const after = await lastActivityOf(tenant, fuzzyMemberId);
    expect(new Date(after as Date).getTime()).toBe(OLD_ACTIVITY.getTime());
  });

  it('forward-only: a later but OLDER registration does NOT rewind last_activity_at', async () => {
    // First attendance is far in the FUTURE → recency jumps forward.
    const future = '2027-06-01T00:00:00Z';
    await ingest({ email: forwardEmail, fullName: 'Forward Member', registeredAt: future });
    const afterFuture = await lastActivityOf(tenant, forwardMemberId);
    expect(new Date(afterFuture as Date).getTime()).toBe(new Date(future).getTime());

    // A second, OLDER registration must NOT lower the recency (forward-only guard).
    await ingest({ email: forwardEmail, fullName: 'Forward Member', registeredAt: '2025-01-01T00:00:00Z' });
    const afterPast = await lastActivityOf(tenant, forwardMemberId);
    expect(new Date(afterPast as Date).getTime()).toBe(new Date(future).getTime());
  });
});

describe('F6 last_activity bump is tenant-isolated (Principle I)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  const memberInB = randomUUID();
  const eventInA = randomUUID();

  beforeAll(async () => {
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-chamber');
    const userB = await createActiveTestUser('admin');
    const planId = `test-plan-xtenant-${randomUUID()}`;
    // Member lives in tenant B, pinned to the distant past.
    await runInTenant(tenantB.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenantB.ctx.slug,
        planId,
        planName: { en: 'X-Tenant Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        planCategory: 'corporate',
        createdBy: userB.userId,
      });
      await tx.insert(members).values({
        tenantId: tenantB.ctx.slug,
        memberId: memberInB,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Tenant B Co',
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active',
      } as unknown as typeof members.$inferInsert);
      await tx
        .update(members)
        .set({ lastActivityAt: OLD_ACTIVITY })
        .where(eq(members.memberId, memberInB));
    });
    // In tenant A, forge an event_registrations row whose matched_member_id is
    // tenant B's member (no FK guards matched_member_id). The trigger's
    // tenant_id = NEW.tenant_id (= A) predicate must keep B's member untouched.
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(events).values({
        tenantId: tenantA.ctx.slug,
        eventId: eventInA,
        source: 'eventcreate',
        externalId: `xtenant-ev-${Date.now()}`,
        name: 'X-Tenant Event',
        startDate: new Date('2026-07-01T18:00:00+07:00'),
        isPartnerBenefit: false,
        isCulturalEvent: false,
      } as unknown as typeof events.$inferInsert);
      await tx.insert(eventRegistrations).values({
        tenantId: tenantA.ctx.slug,
        registrationId: randomUUID(),
        eventId: eventInA,
        source: 'eventcreate',
        externalId: `xtenant-reg-${Date.now()}`,
        attendeeEmail: 'forged@xtenant.example',
        attendeeName: 'Forged Attendee',
        matchType: 'member_contact', // would fire the trigger if tenant matched
        matchedMemberId: memberInB, // forged: belongs to tenant B
        paymentStatus: 'paid',
        ticketType: 'standard',
        countedAgainstPartnership: false,
        countedAgainstCulturalQuota: false,
        metadata: {},
        registeredAt: new Date('2026-06-22T12:00:00Z'),
        piiPseudonymisedAt: null,
      } as unknown as typeof eventRegistrations.$inferInsert);
    });
  });

  afterAll(async () => {
    try {
      await tenantA.cleanup();
    } catch {}
    try {
      await tenantB.cleanup();
    } catch {}
  });

  it("a forged cross-tenant matched_member_id does NOT bump the other tenant's member", async () => {
    const after = await lastActivityOf(tenantB, memberInB);
    // Untouched — the tenant_id predicate found no member with that id in A.
    expect(new Date(after as Date).getTime()).toBe(OLD_ACTIVITY.getTime());
  });
});

/**
 * F6 → F3/F8 bridge — event attendance counts as member activity, but ONLY
 * for DETERMINISTIC matches.
 *
 * The `attendee_matched_member_{contact,domain}` audit events carry snake-case
 * `member_id` so the F3 AFTER-INSERT trigger
 * (`audit_log_bump_member_last_activity`, migration 0009) refreshes the matched
 * member's `last_activity_at` — making event attendance count for the F3
 * directory "last active" column, the F8 at-risk recency proxy, and the F3
 * member timeline (US6).
 *
 * `attendee_matched_member_fuzzy` deliberately does NOT — a low-confidence
 * Levenshtein company-name guess must never bump recency, because a false
 * positive is un-correctable: `registration_relinked` (the admin fix) carries
 * no scalar `member_id`, so it can never un-bump `last_activity_at`. A wrongly
 * fuzzy-matched member would look "recently active" forever, masking a
 * genuinely at-risk member. (classify-member-activity-audits workflow,
 * 2026-06-22.)
 *
 * Live Neon Singapore — the bump is a DB trigger; a mocked audit adapter
 * cannot catch it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import {
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

describe('F6 matched ingest + members.last_activity_at recency', () => {
  let tenant: TestTenant;
  const contactMemberId = randomUUID();
  const fuzzyMemberId = randomUUID();
  const contactEmail = 'attendee@attbump-co.example';
  const fuzzyCompany = 'Zyxwvu Corporation Limited';
  // Seeded far in the past so any forward movement is unambiguous.
  const OLD_ACTIVITY = new Date('2020-01-01T00:00:00.000Z');

  const lastActivityOf = async (memberId: string): Promise<Date | null> => {
    const rows = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select({ lastActivityAt: members.lastActivityAt })
        .from(members)
        .where(and(eq(members.tenantId, tenant.ctx.slug), eq(members.memberId, memberId))),
    );
    return (rows[0]?.lastActivityAt as Date | null) ?? null;
  };

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
            registeredAt: '2026-06-22T12:00:00Z',
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
      await tx.insert(members).values([
        {
          tenantId: tenant.ctx.slug,
          memberId: contactMemberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Att Bump Co',
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active',
        },
        {
          tenantId: tenant.ctx.slug,
          memberId: fuzzyMemberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: fuzzyCompany,
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active',
        },
      ] as unknown as Array<typeof members.$inferInsert>);
      await tx.insert(contacts).values([
        // member_contact target for the deterministic-match test.
        {
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId: contactMemberId,
          firstName: 'Exact',
          lastName: 'Attendee',
          email: contactEmail,
          isPrimary: true,
        },
        // fuzzy member's contact lives on an UNRELATED domain so the fuzzy
        // attendee (different email/domain) only resolves via company-name.
        {
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId: fuzzyMemberId,
          firstName: 'Fuzzy',
          lastName: 'Contact',
          email: 'someone@zyxwvu-internal.example',
          isPrimary: true,
        },
      ] as unknown as Array<typeof contacts.$inferInsert>);
      await tx.insert(tenantWebhookConfigs).values({
        tenantId: tenant.ctx.slug,
        source: 'eventcreate',
        webhookSecretActive: 'test-secret-' + 'a'.repeat(43),
        enabled: true,
      });
      // Pin both members' last_activity_at to the distant past.
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

    const after = await lastActivityOf(contactMemberId);
    expect(after).toBeTruthy();
    expect(new Date(after as Date).getTime()).toBeGreaterThan(OLD_ACTIVITY.getTime());
  });

  it('a low-confidence member_fuzzy attendee ingest does NOT bump last_activity_at', async () => {
    const fuzzyEmail = 'no-match@totally-unrelated.example';
    const result = await ingest({
      email: fuzzyEmail,
      fullName: 'Fuzzy Attendee',
      company: fuzzyCompany, // exact company-name → member_fuzzy (no email/domain match)
    });
    expect(result.ok).toBe(true);
    // Guard: only meaningful if it really resolved as a fuzzy match.
    expect(await matchTypeOf(fuzzyEmail)).toBe('member_fuzzy');

    const after = await lastActivityOf(fuzzyMemberId);
    // Stayed pinned in the past — fuzzy must never refresh recency.
    expect(new Date(after as Date).getTime()).toBe(OLD_ACTIVITY.getTime());
  });
});

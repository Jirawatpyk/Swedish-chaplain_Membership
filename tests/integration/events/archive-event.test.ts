/**
 * F6 Phase 6 wave-4 — archive-event integration test (live Neon Singapore).
 *
 * Verifies FR-019a end-to-end through the production `runArchiveEvent`
 * composition root:
 *   1. archive flips `events.archived_at` from null → timestamp
 *   2. every counted_against_* row credits back (flag flips to false)
 *   3. N × quota_credit_back_archive audits emitted (one per
 *      previously-true scope)
 *   4. macro event_archived audit emitted with the correct
 *      registrationsAffected + quotaReversals.{partnership,cultural}
 *      counts
 *   5. event_not_found + already_archived error paths
 *   6. Quota-neutral property: a webhook delivery AFTER archive does
 *      NOT decrement quota (apply-quota-effect short-circuits on
 *      event.archivedAt !== null)
 *
 * Spec authority:
 *   - FR-019a (archive sets archived_at + reverses counted_against_*)
 *   - research.md R5 advisory lock + computed-on-read
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant, db } from '@/lib/db';
import {
  events,
  eventRegistrations,
  tenantWebhookConfigs,
} from '@/modules/events/infrastructure/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { ingestWebhookAttendee } from '@/modules/events';
import { makeIngestWebhookAttendeeDeps } from '@/lib/events-webhook-deps';
import { runArchiveEvent } from '@/lib/events-admin-deps';
import { asUserId } from '@/modules/auth';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createActiveTestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { makeWebhookPayload } from './helpers/sign-webhook';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';

const diamondMatrix: BenefitMatrix = {
  ...DEFAULT_TEST_BENEFIT_MATRIX,
  cultural_tickets_per_year: 0,
  partnership: {
    event_tickets_included: 6,
    booth_included: true,
    rollup_logo_at_events: true,
    logo_on_merch: true,
    video_duration_minutes: 1.5,
    video_frequency_scope: 'all_events',
    website_logo_months: 12,
    banner_per_year: 20,
    newsletter_promotion: true,
    enewsletter_logo: true,
    directory_ad_position: 'pages_1_and_2',
  },
};

const premiumMatrix: BenefitMatrix = {
  ...DEFAULT_TEST_BENEFIT_MATRIX,
  cultural_tickets_per_year: 2,
  partnership: null,
};

describe('F6 wave-4 — archiveEvent (FR-019a)', () => {
  describe('archive credit-back: 3 counted rows → 3 credit-back audits + macro event_archived', () => {
    let tenant: TestTenant;
    const corpPlanId = `test-plan-arch-corp-${randomUUID()}`;
    const partnershipPlanId = `test-plan-arch-partner-${randomUUID()}`;
    const memberId = randomUUID();
    let userId: string;
    let eventInternalId: string;
    const eventExternalId = `event_archive_${Date.now()}`;

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      const user = await createActiveTestUser('admin');
      userId = user.userId;
      await runInTenant(tenant.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: corpPlanId,
          planName: { en: 'Corp Bundle (archive)' },
          benefitMatrix: premiumMatrix,
          planCategory: 'corporate',
          createdBy: user.userId,
        });
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: partnershipPlanId,
          planName: { en: 'Diamond Partnership (archive)' },
          benefitMatrix: diamondMatrix,
          planCategory: 'partnership',
          includesCorporatePlanId: corpPlanId,
          createdBy: user.userId,
        });
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          companyName: 'Archive Test Co',
          country: 'TH',
          planId: partnershipPlanId,
          planYear: 2026,
          status: 'active',
        } as unknown as typeof members.$inferInsert);
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId,
          firstName: 'Jane',
          lastName: 'Archive',
          email: 'jane@archive.example',
          isPrimary: true,
        } as unknown as typeof contacts.$inferInsert);
        await tx.insert(tenantWebhookConfigs).values({
          tenantId: tenant.ctx.slug,
          source: 'eventcreate',
          webhookSecretActive: 'test-secret-' + 'a'.repeat(43),
          enabled: true,
        });
      });
      eventInternalId = randomUUID();
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(events).values({
          tenantId: tenant.ctx.slug,
          eventId: eventInternalId,
          source: 'eventcreate',
          externalId: eventExternalId,
          name: 'Archive Test Event',
          startDate: new Date('2026-06-21T18:00:00+07:00'),
          isPartnerBenefit: true,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
      });
      // 3 ingests → all 3 counted_against_partnership=true
      const deps = makeIngestWebhookAttendeeDeps();
      for (let i = 0; i < 3; i++) {
        const result = await ingestWebhookAttendee(
          {
            tenantId: tenant.ctx.slug,
            requestId: `req-arch-pre-${Date.now()}-${i}`,
            source: 'eventcreate_webhook',
            rawPayload: makeWebhookPayload({
              event: {
                externalId: eventExternalId,
                name: 'Archive Test Event',
                startDate: '2026-06-21T18:00:00+07:00',
              },
              attendee: {
                externalId: `att_arch_${i}`,
                email: i === 0 ? 'jane@archive.example' : `worker${i}@archive.example`,
                companyName: 'Archive Test Co',
                fullName: `Worker ${i}`,
              },
            }),
            sourceIp: '127.0.0.1',
          },
          deps,
        );
        expect(result.ok).toBe(true);
      }
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('archive → archived_at set + 3 rows flip counted=false + 3 credit-back audits + macro event_archived', async () => {
      const result = await runArchiveEvent(tenant.ctx.slug, {
        eventId: eventInternalId as never,
        actorUserId: asUserId(userId),
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.registrationsAffected).toBe(3);
        expect(result.value.quotaReversals.partnership).toBe(3);
        expect(result.value.quotaReversals.cultural).toBe(0);
        expect(result.value.event.archivedAt).not.toBeNull();
      }

      // Event row archived
      const evRow = await runInTenant(tenant.ctx, (tx) =>
        tx.select().from(events).where(eq(events.eventId, eventInternalId)),
      );
      expect(evRow.length).toBe(1);
      expect(evRow[0]!.archivedAt).not.toBeNull();

      // All 3 registration rows credit-backed
      const rows = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(eq(eventRegistrations.matchedMemberId, memberId)),
      );
      expect(rows.length).toBe(3);
      expect(rows.every((r) => r.countedAgainstPartnership === false)).toBe(true);

      // Audit trail
      const allAudits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug));
      const creditBacks = allAudits.filter(
        (r) => String(r.eventType) === 'quota_credit_back_archive',
      );
      expect(creditBacks.length).toBe(3);
      expect(
        creditBacks.every(
          (r) => (r.payload as Record<string, unknown>).scope === 'partnership',
        ),
      ).toBe(true);

      const macroAudits = allAudits.filter(
        (r) => String(r.eventType) === 'event_archived',
      );
      expect(macroAudits.length).toBe(1);
      const macroPayload = macroAudits[0]!.payload as Record<string, unknown>;
      expect(macroPayload.registrationsAffected).toBe(3);
      const reversals = macroPayload.quotaReversals as Record<string, number>;
      expect(reversals.partnership).toBe(3);
      expect(reversals.cultural).toBe(0);
    });

    it('post-archive webhook delivery → quota-neutral (apply-quota-effect short-circuits on archivedAt)', async () => {
      const deps = makeIngestWebhookAttendeeDeps();
      const result = await ingestWebhookAttendee(
        {
          tenantId: tenant.ctx.slug,
          requestId: `req-post-arch-${Date.now()}`,
          source: 'eventcreate_webhook',
          rawPayload: makeWebhookPayload({
            event: {
              externalId: eventExternalId,
              name: 'Archive Test Event',
              startDate: '2026-06-21T18:00:00+07:00',
            },
            attendee: {
              externalId: `att_post_archive_${Date.now()}`,
              email: 'late@archive.example',
              companyName: 'Archive Test Co',
              fullName: 'Late Worker',
            },
          }),
          sourceIp: '127.0.0.1',
        },
        deps,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The new row must NOT be counted — archive short-circuits
        expect(result.value.quotaEffect.countedAgainstPartnership).toBe(false);
        expect(result.value.quotaEffect.countedAgainstCulturalQuota).toBe(false);
      }

      // No new partnership-decremented audit for the post-archive
      // delivery (the only previous decrements were the 3 pre-archive
      // ingests, since credited-back).
      const allAudits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug));
      const decrements = allAudits.filter(
        (r) => String(r.eventType) === 'quota_partnership_decremented',
      );
      expect(decrements.length).toBe(3); // unchanged from pre-archive
    });
  });

  describe('error paths', () => {
    let tenant: TestTenant;
    let userId: string;

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      const user = await createActiveTestUser('admin');
      userId = user.userId;
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('event_not_found when eventId does not exist in this tenant', async () => {
      const result = await runArchiveEvent(tenant.ctx.slug, {
        eventId: randomUUID() as never,
        actorUserId: asUserId(userId),
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('event_not_found');
      }
    });

    it('already_archived when archivedAt is non-null', async () => {
      const archivedEventId = randomUUID();
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(events).values({
          tenantId: tenant.ctx.slug,
          eventId: archivedEventId,
          source: 'eventcreate',
          externalId: `event_already_arch_${Date.now()}`,
          name: 'Pre-archived Event',
          startDate: new Date('2026-06-21T18:00:00+07:00'),
          archivedAt: new Date(),
          isPartnerBenefit: false,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
      });

      const result = await runArchiveEvent(tenant.ctx.slug, {
        eventId: archivedEventId as never,
        actorUserId: asUserId(userId),
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('already_archived');
      }
    });
  });
});

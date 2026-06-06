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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eventcreateMetrics } from '@/lib/metrics';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant, db } from '@/lib/db';
import {
  events,
  eventRegistrations,
  tenantWebhookConfigs,
} from '@/modules/events/infrastructure/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
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
          memberNumber: nextSeedMemberNumber(),
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

    it('archive → archived_at set + 3 rows flip counted=false + 3 credit-back audits + macro event_archived + duration histogram fired (R7 TEST-FR-03)', async () => {
      // R7 TEST-FR-03 closure — spy on the duration histogram emit so
      // the SLO-F6-007 signal is verified to fire from the wrapper's
      // try/finally (and so a future regression that drops the
      // `finally` block surfaces here, not silently in production).
      const durationSpy = vi.spyOn(eventcreateMetrics, 'archiveDurationMs');
      const result = await runArchiveEvent(tenant.ctx.slug, {
        eventId: eventInternalId as never,
        actorUserId: asUserId(userId),
        occurredAt: new Date(),
      });
      try {
        expect(durationSpy).toHaveBeenCalledTimes(1);
        const [calledTenantSlug, calledLatencyMs] = durationSpy.mock.calls[0]!;
        expect(calledTenantSlug).toBe(tenant.ctx.slug);
        expect(calledLatencyMs).toBeGreaterThanOrEqual(0); // monotonic clock + clamp
        expect(calledLatencyMs).toBeLessThan(60_000); // sanity vs maxDuration ceiling
      } finally {
        durationSpy.mockRestore();
      }
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

  /**
   * Phase 6 staff-review-4 WARN-3 — cross-tenant UPDATE probe.
   * Constitution v1.4.0 Principle I (NON-NEG) Review-Gate blocker
   * requires every UPDATE surface to demonstrate that an actor in
   * Tenant A cannot mutate Tenant B's data. The archive use-case is
   * an UPDATE (events.archived_at + event_registrations.counted_*) so
   * it MUST be exercised here.
   *
   * **R6 ARCH-R6-01 strengthening**: in addition to the bare-event
   * probe (which only exercises the `events.findById` SELECT gate),
   * Tenant B is now seeded with a counted-true `event_registrations`
   * row. After the cross-tenant probe attempts the archive, we
   * separately verify that Tenant B's registration row STILL has
   * `counted_against_partnership = true` — confirming the multi-step
   * UPDATE path (setArchived + per-row setQuotaEffect) cannot reach
   * across tenants even if the SELECT gate were somehow bypassed.
   */
  describe('cross-tenant isolation (WARN-3 staff-review-4 — Principle I Review-Gate)', () => {
    let tenantA: TestTenant;
    let tenantB: TestTenant;
    let userA: string;
    const tenantBEventId = randomUUID();
    const tenantBMemberId = randomUUID();
    const tenantBRegistrationId = randomUUID();

    beforeAll(async () => {
      tenantA = await createTestTenant('test-swecham');
      tenantB = await createTestTenant('test-chamber');
      const u = await createActiveTestUser('admin');
      userA = u.userId;

      // Seed Tenant B's event row + a counted registration so the
      // probe exercises the FULL archive path (setArchived would also
      // re-write event_registrations.counted_* if RLS were bypassed).
      const tenantBPlanId = `tenantB-plan-${randomUUID().slice(0, 8)}`;
      await runInTenant(tenantB.ctx, async (tx) => {
        // Plan + member needed for the event_registrations FK.
        // Use planCategory='corporate' here to sidestep the
        // `partnership_bundles_corporate` CHECK constraint that requires
        // a partnership plan to bundle a corporate plan via
        // includesCorporatePlanId — this cross-tenant probe only needs
        // a valid plan/member row to drive the RLS test.
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenantB.ctx.slug,
          planId: tenantBPlanId,
          planName: { en: 'TenantB Corporate (cross-tenant probe)' },
          benefitMatrix: diamondMatrix,
          planCategory: 'corporate',
          createdBy: userA,
        });
        await tx.insert(members).values({
          tenantId: tenantB.ctx.slug,
          memberId: tenantBMemberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'TenantB Co',
          country: 'TH',
          planId: tenantBPlanId,
          planYear: 2026,
          status: 'active',
        } as unknown as typeof members.$inferInsert);
        await tx.insert(events).values({
          tenantId: tenantB.ctx.slug,
          eventId: tenantBEventId,
          source: 'eventcreate',
          externalId: `event_tenantB_${Date.now()}`,
          name: 'Tenant-B Event (must remain active)',
          startDate: new Date('2026-09-15T18:00:00+07:00'),
          archivedAt: null,
          isPartnerBenefit: true,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
        await tx.insert(eventRegistrations).values({
          tenantId: tenantB.ctx.slug,
          registrationId: tenantBRegistrationId,
          eventId: tenantBEventId,
          externalId: `att_tenantB_${Date.now()}`,
          attendeeEmail: 'tenantB-attendee@example.com',
          attendeeName: 'TenantB Attendee',
          attendeeCompany: 'TenantB Co',
          matchType: 'member_contact',
          matchedMemberId: tenantBMemberId,
          matchedContactId: null,
          ticketType: null,
          ticketPriceThb: null,
          paymentStatus: 'paid',
          countedAgainstPartnership: true,
          countedAgainstCulturalQuota: false,
          registeredAt: new Date(),
          piiPseudonymisedAt: null,
        } as unknown as typeof eventRegistrations.$inferInsert);
      });
    });

    afterAll(async () => {
      await tenantA.cleanup();
      await tenantB.cleanup();
    });

    it('actor in tenant A cannot archive tenant B event (RLS hides → event_not_found) + Tenant B event_registrations unchanged', async () => {
      // Tenant-A actor calls runArchiveEvent against TENANT B's eventId.
      // RLS scopes the events.findById query to tenantA's GUC, so the
      // row is invisible — use-case returns event_not_found BEFORE any
      // mutation reaches the registrations UPDATE path.
      const result = await runArchiveEvent(tenantA.ctx.slug, {
        eventId: tenantBEventId as never,
        actorUserId: asUserId(userA),
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('event_not_found');
      }

      // (1) Verify Tenant B's event row was NOT touched (archived_at still null).
      const tenantBEventRow = await runInTenant(tenantB.ctx, async (tx) =>
        tx
          .select({ archivedAt: events.archivedAt })
          .from(events)
          .where(eq(events.eventId, tenantBEventId))
          .limit(1),
      );
      expect(tenantBEventRow[0]?.archivedAt ?? null).toBeNull();

      // (2) R6 ARCH-R6-01 — verify Tenant B's event_registrations row
      // ALSO still has counted_against_partnership = true. If RLS were
      // ever broken to allow cross-tenant UPDATE on events but not
      // event_registrations, the SELECT in (1) would still catch the
      // archive — but this second assertion catches the inverse case
      // (RLS broken on event_registrations only).
      const tenantBRegRow = await runInTenant(tenantB.ctx, async (tx) =>
        tx
          .select({
            countedAgainstPartnership: eventRegistrations.countedAgainstPartnership,
          })
          .from(eventRegistrations)
          .where(eq(eventRegistrations.registrationId, tenantBRegistrationId))
          .limit(1),
      );
      expect(tenantBRegRow[0]?.countedAgainstPartnership).toBe(true);
    });
  });
});

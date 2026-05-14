/**
 * T087 — F6 toggle-event-category integration test (live Neon Singapore).
 *
 * Verifies the admin-toggle path (FR-019) end-to-end:
 *   1. Toggle ON (false → true) re-evaluates all matched paid
 *      registrations and decrements quota for members with room.
 *   2. Toggle OFF (true → false) credit-backs every counted row,
 *      emitting `quota_credit_back_archive` (scope discriminator) per
 *      flipped row.
 *   3. No-op short-circuit: toggling to the same value yields
 *      `registrationsReevaluated: 0` and emits NO audit row.
 *   4. Macro audit (`event_partner_benefit_toggled` /
 *      `event_cultural_event_toggled`) carries the correct
 *      `registrationsReevaluated` count.
 *
 * Spec authority:
 *   - FR-019 admin re-flag with one-tx re-evaluation
 *   - research.md R5 advisory lock + computed-on-read
 *
 * Uses the production `runToggleEventCategory` composition root so the
 * test exercises the exact path the admin route handler walks.
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
import { runToggleEventCategory } from '@/lib/events-admin-deps';
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

describe('T087 — F6 toggleEventCategory (admin FR-019 re-evaluation)', () => {
  describe('Toggle ON: flag is_partner_benefit false → true → decrements 3 matched rows', () => {
    let tenant: TestTenant;
    const corporatePlanId = `test-plan-corp-${randomUUID()}`;
    const partnershipPlanId = `test-plan-partner-${randomUUID()}`;
    const memberId = randomUUID();
    let userId: string;
    let eventInternalId: string;
    const eventExternalId = `event_toggle_on_${Date.now()}`;

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      const user = await createActiveTestUser('admin');
      userId = user.userId;
      await runInTenant(tenant.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: corporatePlanId,
          planName: { en: 'Corp Bundle (toggle ON)' },
          benefitMatrix: premiumMatrix,
          planCategory: 'corporate',
          createdBy: user.userId,
        });
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: partnershipPlanId,
          planName: { en: 'Diamond Partnership (toggle ON)' },
          benefitMatrix: diamondMatrix,
          planCategory: 'partnership',
          includesCorporatePlanId: corporatePlanId,
          createdBy: user.userId,
        });
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          companyName: 'Toggle On Co',
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
          lastName: 'On',
          email: 'jane@toggle-on.example',
          isPrimary: true,
        } as unknown as typeof contacts.$inferInsert);
        await tx.insert(tenantWebhookConfigs).values({
          tenantId: tenant.ctx.slug,
          source: 'eventcreate',
          webhookSecretActive: 'test-secret-' + 'a'.repeat(43),
          enabled: true,
        });
      });
      // Pre-seed event WITHOUT partner-benefit flag
      eventInternalId = randomUUID();
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(events).values({
          tenantId: tenant.ctx.slug,
          eventId: eventInternalId,
          source: 'eventcreate',
          externalId: eventExternalId,
          name: 'Toggle ON Test Event',
          startDate: new Date('2026-09-01T18:00:00+07:00'),
          isPartnerBenefit: false,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
      });
      // Ingest 3 attendees while event is NOT partner-benefit → all rows
      // land with counted_against_partnership=false (event flag is off).
      const deps = makeIngestWebhookAttendeeDeps();
      for (let i = 0; i < 3; i++) {
        const result = await ingestWebhookAttendee(
          {
            tenantId: tenant.ctx.slug,
            requestId: `req-toggle-on-${Date.now()}-${i}`,
            source: 'eventcreate_webhook',
            rawPayload: makeWebhookPayload({
              event: {
                externalId: eventExternalId,
                name: 'Toggle ON Test Event',
                startDate: '2026-09-01T18:00:00+07:00',
              },
              attendee: {
                externalId: `att_toggle_on_${i}`,
                email: i === 0 ? 'jane@toggle-on.example' : `worker${i}@toggle-on.example`,
                companyName: 'Toggle On Co',
                fullName: `Worker On ${i}`,
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

    it('toggling is_partner_benefit ON → 3 rows flip to counted=true + 3 decremented audits + 1 macro toggle audit', async () => {
      const result = await runToggleEventCategory(tenant.ctx.slug, {
        eventId: eventInternalId as never,
        flag: 'is_partner_benefit',
        newValue: true,
        actorUserId: asUserId(userId),
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.previousValue).toBe(false);
        expect(result.value.nextValue).toBe(true);
        expect(result.value.registrationsReevaluated).toBe(3);
        expect(result.value.event.isPartnerBenefit).toBe(true);
      }

      // Verify all 3 rows now counted_against_partnership=true
      const countedRows = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(eq(eventRegistrations.matchedMemberId, memberId)),
      );
      expect(countedRows.length).toBe(3);
      expect(countedRows.every((r) => r.countedAgainstPartnership)).toBe(true);

      // Verify audit trail: 3 quota_partnership_decremented + 1 event_partner_benefit_toggled
      const allAudits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug));
      const decremented = allAudits.filter(
        (r) => String(r.eventType) === 'quota_partnership_decremented',
      );
      const toggled = allAudits.filter(
        (r) => String(r.eventType) === 'event_partner_benefit_toggled',
      );
      expect(decremented.length).toBe(3);
      expect(toggled.length).toBe(1);
      const togglePayload = toggled[0]!.payload as Record<string, unknown>;
      expect(togglePayload.flagBefore).toBe(false);
      expect(togglePayload.flagAfter).toBe(true);
      expect(togglePayload.registrationsReevaluated).toBe(3);
    });
  });

  describe('Toggle OFF: flag is_partner_benefit true → false → 3 credit-back audits', () => {
    let tenant: TestTenant;
    const corporatePlanId = `test-plan-corp-${randomUUID()}`;
    const partnershipPlanId = `test-plan-partner-${randomUUID()}`;
    const memberId = randomUUID();
    let userId: string;
    let eventInternalId: string;
    const eventExternalId = `event_toggle_off_${Date.now()}`;

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      const user = await createActiveTestUser('admin');
      userId = user.userId;
      await runInTenant(tenant.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: corporatePlanId,
          planName: { en: 'Corp Bundle (toggle OFF)' },
          benefitMatrix: premiumMatrix,
          planCategory: 'corporate',
          createdBy: user.userId,
        });
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: partnershipPlanId,
          planName: { en: 'Diamond Partnership (toggle OFF)' },
          benefitMatrix: diamondMatrix,
          planCategory: 'partnership',
          includesCorporatePlanId: corporatePlanId,
          createdBy: user.userId,
        });
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          companyName: 'Toggle Off Co',
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
          lastName: 'Off',
          email: 'jane@toggle-off.example',
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
          name: 'Toggle OFF Test Event',
          startDate: new Date('2026-10-01T18:00:00+07:00'),
          isPartnerBenefit: true,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
      });
      // Ingest 3 attendees while event IS partner-benefit → all rows
      // counted_against_partnership=true.
      const deps = makeIngestWebhookAttendeeDeps();
      for (let i = 0; i < 3; i++) {
        const result = await ingestWebhookAttendee(
          {
            tenantId: tenant.ctx.slug,
            requestId: `req-toggle-off-${Date.now()}-${i}`,
            source: 'eventcreate_webhook',
            rawPayload: makeWebhookPayload({
              event: {
                externalId: eventExternalId,
                name: 'Toggle OFF Test Event',
                startDate: '2026-10-01T18:00:00+07:00',
              },
              attendee: {
                externalId: `att_toggle_off_${i}`,
                email: i === 0 ? 'jane@toggle-off.example' : `worker${i}@toggle-off.example`,
                companyName: 'Toggle Off Co',
                fullName: `Worker Off ${i}`,
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

    it('toggling is_partner_benefit OFF → 3 rows flip to counted=false + 3 credit-back audits + macro toggle audit', async () => {
      const result = await runToggleEventCategory(tenant.ctx.slug, {
        eventId: eventInternalId as never,
        flag: 'is_partner_benefit',
        newValue: false,
        actorUserId: asUserId(userId),
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.previousValue).toBe(true);
        expect(result.value.nextValue).toBe(false);
        expect(result.value.registrationsReevaluated).toBe(3);
        expect(result.value.event.isPartnerBenefit).toBe(false);
      }

      // All 3 rows should now counted_against_partnership=false
      const rows = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(eq(eventRegistrations.matchedMemberId, memberId)),
      );
      expect(rows.length).toBe(3);
      expect(rows.every((r) => r.countedAgainstPartnership === false)).toBe(true);

      // Verify 3 quota_credit_back_archive audits with scope=partnership
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
          (r) =>
            (r.payload as Record<string, unknown>).scope === 'partnership',
        ),
      ).toBe(true);
      const toggled = allAudits.filter(
        (r) => String(r.eventType) === 'event_partner_benefit_toggled',
      );
      expect(toggled.length).toBe(1);
      const togglePayload = toggled[0]!.payload as Record<string, unknown>;
      expect(togglePayload.flagBefore).toBe(true);
      expect(togglePayload.flagAfter).toBe(false);
      expect(togglePayload.registrationsReevaluated).toBe(3);
    });
  });

  describe('No-op short-circuit', () => {
    let tenant: TestTenant;
    let userId: string;
    let eventInternalId: string;

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      const user = await createActiveTestUser('admin');
      userId = user.userId;
      await runInTenant(tenant.ctx, async (tx) => {
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
          externalId: `event_noop_${Date.now()}`,
          name: 'No-op Toggle Event',
          startDate: new Date('2026-11-01T18:00:00+07:00'),
          isPartnerBenefit: false, // already FALSE
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
      });
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('toggling is_partner_benefit to its current value → 0 reevaluated + NO macro audit', async () => {
      const result = await runToggleEventCategory(tenant.ctx.slug, {
        eventId: eventInternalId as never,
        flag: 'is_partner_benefit',
        newValue: false, // same as current
        actorUserId: asUserId(userId),
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.registrationsReevaluated).toBe(0);
        expect(result.value.previousValue).toBe(false);
        expect(result.value.nextValue).toBe(false);
      }

      // No macro audit row should be created — the toggle was a true no-op
      const allAudits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug));
      const toggled = allAudits.filter(
        (r) => String(r.eventType) === 'event_partner_benefit_toggled',
      );
      expect(toggled.length).toBe(0);
    });
  });

  describe('event_not_found / event_archived guards', () => {
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
      const result = await runToggleEventCategory(tenant.ctx.slug, {
        eventId: randomUUID() as never,
        flag: 'is_partner_benefit',
        newValue: true,
        actorUserId: asUserId(userId),
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('event_not_found');
      }
    });

    it('event_archived when archivedAt is non-null', async () => {
      const archivedEventId = randomUUID();
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(events).values({
          tenantId: tenant.ctx.slug,
          eventId: archivedEventId,
          source: 'eventcreate',
          externalId: `event_archived_${Date.now()}`,
          name: 'Archived Event',
          startDate: new Date('2026-12-01T18:00:00+07:00'),
          archivedAt: new Date(),
          isPartnerBenefit: false,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
      });

      const result = await runToggleEventCategory(tenant.ctx.slug, {
        eventId: archivedEventId as never,
        flag: 'is_partner_benefit',
        newValue: true,
        actorUserId: asUserId(userId),
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('event_archived');
      }
    });
  });

  /**
   * Phase 6 staff-review-4 WARN-3 — cross-tenant UPDATE probe.
   * Constitution v1.4.0 Principle I (NON-NEG) Review-Gate blocker.
   * Toggle is an UPDATE surface (events.is_partner_benefit/
   * is_cultural_event + event_registrations.counted_against_*) — RLS
   * must hide Tenant B's event row from a Tenant A actor so the
   * use-case short-circuits with event_not_found and Tenant B's flags
   * remain unchanged.
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

      // Seed Tenant B's event row + a registration with counted=false.
      // R6 ARCH-R6-01 strengthening: if RLS is broken on
      // event_registrations only, the toggle ON path would set
      // counted=true. The second assertion below catches that.
      const tenantBPlanId = `tenantB-plan-${randomUUID().slice(0, 8)}`;
      await runInTenant(tenantB.ctx, async (tx) => {
        // planCategory='corporate' sidesteps the partnership_bundles_
        // corporate CHECK constraint; this probe only needs a valid
        // plan/member row to drive the RLS test.
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
          name: 'Tenant-B Event (flag must stay false)',
          startDate: new Date('2026-10-15T18:00:00+07:00'),
          archivedAt: null,
          isPartnerBenefit: false,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
        await tx.insert(eventRegistrations).values({
          tenantId: tenantB.ctx.slug,
          registrationId: tenantBRegistrationId,
          eventId: tenantBEventId,
          externalId: `att_tenantB_${Date.now()}`,
          attendeeEmail: 'tenantB-toggle-attendee@example.com',
          attendeeName: 'TenantB Toggle Attendee',
          attendeeCompany: 'TenantB Co',
          matchType: 'member_contact',
          matchedMemberId: tenantBMemberId,
          matchedContactId: null,
          ticketType: null,
          ticketPriceThb: null,
          paymentStatus: 'paid',
          countedAgainstPartnership: false,
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

    it('actor in tenant A cannot toggle tenant B event (RLS hides → event_not_found) + Tenant B event_registrations counted=false', async () => {
      const result = await runToggleEventCategory(tenantA.ctx.slug, {
        eventId: tenantBEventId as never,
        flag: 'is_partner_benefit',
        newValue: true,
        actorUserId: asUserId(userA),
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('event_not_found');
      }

      // (1) Verify Tenant B's event flag NOT toggled (still false).
      const tenantBEventRow = await runInTenant(tenantB.ctx, async (tx) =>
        tx
          .select({ isPartnerBenefit: events.isPartnerBenefit })
          .from(events)
          .where(eq(events.eventId, tenantBEventId))
          .limit(1),
      );
      expect(tenantBEventRow[0]?.isPartnerBenefit).toBe(false);

      // (2) R6 ARCH-R6-01 — verify Tenant B's event_registrations row
      // still has countedAgainstPartnership = false. If RLS on
      // event_registrations were broken, the toggle ON path would
      // have set this to true via setQuotaEffect.
      const tenantBRegRow = await runInTenant(tenantB.ctx, async (tx) =>
        tx
          .select({
            countedAgainstPartnership: eventRegistrations.countedAgainstPartnership,
          })
          .from(eventRegistrations)
          .where(eq(eventRegistrations.registrationId, tenantBRegistrationId))
          .limit(1),
      );
      expect(tenantBRegRow[0]?.countedAgainstPartnership).toBe(false);
    });
  });
});

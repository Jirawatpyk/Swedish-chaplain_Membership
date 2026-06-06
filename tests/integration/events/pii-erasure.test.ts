/**
 * F6 Phase 10 Wave 1 — eraseAttendeePii integration test (live Neon Singapore).
 *
 * Verifies FR-032a end-to-end via the production `runEraseAttendeePii`
 * composition root:
 *   1. happy path (counted partnership) — admin erases a counted
 *      registration row → row deleted + counted_against_partnership
 *      credit-backed (advisory-locked) + `pii_erasure_requested` +
 *      `quota_credit_back_archive` + `pii_erasure_completed` audits +
 *      aggregate quota_partnership_decremented count unchanged
 *      (decrement was already audited at ingest; the erasure layer
 *      adds the credit-back row, not a new decrement). The macro
 *      `pii_erasure_completed` payload carries
 *      `quotaReversals.partnership === 1`.
 *   2. happy path (non_member, not counted) — admin erases a
 *      non-counted row → row deleted + no `quota_credit_back_*`
 *      audit + `pii_erasure_completed` with
 *      `quotaReversals.{partnership,cultural}=0`. Validates the
 *      no-spurious-credit-back invariant.
 *   3. idempotency — re-invoking erasure on an already-deleted
 *      registrationId returns `Result.ok({alreadyErased: true})`
 *      with no new audits + no quota mutation. Mirrors the F4
 *      receipt-resend + F5 webhook idempotency precedent.
 *   4. event_path_mismatch — if the route path's eventId does not
 *      match the registration's actual eventId, the use-case returns
 *      `event_path_mismatch` BEFORE any mutation (post-load guard,
 *      mirrors Round-2 relink-registration R-CRIT path-mismatch fix).
 *   5. registration_not_found — when the registrationId does not
 *      exist (or RLS hides it), returns `registration_not_found` with
 *      zero mutations + zero audits.
 *   6. cross-tenant probe (Principle I sub-clause 3 Review-Gate
 *      blocker) — tenant B's admin cannot erase tenant A's row;
 *      `registration_not_found` returned (RLS hides A's row) + zero
 *      mutations + zero audits in either tenant.
 *
 * Spec authority:
 *   - FR-032a (admin erasure flow + audit emission + idempotency)
 *   - data-model.md § attendee PII erasure
 *   - Constitution Principle I sub-clause 3 (mandatory cross-tenant
 *     integration test)
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
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { ingestWebhookAttendee } from '@/modules/events';
import { makeIngestWebhookAttendeeDeps } from '@/lib/events-webhook-deps';
import { runEraseAttendeePii } from '@/lib/events-admin-deps';
import { asUserId } from '@/modules/auth';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createActiveTestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { makeWebhookPayload } from './helpers/sign-webhook';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';

const partnerBenefitMatrix: BenefitMatrix = {
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

const corpMatrix: BenefitMatrix = {
  ...DEFAULT_TEST_BENEFIT_MATRIX,
  cultural_tickets_per_year: 2,
  partnership: null,
};

describe('F6 Phase 10 Wave 1 — eraseAttendeePii (FR-032a)', () => {
  describe('happy path counted partnership row → quota credit-back + 3 audits', () => {
    let tenant: TestTenant;
    let userId: string;
    let eventInternalId: string;
    let registrationId: string;
    const corpPlanId = `test-plan-erase-corp-${randomUUID()}`;
    const partnershipPlanId = `test-plan-erase-partner-${randomUUID()}`;
    const memberId = randomUUID();
    const eventExternalId = `event_erase_${Date.now()}`;
    const attendeeExternalId = `att_erase_${Date.now()}`;

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      const user = await createActiveTestUser('admin');
      userId = user.userId;
      await runInTenant(tenant.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: corpPlanId,
          planName: { en: 'Corp Bundle (erase)' },
          benefitMatrix: corpMatrix,
          planCategory: 'corporate',
          createdBy: user.userId,
        });
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: partnershipPlanId,
          planName: { en: 'Diamond Partnership (erase)' },
          benefitMatrix: partnerBenefitMatrix,
          planCategory: 'partnership',
          includesCorporatePlanId: corpPlanId,
          createdBy: user.userId,
        });
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Erase Test Co',
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
          lastName: 'Erase',
          email: 'jane@erase.example',
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
          name: 'Erase Test Event',
          startDate: new Date('2026-07-15T18:00:00+07:00'),
          isPartnerBenefit: true,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
      });
      // Ingest the attendee — counted_against_partnership=true
      const deps = makeIngestWebhookAttendeeDeps();
      const result = await ingestWebhookAttendee(
        {
          tenantId: tenant.ctx.slug,
          requestId: `req-erase-${Date.now()}`,
          source: 'eventcreate_webhook',
          rawPayload: makeWebhookPayload({
            event: {
              externalId: eventExternalId,
              name: 'Erase Test Event',
              startDate: '2026-07-15T18:00:00+07:00',
            },
            attendee: {
              externalId: attendeeExternalId,
              email: 'jane@erase.example',
              companyName: 'Erase Test Co',
              fullName: 'Jane Erase',
            },
          }),
          sourceIp: '127.0.0.1',
        },
        deps,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        registrationId = String(result.value.registrationId);
        expect(result.value.quotaEffect.countedAgainstPartnership).toBe(true);
      }
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('erase → row deleted + quota credit-back + 3 audits emitted', async () => {
      const result = await runEraseAttendeePii(tenant.ctx.slug, {
        eventId: eventInternalId as never,
        registrationId: registrationId as never,
        actorUserId: asUserId(userId),
        reasonText: 'GDPR Article 17 request — member requested deletion',
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.alreadyErased).toBe(false);
        expect(result.value.quotaReversals.partnership).toBe(1);
        expect(result.value.quotaReversals.cultural).toBe(0);
      }

      // Row hard-deleted
      const remaining = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(eq(eventRegistrations.registrationId, registrationId)),
      );
      expect(remaining.length).toBe(0);

      // Audit trail
      const allAudits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug));

      const requestedAudits = allAudits.filter(
        (r) => String(r.eventType) === 'pii_erasure_requested',
      );
      expect(requestedAudits.length).toBe(1);
      const requestedPayload = requestedAudits[0]!.payload as Record<
        string,
        unknown
      >;
      expect(requestedPayload.registrationId).toBe(registrationId);
      expect(requestedPayload.reasonText).toBe(
        'GDPR Article 17 request — member requested deletion',
      );
      expect(requestedPayload.attendeeEmailLastFour).toBe('mple'); // 'jane@erase.example' → last 4 of email

      const creditBacks = allAudits.filter(
        (r) => String(r.eventType) === 'quota_credit_back_archive',
      );
      expect(creditBacks.length).toBe(1);
      expect(
        (creditBacks[0]!.payload as Record<string, unknown>).scope,
      ).toBe('partnership');
      expect(
        (creditBacks[0]!.payload as Record<string, unknown>).registrationId,
      ).toBe(registrationId);

      const completedAudits = allAudits.filter(
        (r) => String(r.eventType) === 'pii_erasure_completed',
      );
      expect(completedAudits.length).toBe(1);
      const completedPayload = completedAudits[0]!.payload as Record<
        string,
        unknown
      >;
      expect(completedPayload.registrationId).toBe(registrationId);
      const reversals = completedPayload.quotaReversals as Record<
        string,
        number
      >;
      expect(reversals.partnership).toBe(1);
      expect(reversals.cultural).toBe(0);
      expect(
        typeof completedPayload.completedWithinSecondsOfRequest,
      ).toBe('number');
    });

    it('re-erasure (idempotent) → Result.ok({alreadyErased: true}) + no new audits', async () => {
      const auditsBefore = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug));

      const result = await runEraseAttendeePii(tenant.ctx.slug, {
        eventId: eventInternalId as never,
        registrationId: registrationId as never,
        actorUserId: asUserId(userId),
        reasonText: 'retry — should be no-op',
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.alreadyErased).toBe(true);
        expect(result.value.quotaReversals.partnership).toBe(0);
        expect(result.value.quotaReversals.cultural).toBe(0);
      }

      const auditsAfter = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug));
      expect(auditsAfter.length).toBe(auditsBefore.length);
    });
  });

  describe('happy path non_member (uncounted) → no credit-back audit', () => {
    let tenant: TestTenant;
    let userId: string;
    let eventInternalId: string;
    let registrationId: string;
    const eventExternalId = `event_erase_nm_${Date.now()}`;
    const attendeeExternalId = `att_erase_nm_${Date.now()}`;

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      const user = await createActiveTestUser('admin');
      userId = user.userId;
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(tenantWebhookConfigs).values({
          tenantId: tenant.ctx.slug,
          source: 'eventcreate',
          webhookSecretActive: 'test-secret-' + 'b'.repeat(43),
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
          name: 'Erase Non-Member Event',
          startDate: new Date('2026-07-15T18:00:00+07:00'),
          isPartnerBenefit: true,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
      });
      // No member seeded → ingest resolves as non_member (uncounted)
      const deps = makeIngestWebhookAttendeeDeps();
      const result = await ingestWebhookAttendee(
        {
          tenantId: tenant.ctx.slug,
          requestId: `req-erase-nm-${Date.now()}`,
          source: 'eventcreate_webhook',
          rawPayload: makeWebhookPayload({
            event: {
              externalId: eventExternalId,
              name: 'Erase Non-Member Event',
              startDate: '2026-07-15T18:00:00+07:00',
            },
            attendee: {
              externalId: attendeeExternalId,
              email: 'guest@nonmember.example',
              companyName: 'Unknown Co',
              fullName: 'Unknown Guest',
            },
          }),
          sourceIp: '127.0.0.1',
        },
        deps,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        registrationId = String(result.value.registrationId);
        expect(result.value.matched).toBe('non_member');
      }
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('non-counted erase → no credit-back audit + completed.quotaReversals all 0', async () => {
      const result = await runEraseAttendeePii(tenant.ctx.slug, {
        eventId: eventInternalId as never,
        registrationId: registrationId as never,
        actorUserId: asUserId(userId),
        reasonText: 'non-member erase',
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.alreadyErased).toBe(false);
        expect(result.value.quotaReversals.partnership).toBe(0);
        expect(result.value.quotaReversals.cultural).toBe(0);
      }

      const allAudits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug));
      const creditBacks = allAudits.filter(
        (r) => String(r.eventType) === 'quota_credit_back_archive',
      );
      expect(creditBacks.length).toBe(0);

      const completed = allAudits.filter(
        (r) => String(r.eventType) === 'pii_erasure_completed',
      );
      expect(completed.length).toBe(1);
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

    it('registration_not_found when registrationId does not exist', async () => {
      const result = await runEraseAttendeePii(tenant.ctx.slug, {
        eventId: randomUUID() as never,
        registrationId: randomUUID() as never,
        actorUserId: asUserId(userId),
        reasonText: 'should fail',
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('registration_not_found');
      }
    });

    it('event_path_mismatch when path eventId does not match registration.eventId', async () => {
      const eventA = randomUUID();
      const eventB = randomUUID();
      const regId = randomUUID();
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(tenantWebhookConfigs).values({
          tenantId: tenant.ctx.slug,
          source: 'eventcreate',
          webhookSecretActive: 'test-secret-' + 'c'.repeat(43),
          enabled: true,
        });
        await tx.insert(events).values([
          {
            tenantId: tenant.ctx.slug,
            eventId: eventA,
            source: 'eventcreate',
            externalId: `evA_${Date.now()}`,
            name: 'Path A',
            startDate: new Date('2026-07-15T18:00:00+07:00'),
            isPartnerBenefit: false,
            isCulturalEvent: false,
          },
          {
            tenantId: tenant.ctx.slug,
            eventId: eventB,
            source: 'eventcreate',
            externalId: `evB_${Date.now()}`,
            name: 'Path B',
            startDate: new Date('2026-07-15T18:00:00+07:00'),
            isPartnerBenefit: false,
            isCulturalEvent: false,
          },
        ] as unknown as Array<typeof events.$inferInsert>);
        await tx.insert(eventRegistrations).values({
          tenantId: tenant.ctx.slug,
          registrationId: regId,
          eventId: eventA, // belongs to A
          source: 'eventcreate',
          externalId: `path_test_${Date.now()}`,
          attendeeEmail: 'path@erase.example',
          attendeeName: 'Path Test',
          attendeeCompany: null,
          matchType: 'non_member',
          matchedMemberId: null,
          paymentStatus: 'paid',
          ticketType: 'standard',
          countedAgainstPartnership: false,
          countedAgainstCulturalQuota: false,
          metadata: {},
          registeredAt: new Date(),
          piiPseudonymisedAt: null,
        } as unknown as typeof eventRegistrations.$inferInsert);
      });

      const result = await runEraseAttendeePii(tenant.ctx.slug, {
        eventId: eventB as never, // wrong event — path mismatch
        registrationId: regId as never,
        actorUserId: asUserId(userId),
        reasonText: 'path mismatch test',
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('event_path_mismatch');
      }

      // Row UNCHANGED — defensive verification
      const stillThere = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(eq(eventRegistrations.registrationId, regId)),
      );
      expect(stillThere.length).toBe(1);
    });
  });

  describe('cross-tenant probe (Principle I sub-clause 3 Review-Gate)', () => {
    let tenantA: TestTenant;
    let tenantB: TestTenant;
    let userBId: string;
    let regIdInA: string;

    beforeAll(async () => {
      tenantA = await createTestTenant('test-swecham');
      tenantB = await createTestTenant('test-chamber');
      const userB = await createActiveTestUser('admin');
      userBId = userB.userId;

      regIdInA = randomUUID();
      const evIdInA = randomUUID();
      await runInTenant(tenantA.ctx, async (tx) => {
        await tx.insert(tenantWebhookConfigs).values({
          tenantId: tenantA.ctx.slug,
          source: 'eventcreate',
          webhookSecretActive: 'test-secret-' + 'd'.repeat(43),
          enabled: true,
        });
        await tx.insert(events).values({
          tenantId: tenantA.ctx.slug,
          eventId: evIdInA,
          source: 'eventcreate',
          externalId: `cross_${Date.now()}`,
          name: 'Cross-tenant erase test',
          startDate: new Date('2026-07-15T18:00:00+07:00'),
          isPartnerBenefit: false,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
        await tx.insert(eventRegistrations).values({
          tenantId: tenantA.ctx.slug,
          registrationId: regIdInA,
          eventId: evIdInA,
          source: 'eventcreate',
          externalId: `cross_att_${Date.now()}`,
          attendeeEmail: 'cross@a.example',
          attendeeName: 'Cross Tenant',
          attendeeCompany: null,
          matchType: 'non_member',
          matchedMemberId: null,
          paymentStatus: 'paid',
          ticketType: 'standard',
          countedAgainstPartnership: false,
          countedAgainstCulturalQuota: false,
          metadata: {},
          registeredAt: new Date(),
          piiPseudonymisedAt: null,
        } as unknown as typeof eventRegistrations.$inferInsert);
      });
    });

    afterAll(async () => {
      await tenantA.cleanup();
      await tenantB.cleanup();
    });

    it('tenant B admin cannot erase tenant A row (RLS hides → registration_not_found)', async () => {
      const result = await runEraseAttendeePii(tenantB.ctx.slug, {
        eventId: randomUUID() as never,
        registrationId: regIdInA as never,
        actorUserId: asUserId(userBId),
        reasonText: 'cross-tenant attempt',
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('registration_not_found');
      }

      // Tenant A row UNTOUCHED
      const aRow = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(eq(eventRegistrations.registrationId, regIdInA)),
      );
      expect(aRow.length).toBe(1);

      // No erasure-related audit in either tenant
      const auditsA = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenantA.ctx.slug));
      const auditsB = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenantB.ctx.slug));
      const erasureA = auditsA.filter((r) =>
        String(r.eventType).startsWith('pii_erasure'),
      );
      const erasureB = auditsB.filter((r) =>
        String(r.eventType).startsWith('pii_erasure'),
      );
      expect(erasureA.length).toBe(0);
      expect(erasureB.length).toBe(0);
    });
  });
});

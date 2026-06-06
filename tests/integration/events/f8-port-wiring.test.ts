/**
 * F6 Phase 10 T123 — F8 EventAttendees port-wiring integration test
 * (live Neon Singapore).
 *
 * Verifies the F6 → F8 bridge per research.md R11 + quickstart.md § 2.2:
 *   1. drizzleEventAttendeesAdapter.isAvailable() === true (F6 ready)
 *   2. listAttendances returns the member's past event registrations
 *      with correct shape (memberId + attendedAt + eventId + eventType)
 *   3. Pseudonymised rows EXCLUDED (retention-purged per FR-032)
 *   4. Archived events EXCLUDED (FR-019a quota-neutral state)
 *   5. Date-window honored: sinceIso clips older events
 *   6. Limit honored
 *   7. **Cross-tenant probe** (Principle I sub-clause 3 Review-Gate
 *      blocker) — calling adapter with tenant B's slug + tenant A's
 *      memberId returns [] (RLS hides A's rows from B's tenant
 *      context).
 *
 * The flag-off path (stub returns []) is covered by F8's existing
 * `at-risk-f6-fallback.test.ts` referenced in quickstart.md § 2.2 —
 * no duplication here.
 *
 * Spec authority:
 *   - research.md R11 E1 (Application-layer wrapper rationale)
 *   - quickstart.md § 2.2 (composition root swap pattern)
 *   - Constitution Principle I sub-clause 3 (mandatory cross-tenant
 *     integration test as Review-Gate blocker)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import {
  events,
  eventRegistrations,
  tenantWebhookConfigs,
} from '@/modules/events/infrastructure/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { drizzleEventAttendeesAdapter } from '@/modules/events';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createActiveTestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

describe('F6 Phase 10 T123 — drizzleEventAttendeesAdapter (F8 port wiring)', () => {
  describe('happy path — list returns past attendances with derived eventType', () => {
    let tenant: TestTenant;
    let memberId: string;
    const partnerEventId = randomUUID();
    const culturalEventId = randomUUID();
    const generalEventId = randomUUID();
    const pseudoEventId = randomUUID();
    const archivedEventId = randomUUID();

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      const user = await createActiveTestUser('admin');
      const planId = `test-plan-f8-bridge-${randomUUID()}`;
      memberId = randomUUID();
      await runInTenant(tenant.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId,
          planName: { en: 'F8 Bridge Test Plan' },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          planCategory: 'corporate',
          createdBy: user.userId,
        });
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'F8 Bridge Test Co',
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active',
        } as unknown as typeof members.$inferInsert);
        await tx.insert(tenantWebhookConfigs).values({
          tenantId: tenant.ctx.slug,
          source: 'eventcreate',
          webhookSecretActive: 'test-secret-' + 'a'.repeat(43),
          enabled: true,
        });
        await tx.insert(events).values([
          {
            tenantId: tenant.ctx.slug,
            eventId: partnerEventId,
            source: 'eventcreate',
            externalId: `f8-partner-${Date.now()}`,
            name: 'Partner Networking',
            startDate: new Date('2026-04-15T18:00:00+07:00'),
            isPartnerBenefit: true,
            isCulturalEvent: false,
          },
          {
            tenantId: tenant.ctx.slug,
            eventId: culturalEventId,
            source: 'eventcreate',
            externalId: `f8-cultural-${Date.now()}`,
            name: 'Cultural Gala',
            startDate: new Date('2026-03-10T18:00:00+07:00'),
            isPartnerBenefit: false,
            isCulturalEvent: true,
          },
          {
            tenantId: tenant.ctx.slug,
            eventId: generalEventId,
            source: 'eventcreate',
            externalId: `f8-general-${Date.now()}`,
            name: 'General Mixer',
            startDate: new Date('2026-02-05T18:00:00+07:00'),
            isPartnerBenefit: false,
            isCulturalEvent: false,
          },
          {
            tenantId: tenant.ctx.slug,
            eventId: pseudoEventId,
            source: 'eventcreate',
            externalId: `f8-pseudo-${Date.now()}`,
            name: 'Old Event (registration pseudonymised)',
            startDate: new Date('2026-01-15T18:00:00+07:00'),
            isPartnerBenefit: false,
            isCulturalEvent: false,
          },
          {
            tenantId: tenant.ctx.slug,
            eventId: archivedEventId,
            source: 'eventcreate',
            externalId: `f8-archived-${Date.now()}`,
            name: 'Archived Event',
            startDate: new Date('2026-05-01T18:00:00+07:00'),
            archivedAt: new Date('2026-05-02T00:00:00Z'),
            isPartnerBenefit: false,
            isCulturalEvent: false,
          },
        ] as unknown as Array<typeof events.$inferInsert>);
        await tx.insert(eventRegistrations).values([
          {
            tenantId: tenant.ctx.slug,
            registrationId: randomUUID(),
            eventId: partnerEventId,
            source: 'eventcreate',
            externalId: `f8-reg-partner-${Date.now()}`,
            attendeeEmail: 'member@f8.example',
            attendeeName: 'F8 Member',
            matchType: 'member_contact',
            matchedMemberId: memberId,
            paymentStatus: 'paid',
            ticketType: 'standard',
            countedAgainstPartnership: true,
            countedAgainstCulturalQuota: false,
            metadata: {},
            registeredAt: new Date(),
            piiPseudonymisedAt: null,
          },
          {
            tenantId: tenant.ctx.slug,
            registrationId: randomUUID(),
            eventId: culturalEventId,
            source: 'eventcreate',
            externalId: `f8-reg-cultural-${Date.now()}`,
            attendeeEmail: 'member@f8.example',
            attendeeName: 'F8 Member',
            matchType: 'member_contact',
            matchedMemberId: memberId,
            paymentStatus: 'paid',
            ticketType: 'standard',
            countedAgainstPartnership: false,
            countedAgainstCulturalQuota: true,
            metadata: {},
            registeredAt: new Date(),
            piiPseudonymisedAt: null,
          },
          {
            tenantId: tenant.ctx.slug,
            registrationId: randomUUID(),
            eventId: generalEventId,
            source: 'eventcreate',
            externalId: `f8-reg-general-${Date.now()}`,
            attendeeEmail: 'member@f8.example',
            attendeeName: 'F8 Member',
            matchType: 'member_contact',
            matchedMemberId: memberId,
            paymentStatus: 'paid',
            ticketType: 'standard',
            countedAgainstPartnership: false,
            countedAgainstCulturalQuota: false,
            metadata: {},
            registeredAt: new Date(),
            piiPseudonymisedAt: null,
          },
          {
            // pseudonymised registration — must be EXCLUDED
            tenantId: tenant.ctx.slug,
            registrationId: randomUUID(),
            eventId: pseudoEventId,
            source: 'eventcreate',
            externalId: `f8-reg-pseudo-${Date.now()}`,
            attendeeEmail: 'sha256:abc123',
            attendeeName: 'sha256:abc123',
            matchType: 'member_contact',
            matchedMemberId: memberId,
            paymentStatus: 'paid',
            ticketType: 'standard',
            countedAgainstPartnership: false,
            countedAgainstCulturalQuota: false,
            metadata: {},
            registeredAt: new Date('2026-01-15T20:00:00+07:00'),
            piiPseudonymisedAt: new Date('2028-01-15T20:00:00Z'),
          },
          {
            // archived event — must be EXCLUDED via events.archived_at
            tenantId: tenant.ctx.slug,
            registrationId: randomUUID(),
            eventId: archivedEventId,
            source: 'eventcreate',
            externalId: `f8-reg-archived-${Date.now()}`,
            attendeeEmail: 'member@f8.example',
            attendeeName: 'F8 Member',
            matchType: 'member_contact',
            matchedMemberId: memberId,
            paymentStatus: 'paid',
            ticketType: 'standard',
            countedAgainstPartnership: false,
            countedAgainstCulturalQuota: false,
            metadata: {},
            registeredAt: new Date(),
            piiPseudonymisedAt: null,
          },
        ] as unknown as Array<typeof eventRegistrations.$inferInsert>);
      });
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('isAvailable() returns true (F6 ready)', () => {
      expect(drizzleEventAttendeesAdapter.isAvailable()).toBe(true);
    });

    it('listAttendances returns 3 active records (excludes pseudo + archived) with correct eventType derivation', async () => {
      const records = await drizzleEventAttendeesAdapter.listAttendances(
        tenant.ctx.slug,
        memberId,
      );
      expect(records.length).toBe(3);

      // Find each record by eventId (order not guaranteed beyond startDate DESC)
      const partner = records.find((r) => r.eventId === partnerEventId);
      const cultural = records.find((r) => r.eventId === culturalEventId);
      const general = records.find((r) => r.eventId === generalEventId);

      expect(partner).toBeDefined();
      expect(cultural).toBeDefined();
      expect(general).toBeDefined();

      expect(partner!.eventType).toBe('partnership');
      expect(cultural!.eventType).toBe('cultural');
      expect(general!.eventType).toBe('general');

      // attendedAt is ISO 8601 UTC
      expect(partner!.attendedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(partner!.memberId).toBe(memberId);
    });

    it('records ordered by attendedAt DESC (most recent first)', async () => {
      const records = await drizzleEventAttendeesAdapter.listAttendances(
        tenant.ctx.slug,
        memberId,
      );
      for (let i = 1; i < records.length; i++) {
        expect(
          new Date(records[i - 1]!.attendedAt).getTime(),
        ).toBeGreaterThanOrEqual(new Date(records[i]!.attendedAt).getTime());
      }
    });

    it('sinceIso clips older events from window', async () => {
      // Only events on/after 2026-04-01 → just the Partner event
      const records = await drizzleEventAttendeesAdapter.listAttendances(
        tenant.ctx.slug,
        memberId,
        { sinceIso: '2026-04-01T00:00:00Z' },
      );
      expect(records.length).toBe(1);
      expect(records[0]!.eventId).toBe(partnerEventId);
    });

    it('limit truncates record count', async () => {
      const records = await drizzleEventAttendeesAdapter.listAttendances(
        tenant.ctx.slug,
        memberId,
        { limit: 1 },
      );
      expect(records.length).toBe(1);
    });
  });

  describe('cross-tenant probe (Principle I sub-clause 3 Review-Gate blocker)', () => {
    let tenantA: TestTenant;
    let tenantB: TestTenant;
    let memberInA: string;

    beforeAll(async () => {
      tenantA = await createTestTenant('test-swecham');
      tenantB = await createTestTenant('test-chamber');
      const userA = await createActiveTestUser('admin');
      const planId = `test-plan-f8-cross-${randomUUID()}`;
      memberInA = randomUUID();
      const evIdInA = randomUUID();
      await runInTenant(tenantA.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenantA.ctx.slug,
          planId,
          planName: { en: 'F8 Cross Tenant Plan' },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          planCategory: 'corporate',
          createdBy: userA.userId,
        });
        await tx.insert(members).values({
          tenantId: tenantA.ctx.slug,
          memberId: memberInA,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'F8 Cross-Tenant Co',
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active',
        } as unknown as typeof members.$inferInsert);
        await tx.insert(tenantWebhookConfigs).values({
          tenantId: tenantA.ctx.slug,
          source: 'eventcreate',
          webhookSecretActive: 'test-secret-' + 'b'.repeat(43),
          enabled: true,
        });
        await tx.insert(events).values({
          tenantId: tenantA.ctx.slug,
          eventId: evIdInA,
          source: 'eventcreate',
          externalId: `cross-ev-${Date.now()}`,
          name: 'Tenant A Event',
          startDate: new Date('2026-04-01T18:00:00+07:00'),
          isPartnerBenefit: true,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
        await tx.insert(eventRegistrations).values({
          tenantId: tenantA.ctx.slug,
          registrationId: randomUUID(),
          eventId: evIdInA,
          source: 'eventcreate',
          externalId: `cross-reg-${Date.now()}`,
          attendeeEmail: 'cross@a.example',
          attendeeName: 'Cross Tenant',
          matchType: 'member_contact',
          matchedMemberId: memberInA,
          paymentStatus: 'paid',
          ticketType: 'standard',
          countedAgainstPartnership: true,
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

    it('tenant B context cannot read tenant A attendances (RLS-enforced)', async () => {
      const records = await drizzleEventAttendeesAdapter.listAttendances(
        tenantB.ctx.slug,
        memberInA,
      );
      expect(records.length).toBe(0);
    });

    it('tenant A context reads its own attendances correctly (control)', async () => {
      const records = await drizzleEventAttendeesAdapter.listAttendances(
        tenantA.ctx.slug,
        memberInA,
      );
      expect(records.length).toBe(1);
      expect(records[0]!.memberId).toBe(memberInA);
    });
  });
});

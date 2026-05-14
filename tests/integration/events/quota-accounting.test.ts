/**
 * T084 — F6 quota accounting integration test (live Neon Singapore).
 *
 * Wave-1 scope (this file): the new-registration quota path wired via
 * `ingestWebhookAttendee` → `applyQuotaEffect` → adapter. Asserts:
 *   - Partnership decrement on Diamond-6 + over-quota on 7th (US4 AS1+AS2)
 *   - Cultural decrement on Premium-2 (US4 AS3)
 *   - Cross-tenant probe: Tenant A's matched member CANNOT impact
 *     Tenant B's quota counts (Principle I Review-Gate blocker)
 *
 * Deferred to wave-2:
 *   - Refund credit-back path (US4 AS4) — requires `ingest-webhook-attendee.ts`
 *     ON-CONFLICT branch extension
 *   - Archive credit-back (FR-019a) — requires Phase 4 archive surface
 *     to invoke a credit-back use-case (T087's sibling concern)
 *
 * Spec authority:
 *   - FR-015 partnership-per-event decrement
 *   - FR-016 cultural-per-year decrement
 *   - FR-017 over-quota persisted with counted_against_*=false + warning
 *   - SC-004 zero-error promise (canonical correctness of decision)
 *   - research.md R5 advisory lock + computed-on-read
 *
 * Lives at the SAME tier as `tests/integration/events/match-attendee-to-member.test.ts`:
 * spawns isolated test tenants via `createTestTenant` + `seedF8MembershipPlan` +
 * direct member/contacts inserts; uses production `makeIngestWebhookAttendeeDeps()`
 * factory (the same composition root the route handler uses) so the
 * coverage is end-to-end through the F6 strict-tx ACID unit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
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
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createActiveTestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { makeWebhookPayload } from './helpers/sign-webhook';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';

// --- Plan fixtures: Diamond-6 partnership + Premium-2 corporate -------------

const diamondPartnershipMatrix: BenefitMatrix = {
  ...DEFAULT_TEST_BENEFIT_MATRIX,
  cultural_tickets_per_year: 0,
  partnership: {
    event_tickets_included: 6, // Diamond tier
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

const premiumCorporateMatrix: BenefitMatrix = {
  ...DEFAULT_TEST_BENEFIT_MATRIX,
  cultural_tickets_per_year: 2, // Premium tier
  partnership: null,
};

describe('T084 — F6 benefit quota accounting (new-registration paths)', () => {
  describe('US4 AS1+AS2 — partnership decrement + 7th over-quota (Diamond-6)', () => {
    let tenant: TestTenant;
    const corporatePlanId = `test-plan-corp-${randomUUID()}`;
    const planId = `test-plan-diamond-${randomUUID()}`;
    const memberId = randomUUID();
    const contactId = randomUUID();
    const ATTENDEE_EMAIL = 'jane@partnership.example';
    const COMPANY_NAME = 'Diamond Partnership Co';
    let eventExternalId: string;

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      const user = await createActiveTestUser('admin');
      // Partnership plans MUST bundle a corporate plan via
      // `includes_corporate_plan_id` (DB constraint
      // `membership_plans_partnership_bundles_corporate` per migration
      // 0006). Seed the corporate plan first, then the partnership plan
      // referencing it.
      await runInTenant(tenant.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: corporatePlanId,
          planName: { en: 'Bundled Corporate for Partnership' },
          benefitMatrix: premiumCorporateMatrix,
          planCategory: 'corporate',
          createdBy: user.userId,
        });
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId,
          planName: { en: 'Diamond Partnership Test' },
          benefitMatrix: diamondPartnershipMatrix,
          planCategory: 'partnership',
          includesCorporatePlanId: corporatePlanId,
          createdBy: user.userId,
        });
      });
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          companyName: COMPANY_NAME,
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active',
        } as unknown as typeof members.$inferInsert);
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId,
          memberId,
          firstName: 'Jane',
          lastName: 'Partnership',
          email: ATTENDEE_EMAIL,
          isPrimary: true,
        } as unknown as typeof contacts.$inferInsert);
        await tx.insert(tenantWebhookConfigs).values({
          tenantId: tenant.ctx.slug,
          source: 'eventcreate',
          webhookSecretActive: 'test-secret-' + 'a'.repeat(43),
          enabled: true,
        });
      });
      eventExternalId = `event_partnership_${Date.now()}`;
      // Seed a partner-benefit event row directly so the webhook upsert
      // updates it in place with is_partner_benefit=true already set
      // (webhook payload does not carry the chamber-side flag — the
      // event must be admin-flagged separately. For the test we
      // pre-seed via direct DB write to skip the toggle UI path until
      // wave-2 ships T087.)
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(events).values({
          tenantId: tenant.ctx.slug,
          eventId: randomUUID(),
          source: 'eventcreate',
          externalId: eventExternalId,
          name: 'Partnership Test Event',
          startDate: new Date('2026-06-21T18:00:00+07:00'),
          isPartnerBenefit: true,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
      });
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('6 webhook ingests → all 6 rows counted_against_partnership=true + 6 quota_partnership_decremented audits', async () => {
      const deps = makeIngestWebhookAttendeeDeps();
      // 6 distinct attendees from the same matched member
      for (let i = 0; i < 6; i++) {
        const result = await ingestWebhookAttendee(
          {
            tenantId: tenant.ctx.slug,
            requestId: `req-partnership-${Date.now()}-${i}`,
            source: 'eventcreate_webhook',
            rawPayload: makeWebhookPayload({
              event: {
                externalId: eventExternalId,
                name: 'Partnership Test Event',
                startDate: '2026-06-21T18:00:00+07:00',
              },
              attendee: {
                externalId: `att_partnership_${i}`,
                email: i === 0 ? ATTENDEE_EMAIL : `worker${i}@partnership.example`,
                companyName: COMPANY_NAME,
                fullName: `Worker ${i}`,
              },
            }),
            sourceIp: '127.0.0.1',
          },
          deps,
        );
        expect(result.ok, `ingest #${i} should succeed`).toBe(true);
      }

      // Verify 6 rows are counted_against_partnership=true
      const countedRows = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.matchedMemberId, memberId),
              eq(eventRegistrations.countedAgainstPartnership, true),
            ),
          ),
      );
      expect(countedRows.length).toBe(6);

      // Verify 6 quota_partnership_decremented audit rows exist.
      // We filter by tenantId then JS-side narrow by eventType; the
      // Drizzle pgEnum literal is closed at compile time but the
      // Postgres enum carries F6 values via migration 0132 (the JS
      // filter is the canonical query shape used by existing F6
      // integration tests).
      const allTenantAudits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug));
      const auditRows = allTenantAudits.filter(
        (r) => String(r.eventType) === 'quota_partnership_decremented',
      );
      expect(auditRows.length).toBe(6);
      // Allotment-before sequence should be 6, 5, 4, 3, 2, 1 (ordered
      // by occurredAt asc — though ingest is sequential so order
      // matches insertion order).
      const beforeValues = auditRows
        .map((r) => (r.payload as Record<string, unknown>).perEventAllotmentBefore as number)
        .sort((a, b) => b - a);
      expect(beforeValues).toEqual([6, 5, 4, 3, 2, 1]);
    });

    it('7th webhook ingest → counted_against_partnership=false + quota_over_quota_warning audit (AS2)', async () => {
      const deps = makeIngestWebhookAttendeeDeps();
      const result = await ingestWebhookAttendee(
        {
          tenantId: tenant.ctx.slug,
          requestId: `req-partnership-overquota-${Date.now()}`,
          source: 'eventcreate_webhook',
          rawPayload: makeWebhookPayload({
            event: {
              externalId: eventExternalId,
              name: 'Partnership Test Event',
              startDate: '2026-06-21T18:00:00+07:00',
            },
            attendee: {
              externalId: `att_partnership_overquota_${Date.now()}`,
              email: 'worker7@partnership.example',
              companyName: COMPANY_NAME,
              fullName: 'Worker 7 (over-quota)',
            },
          }),
          sourceIp: '127.0.0.1',
        },
        deps,
      );
      expect(result.ok).toBe(true);

      // Confirm the row exists but counted_against_partnership=false
      const rows = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.matchedMemberId, memberId),
              eq(eventRegistrations.countedAgainstPartnership, false),
            ),
          ),
      );
      // We seeded 6 counted=true + 1 over-quota=false. So COUNT(false) = 1.
      // (The 6 counted=true rows were tested above with countedAgainstPartnership=true filter.)
      expect(rows.length).toBe(1);

      // Verify the over_quota_warning audit was emitted with scope=partnership
      const allTenantAudits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug));
      const auditRows = allTenantAudits.filter(
        (r) => String(r.eventType) === 'quota_over_quota_warning',
      );
      expect(auditRows.length).toBeGreaterThanOrEqual(1);
      const payload = auditRows[0]!.payload as Record<string, unknown>;
      expect(payload.scope).toBe('partnership');
      expect(payload.allotmentAtIngest).toBe(0);
    });
  });

  describe('US4 AS3 — cultural decrement (Premium-2)', () => {
    let tenant: TestTenant;
    const planId = `test-plan-premium-${randomUUID()}`;
    const memberId = randomUUID();
    const contactId = randomUUID();
    const ATTENDEE_EMAIL = 'helen@premium.example';
    let eventExternalId: string;

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      const user = await createActiveTestUser('admin');
      await runInTenant(tenant.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId,
          planName: { en: 'Premium Corporate Test' },
          benefitMatrix: premiumCorporateMatrix,
          planCategory: 'corporate',
          createdBy: user.userId,
        });
      });
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          companyName: 'Premium Cultural Co',
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active',
        } as unknown as typeof members.$inferInsert);
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId,
          memberId,
          firstName: 'Helen',
          lastName: 'Premium',
          email: ATTENDEE_EMAIL,
          isPrimary: true,
        } as unknown as typeof contacts.$inferInsert);
        await tx.insert(tenantWebhookConfigs).values({
          tenantId: tenant.ctx.slug,
          source: 'eventcreate',
          webhookSecretActive: 'test-secret-' + 'a'.repeat(43),
          enabled: true,
        });
      });
      eventExternalId = `event_cultural_${Date.now()}`;
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(events).values({
          tenantId: tenant.ctx.slug,
          eventId: randomUUID(),
          source: 'eventcreate',
          externalId: eventExternalId,
          name: 'Cultural Test Event',
          startDate: new Date('2026-07-15T18:00:00+07:00'),
          isPartnerBenefit: false,
          isCulturalEvent: true,
        } as unknown as typeof events.$inferInsert);
      });
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('1 cultural ingest → counted_against_cultural_quota=true + quota_cultural_decremented audit with FY 2026', async () => {
      const deps = makeIngestWebhookAttendeeDeps();
      const result = await ingestWebhookAttendee(
        {
          tenantId: tenant.ctx.slug,
          requestId: `req-cultural-${Date.now()}`,
          source: 'eventcreate_webhook',
          rawPayload: makeWebhookPayload({
            event: {
              externalId: eventExternalId,
              name: 'Cultural Test Event',
              startDate: '2026-07-15T18:00:00+07:00',
            },
            attendee: {
              externalId: `att_cultural_${Date.now()}`,
              email: ATTENDEE_EMAIL,
              companyName: 'Premium Cultural Co',
              fullName: 'Helen Premium',
            },
          }),
          sourceIp: '127.0.0.1',
        },
        deps,
      );
      expect(result.ok).toBe(true);

      const rows = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.matchedMemberId, memberId),
              eq(eventRegistrations.countedAgainstCulturalQuota, true),
            ),
          ),
      );
      expect(rows.length).toBe(1);

      const allTenantAudits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug));
      const auditRows = allTenantAudits.filter(
        (r) => String(r.eventType) === 'quota_cultural_decremented',
      );
      expect(auditRows.length).toBe(1);
      const payload = auditRows[0]!.payload as Record<string, unknown>;
      expect(payload.fiscalYear).toBe(2026);
      expect(payload.annualAllotmentBefore).toBe(2);
      expect(payload.annualAllotmentAfter).toBe(1);
    });
  });

  describe('Principle I cross-tenant isolation (Review-Gate blocker)', () => {
    let tenantA: TestTenant;
    let tenantB: TestTenant;
    const corpPlanId = `test-plan-iso-corp-${randomUUID()}`;
    const planIdA = `test-plan-iso-a-${randomUUID()}`;
    const memberIdA = randomUUID();
    const memberIdB = randomUUID();

    beforeAll(async () => {
      tenantA = await createTestTenant('test-swecham');
      tenantB = await createTestTenant('test-swecham');
      const userA = await createActiveTestUser('admin');
      const userB = await createActiveTestUser('admin');
      // Tenant A: bundled corporate + Diamond partnership + matched member
      await runInTenant(tenantA.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenantA.ctx.slug,
          planId: corpPlanId,
          planName: { en: 'Corp Bundle — A' },
          benefitMatrix: premiumCorporateMatrix,
          planCategory: 'corporate',
          createdBy: userA.userId,
        });
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenantA.ctx.slug,
          planId: planIdA,
          planName: { en: 'Diamond — Tenant A' },
          benefitMatrix: diamondPartnershipMatrix,
          planCategory: 'partnership',
          includesCorporatePlanId: corpPlanId,
          createdBy: userA.userId,
        });
        await tx.insert(members).values({
          tenantId: tenantA.ctx.slug,
          memberId: memberIdA,
          companyName: 'Tenant A Co',
          country: 'TH',
          planId: planIdA,
          planYear: 2026,
          status: 'active',
        } as unknown as typeof members.$inferInsert);
        await tx.insert(tenantWebhookConfigs).values({
          tenantId: tenantA.ctx.slug,
          source: 'eventcreate',
          webhookSecretActive: 'test-secret-' + 'a'.repeat(43),
          enabled: true,
        });
      });
      // Tenant B: independent corporate + partnership plan + member
      // (same plan_id slugs are fine because tenant_id scopes the
      // composite key)
      await runInTenant(tenantB.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenantB.ctx.slug,
          planId: corpPlanId,
          planName: { en: 'Corp Bundle — B' },
          benefitMatrix: premiumCorporateMatrix,
          planCategory: 'corporate',
          createdBy: userB.userId,
        });
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenantB.ctx.slug,
          planId: planIdA, // same slug, different tenant
          planName: { en: 'Diamond — Tenant B' },
          benefitMatrix: diamondPartnershipMatrix,
          planCategory: 'partnership',
          includesCorporatePlanId: corpPlanId,
          createdBy: userB.userId,
        });
        await tx.insert(members).values({
          tenantId: tenantB.ctx.slug,
          memberId: memberIdB,
          companyName: 'Tenant B Co',
          country: 'TH',
          planId: planIdA,
          planYear: 2026,
          status: 'active',
        } as unknown as typeof members.$inferInsert);
        await tx.insert(tenantWebhookConfigs).values({
          tenantId: tenantB.ctx.slug,
          source: 'eventcreate',
          webhookSecretActive: 'test-secret-' + 'a'.repeat(43),
          enabled: true,
        });
      });
    });

    afterAll(async () => {
      await tenantA.cleanup();
      await tenantB.cleanup();
    });

    it('Tenant A 6 ingests do NOT decrement Tenant B quota counters', async () => {
      const deps = makeIngestWebhookAttendeeDeps();
      const eventExternalId = `event_iso_${Date.now()}`;
      // Pre-seed event row in Tenant A
      await runInTenant(tenantA.ctx, async (tx) => {
        await tx.insert(events).values({
          tenantId: tenantA.ctx.slug,
          eventId: randomUUID(),
          source: 'eventcreate',
          externalId: eventExternalId,
          name: 'Tenant A Event',
          startDate: new Date('2026-08-01T18:00:00+07:00'),
          isPartnerBenefit: true,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
      });
      // Add contact for member A
      await runInTenant(tenantA.ctx, async (tx) => {
        await tx.insert(contacts).values({
          tenantId: tenantA.ctx.slug,
          contactId: randomUUID(),
          memberId: memberIdA,
          firstName: 'Iso',
          lastName: 'A',
          email: 'iso@tenanta.example',
          isPrimary: true,
        } as unknown as typeof contacts.$inferInsert);
      });

      // Ingest 6 attendees in Tenant A
      for (let i = 0; i < 6; i++) {
        const result = await ingestWebhookAttendee(
          {
            tenantId: tenantA.ctx.slug,
            requestId: `req-iso-A-${Date.now()}-${i}`,
            source: 'eventcreate_webhook',
            rawPayload: makeWebhookPayload({
              event: {
                externalId: eventExternalId,
                name: 'Tenant A Event',
                startDate: '2026-08-01T18:00:00+07:00',
              },
              attendee: {
                externalId: `att_iso_A_${i}`,
                email: i === 0 ? 'iso@tenanta.example' : `iso${i}@tenanta.example`,
                companyName: 'Tenant A Co',
                fullName: `Iso A ${i}`,
              },
            }),
            sourceIp: '127.0.0.1',
          },
          deps,
        );
        expect(result.ok).toBe(true);
      }

      // Tenant B's member should have ZERO event_registrations rows
      const tenantBRows = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(eq(eventRegistrations.matchedMemberId, memberIdB)),
      );
      expect(tenantBRows.length).toBe(0);

      // Tenant B should have ZERO quota_* audit rows
      const tenantBAuditRows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenantB.ctx.slug));
      const quotaAudits = tenantBAuditRows.filter((r) =>
        String(r.eventType).startsWith('quota_'),
      );
      expect(quotaAudits.length).toBe(0);
    });
  });

  describe('US4 AS4 — refund credit-back (FR-018)', () => {
    let tenant: TestTenant;
    const corpPlanId = `test-plan-refund-corp-${randomUUID()}`;
    const partnershipPlanId = `test-plan-refund-partner-${randomUUID()}`;
    const memberId = randomUUID();
    const ATTENDEE_EMAIL = 'jane@refund.example';
    const COMPANY_NAME = 'Refund Test Co';
    const ATTENDEE_EXTERNAL_ID = `att_refund_${Date.now()}`;
    const eventExternalId = `event_refund_${Date.now()}`;

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      const user = await createActiveTestUser('admin');
      await runInTenant(tenant.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: corpPlanId,
          planName: { en: 'Corp Bundle (refund)' },
          benefitMatrix: premiumCorporateMatrix,
          planCategory: 'corporate',
          createdBy: user.userId,
        });
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: partnershipPlanId,
          planName: { en: 'Diamond Partnership (refund)' },
          benefitMatrix: diamondPartnershipMatrix,
          planCategory: 'partnership',
          includesCorporatePlanId: corpPlanId,
          createdBy: user.userId,
        });
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          companyName: COMPANY_NAME,
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
          lastName: 'Refund',
          email: ATTENDEE_EMAIL,
          isPrimary: true,
        } as unknown as typeof contacts.$inferInsert);
        await tx.insert(tenantWebhookConfigs).values({
          tenantId: tenant.ctx.slug,
          source: 'eventcreate',
          webhookSecretActive: 'test-secret-' + 'a'.repeat(43),
          enabled: true,
        });
        await tx.insert(events).values({
          tenantId: tenant.ctx.slug,
          eventId: randomUUID(),
          source: 'eventcreate',
          externalId: eventExternalId,
          name: 'Refund Test Event',
          startDate: new Date('2026-06-21T18:00:00+07:00'),
          isPartnerBenefit: true,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
      });
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('paid → refunded re-ingest: row flips counted=false + quota_credit_back_refund audit emitted', async () => {
      const deps = makeIngestWebhookAttendeeDeps();
      // (1) Initial paid ingest → counted_against_partnership=true
      const paidResult = await ingestWebhookAttendee(
        {
          tenantId: tenant.ctx.slug,
          requestId: `req-refund-paid-${Date.now()}`,
          source: 'eventcreate_webhook',
          rawPayload: makeWebhookPayload({
            event: {
              externalId: eventExternalId,
              name: 'Refund Test Event',
              startDate: '2026-06-21T18:00:00+07:00',
            },
            attendee: {
              externalId: ATTENDEE_EXTERNAL_ID,
              email: ATTENDEE_EMAIL,
              companyName: COMPANY_NAME,
              fullName: 'Jane Refund',
              paymentStatus: 'paid',
            },
          }),
          sourceIp: '127.0.0.1',
        },
        deps,
      );
      expect(paidResult.ok).toBe(true);
      // Verify the row is counted
      const paidRow = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(eq(eventRegistrations.matchedMemberId, memberId)),
      );
      expect(paidRow.length).toBe(1);
      expect(paidRow[0]!.countedAgainstPartnership).toBe(true);
      expect(paidRow[0]!.paymentStatus).toBe('paid');

      // (2) Re-ingest SAME attendee with payment_status='refunded' but
      // a fresh X-Request-ID (Zapier delivers refund as a new event,
      // not a retry of the original). The ingest detects the
      // (paid → refunded) transition on the existing row and credit-
      // backs the quota.
      const refundResult = await ingestWebhookAttendee(
        {
          tenantId: tenant.ctx.slug,
          requestId: `req-refund-flip-${Date.now()}`,
          source: 'eventcreate_webhook',
          rawPayload: makeWebhookPayload({
            event: {
              externalId: eventExternalId,
              name: 'Refund Test Event',
              startDate: '2026-06-21T18:00:00+07:00',
            },
            attendee: {
              externalId: ATTENDEE_EXTERNAL_ID,
              email: ATTENDEE_EMAIL,
              companyName: COMPANY_NAME,
              fullName: 'Jane Refund',
              paymentStatus: 'refunded',
            },
          }),
          sourceIp: '127.0.0.1',
        },
        deps,
      );
      expect(refundResult.ok).toBe(true);
      if (refundResult.ok) {
        // The IngestSuccess.quotaEffect surfaces POST-refund state
        expect(refundResult.value.quotaEffect.countedAgainstPartnership).toBe(false);
        expect(refundResult.value.quotaEffect.countedAgainstCulturalQuota).toBe(false);
      }

      // (3) Verify the row state in DB: payment_status='refunded' +
      // counted_against_partnership=false
      const refundedRow = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(eq(eventRegistrations.matchedMemberId, memberId)),
      );
      expect(refundedRow.length).toBe(1);
      expect(refundedRow[0]!.paymentStatus).toBe('refunded');
      expect(refundedRow[0]!.countedAgainstPartnership).toBe(false);
      expect(refundedRow[0]!.countedAgainstCulturalQuota).toBe(false);

      // (4) Verify audit trail: exactly 1 quota_credit_back_refund
      // (scope=partnership), and the original decrement audit is
      // preserved (NOT retroactively deleted).
      const allAudits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug));
      const decrementAudits = allAudits.filter(
        (r) => String(r.eventType) === 'quota_partnership_decremented',
      );
      expect(decrementAudits.length).toBe(1);
      const creditBackAudits = allAudits.filter(
        (r) => String(r.eventType) === 'quota_credit_back_refund',
      );
      expect(creditBackAudits.length).toBe(1);
      const cbPayload = creditBackAudits[0]!.payload as Record<string, unknown>;
      expect(cbPayload.scope).toBe('partnership');
      // allotmentAfter = allotment 6 - consumed 0 (post-flip) = 6
      expect(cbPayload.allotmentAfter).toBe(6);
      expect(cbPayload.memberId).toBe(memberId);
    });

    it('re-replay refund (already refunded) → idempotent: no second credit_back audit', async () => {
      const deps = makeIngestWebhookAttendeeDeps();
      // (Continuing from previous test — the row is already refunded.)
      // Re-deliver the refund payload with yet another fresh X-Request-ID.
      const replay = await ingestWebhookAttendee(
        {
          tenantId: tenant.ctx.slug,
          requestId: `req-refund-replay-${Date.now()}`,
          source: 'eventcreate_webhook',
          rawPayload: makeWebhookPayload({
            event: {
              externalId: eventExternalId,
              name: 'Refund Test Event',
              startDate: '2026-06-21T18:00:00+07:00',
            },
            attendee: {
              externalId: ATTENDEE_EXTERNAL_ID,
              email: ATTENDEE_EMAIL,
              companyName: COMPANY_NAME,
              fullName: 'Jane Refund',
              paymentStatus: 'refunded',
            },
          }),
          sourceIp: '127.0.0.1',
        },
        deps,
      );
      expect(replay.ok).toBe(true);

      // Audit count for quota_credit_back_refund must remain 1 (not 2)
      // because the row was already in refunded state before this
      // delivery — the use-case's `isRefundTransition` guard
      // (existingPaymentStatus !== 'refunded') correctly skips the
      // emit.
      const allAudits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug));
      const creditBackAudits = allAudits.filter(
        (r) => String(r.eventType) === 'quota_credit_back_refund',
      );
      expect(creditBackAudits.length).toBe(1);
    });
  });
});

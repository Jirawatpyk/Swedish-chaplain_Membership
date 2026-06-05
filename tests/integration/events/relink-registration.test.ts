/**
 * F6 Phase 9 / US6 — relinkRegistration integration test (live Neon Singapore).
 *
 * Verifies FR-014 end-to-end through the production `runRelinkRegistration`
 * composition root.
 *
 * Scenarios (11 total — 6 Phase 9 baseline + 4 Round-1 + 1 Round-2):
 *   1. Happy-path: Member A counted=true → relink to Member B → A credit-
 *      back + B decremented, registration row updated, 3 audits emitted
 *      (quota_credit_back_archive + quota_partnership_decremented +
 *      registration_relinked) with correct quotaImpact payload.
 *   2. Pseudonymised-row guard: registration with
 *      `pii_pseudonymised_at != NULL` → returns
 *      `pseudonymised_row_rejected`; NO DB mutation; NO audit emission.
 *   3. Same-member noop: relink to current matched member returns
 *      `ok({ noop: true })`; NO DB mutation; NO audit emission.
 *   4. new_member_not_found: relink to a random UUID member returns
 *      `new_member_not_found`; the row's matched_member_id is unchanged.
 *   5. registration_not_found: relink against an unknown registrationId.
 *   6. event_archived guard (Round-1 test-H1): pre-archived event
 *      blocks relink with `event_archived` + zero audit + row unchanged.
 *   7. cultural credit-back (Round-1 test-H3): cultural-only event,
 *      A→B verifies `quota_cultural_decremented` + scopes=['cultural'].
 *   8. over-quota on new member (Round-1 test-H4): B has no remaining
 *      quota → row persists counted=false + `quota_over_quota_warning`
 *      + macro `decrementedFor=null` + `creditedBackFor=A`.
 *   9. updateMatchAndQuota DB-layer pseudonymised guard (Round-1 test-H2):
 *      calls repo directly bypassing Application pre-check → asserts
 *      `pseudonymised_row_rejected` from the DB-layer WHERE guard.
 *  10. event_path_mismatch (Round-2 code-H1): URL eventId ≠
 *      registration.eventId → refuses BEFORE any mutation + zero audit
 *      + row unchanged.
 *  11. Cross-tenant probe (Principle I Review-Gate blocker): an actor in
 *      Tenant A cannot relink Tenant B's registration — RLS hides the
 *      row, the use-case returns `registration_not_found`, and Tenant
 *      B's row remains untouched. Mirror of archive-event.test.ts
 *      WARN-3 strengthening pattern.
 *
 * Spec authority:
 *   - FR-014 (manual relink + credit-back + pseudonymised guard)
 *   - US6 AS1 + AS2 (non_member → member; counted A → B credit-back)
 *   - Constitution v1.4.0 Principle I (NON-NEG) sub-clause 3 —
 *     mandatory cross-tenant integration test for every UPDATE surface
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
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
import { runRelinkRegistration } from '@/lib/events-admin-deps';
import { asUserId } from '@/modules/auth';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createActiveTestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';

// Diamond partnership matrix — partnership-tickets-per-event = 6, plenty
// of headroom so both Member A (pre-relink) and Member B (post-relink)
// have room to count.
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

// Premium corporate matrix referenced by the partnership plan via
// `includesCorporatePlanId` (mandated by the
// `partnership_bundles_corporate` CHECK constraint).
const premiumMatrix: BenefitMatrix = {
  ...DEFAULT_TEST_BENEFIT_MATRIX,
  cultural_tickets_per_year: 2,
  partnership: null,
};

describe('F6 Phase 9 — relinkRegistration (FR-014 / US6)', () => {
  describe('happy-path: A counted → relink to B (credit-back + decrement + audits)', () => {
    let tenant: TestTenant;
    let userId: string;
    const corpPlanId = `test-plan-relink-corp-${randomUUID()}`;
    const partnershipPlanId = `test-plan-relink-partner-${randomUUID()}`;
    const memberAId = randomUUID();
    const memberBId = randomUUID();
    const eventInternalId = randomUUID();
    const registrationId = randomUUID();

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      const u = await createActiveTestUser('admin');
      userId = u.userId;
      await runInTenant(tenant.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: corpPlanId,
          planName: { en: 'Corp Bundle (relink)' },
          benefitMatrix: premiumMatrix,
          planCategory: 'corporate',
          createdBy: u.userId,
        });
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: partnershipPlanId,
          planName: { en: 'Diamond Partnership (relink)' },
          benefitMatrix: diamondMatrix,
          planCategory: 'partnership',
          includesCorporatePlanId: corpPlanId,
          createdBy: u.userId,
        });
        // Member A — initial owner of the registration.
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId: memberAId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Member A Co',
          country: 'TH',
          planId: partnershipPlanId,
          planYear: 2026,
          status: 'active',
        } as unknown as typeof members.$inferInsert);
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId: memberAId,
          firstName: 'Alice',
          lastName: 'A',
          email: 'alice@member-a.example',
          isPrimary: true,
        } as unknown as typeof contacts.$inferInsert);
        // Member B — relink target.
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId: memberBId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Member B Co',
          country: 'TH',
          planId: partnershipPlanId,
          planYear: 2026,
          status: 'active',
        } as unknown as typeof members.$inferInsert);
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId: memberBId,
          firstName: 'Bob',
          lastName: 'B',
          email: 'bob@member-b.example',
          isPrimary: true,
        } as unknown as typeof contacts.$inferInsert);
        await tx.insert(tenantWebhookConfigs).values({
          tenantId: tenant.ctx.slug,
          source: 'eventcreate',
          webhookSecretActive: 'test-secret-' + 'a'.repeat(43),
          enabled: true,
        });
        // Event flagged is_partner_benefit=true so the registration
        // counts against partnership allotment.
        await tx.insert(events).values({
          tenantId: tenant.ctx.slug,
          eventId: eventInternalId,
          source: 'eventcreate',
          externalId: `event_relink_${Date.now()}`,
          name: 'Relink Test Event',
          startDate: new Date('2026-06-21T18:00:00+07:00'),
          isPartnerBenefit: true,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
        // Registration seeded directly with counted=true against Member A
        // — skips the webhook ingest path because we want a clean
        // synthetic starting state for the relink (the webhook path
        // would emit its own quota_partnership_decremented audit row
        // and complicate the post-relink assertion arithmetic).
        await tx.insert(eventRegistrations).values({
          tenantId: tenant.ctx.slug,
          registrationId,
          eventId: eventInternalId,
          externalId: `att_relink_${Date.now()}`,
          attendeeEmail: 'alice@member-a.example',
          attendeeName: 'Alice A',
          attendeeCompany: 'Member A Co',
          matchType: 'member_contact',
          matchedMemberId: memberAId,
          // matched_contact_id required by the member_contact CHECK
          // constraint — look it up via the contact row we just
          // inserted (Alice's primary contact).
          matchedContactId: (
            await tx
              .select({ contactId: contacts.contactId })
              .from(contacts)
              .where(
                and(
                  eq(contacts.memberId, memberAId),
                  eq(contacts.tenantId, tenant.ctx.slug),
                ),
              )
              .limit(1)
          )[0]!.contactId,
          ticketType: 'Member ticket',
          ticketPriceThb: 0,
          paymentStatus: 'free',
          countedAgainstPartnership: true,
          countedAgainstCulturalQuota: false,
          registeredAt: new Date('2026-06-15T10:00:00Z'),
          piiPseudonymisedAt: null,
        } as unknown as typeof eventRegistrations.$inferInsert);
      });
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('relink Member A → Member B: credit-back, decrement, 3 audits, quotaImpact correct', async () => {
      const result = await runRelinkRegistration(tenant.ctx.slug, {
        registrationId: registrationId as never,
        newMatchedMemberId: memberBId as never,
        // Round-2 code-H1 — eventIdFromPath null skips the path-mismatch
        // check (these tests don't model URL-routing). Phase 9 happy-
        // path + error scenarios verify the use-case logic; the
        // path-mismatch case has its own dedicated test added below.
        eventIdFromPath: null,
        actorUserId: asUserId(userId),
        occurredAt: new Date(),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.noop).toBe(false);
      if (result.value.noop) return; // exhaustiveness
      expect(result.value.previousMatchedMemberId).toBe(memberAId);
      expect(result.value.newMatchedMemberId).toBe(memberBId);
      expect(result.value.previousMatchType).toBe('member_contact');
      expect(result.value.newMatchType).toBe('member_contact');
      expect(result.value.quotaImpact.creditedBackFor).toBe(memberAId);
      expect(result.value.quotaImpact.decrementedFor).toBe(memberBId);
      expect(result.value.quotaImpact.scopes).toEqual(['partnership']);

      // Registration row updated: matched_member_id=B, counted=true
      // (B has room — Diamond allotment=6, B's consumed was 0).
      const rows = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(eq(eventRegistrations.registrationId, registrationId)),
      );
      expect(rows.length).toBe(1);
      const row = rows[0]!;
      expect(row.matchedMemberId).toBe(memberBId);
      expect(row.matchType).toBe('member_contact');
      // FR-014 — admin relink always nulls the contactId per the
      // use-case contract (relink is by-member, not by-contact).
      expect(row.matchedContactId).toBeNull();
      expect(row.countedAgainstPartnership).toBe(true);
      expect(row.countedAgainstCulturalQuota).toBe(false);

      // Audit log assertions — scoped to THIS registration so other
      // tests' audit rows do not contaminate counts.
      const auditRows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug));

      const creditBacks = auditRows.filter(
        (r) =>
          String(r.eventType) === 'quota_credit_back_archive' &&
          (r.payload as Record<string, unknown>).registrationId === registrationId,
      );
      expect(creditBacks.length).toBe(1);
      const cbPayload = creditBacks[0]!.payload as Record<string, unknown>;
      expect(cbPayload.memberId).toBe(memberAId);
      expect(cbPayload.scope).toBe('partnership');

      const decrements = auditRows.filter(
        (r) =>
          String(r.eventType) === 'quota_partnership_decremented' &&
          (r.payload as Record<string, unknown>).registrationId === registrationId,
      );
      expect(decrements.length).toBe(1);
      const decPayload = decrements[0]!.payload as Record<string, unknown>;
      expect(decPayload.memberId).toBe(memberBId);

      const macro = auditRows.filter(
        (r) =>
          String(r.eventType) === 'registration_relinked' &&
          (r.payload as Record<string, unknown>).registrationId === registrationId,
      );
      expect(macro.length).toBe(1);
      const macroPayload = macro[0]!.payload as Record<string, unknown>;
      expect(macroPayload.previousMatchedMemberId).toBe(memberAId);
      expect(macroPayload.newMatchedMemberId).toBe(memberBId);
      expect(macroPayload.previousMatchType).toBe('member_contact');
      expect(macroPayload.newMatchType).toBe('member_contact');
      const quotaImpact = macroPayload.quotaImpact as Record<string, unknown>;
      expect(quotaImpact.creditedBackFor).toBe(memberAId);
      expect(quotaImpact.decrementedFor).toBe(memberBId);
      expect(quotaImpact.scopes).toEqual(['partnership']);
    });
  });

  describe('FR-014 round-2 R4 — pseudonymised row rejected with no mutation + no audit', () => {
    let tenant: TestTenant;
    let userId: string;
    const memberBId = randomUUID();
    const eventInternalId = randomUUID();
    const pseudoRegId = randomUUID();
    const corpPlanId = `test-plan-relink-pseudo-corp-${randomUUID()}`;
    const partnershipPlanId = `test-plan-relink-pseudo-partner-${randomUUID()}`;

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      const u = await createActiveTestUser('admin');
      userId = u.userId;
      await runInTenant(tenant.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: corpPlanId,
          planName: { en: 'Corp Bundle (pseudo)' },
          benefitMatrix: premiumMatrix,
          planCategory: 'corporate',
          createdBy: u.userId,
        });
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: partnershipPlanId,
          planName: { en: 'Diamond (pseudo)' },
          benefitMatrix: diamondMatrix,
          planCategory: 'partnership',
          includesCorporatePlanId: corpPlanId,
          createdBy: u.userId,
        });
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId: memberBId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Member B Co',
          country: 'TH',
          planId: partnershipPlanId,
          planYear: 2026,
          status: 'active',
        } as unknown as typeof members.$inferInsert);
        await tx.insert(events).values({
          tenantId: tenant.ctx.slug,
          eventId: eventInternalId,
          source: 'eventcreate',
          externalId: `event_pseudo_${Date.now()}`,
          name: 'Pseudo Event',
          startDate: new Date('2026-06-21T18:00:00+07:00'),
          isPartnerBenefit: true,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
        // Pseudonymised non_member row (typical retention-sweep aftermath).
        await tx.insert(eventRegistrations).values({
          tenantId: tenant.ctx.slug,
          registrationId: pseudoRegId,
          eventId: eventInternalId,
          externalId: `att_pseudo_${Date.now()}`,
          attendeeEmail: 'pseudo-hash@pseudo.example',
          attendeeName: 'pseudo-name-hash',
          attendeeCompany: 'pseudo-company-hash',
          matchType: 'non_member',
          matchedMemberId: null,
          matchedContactId: null,
          ticketType: 'Standard',
          ticketPriceThb: 50000,
          paymentStatus: 'paid',
          countedAgainstPartnership: false,
          countedAgainstCulturalQuota: false,
          registeredAt: new Date('2024-04-01T10:00:00Z'),
          piiPseudonymisedAt: new Date('2026-04-01T10:00:00Z'),
        } as unknown as typeof eventRegistrations.$inferInsert);
      });
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('returns pseudonymised_row_rejected; row + audit log untouched', async () => {
      const auditsBeforeCount = (
        await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.tenantId, tenant.ctx.slug))
      ).length;

      const result = await runRelinkRegistration(tenant.ctx.slug, {
        registrationId: pseudoRegId as never,
        newMatchedMemberId: memberBId as never,
        // Round-2 code-H1 — eventIdFromPath null skips the path-mismatch
        // check (these tests don't model URL-routing). Phase 9 happy-
        // path + error scenarios verify the use-case logic; the
        // path-mismatch case has its own dedicated test added below.
        eventIdFromPath: null,
        actorUserId: asUserId(userId),
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('pseudonymised_row_rejected');

      // Row untouched.
      const rows = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(eq(eventRegistrations.registrationId, pseudoRegId)),
      );
      expect(rows.length).toBe(1);
      const row = rows[0]!;
      expect(row.matchType).toBe('non_member');
      expect(row.matchedMemberId).toBeNull();
      expect(row.matchedContactId).toBeNull();
      expect(row.piiPseudonymisedAt).not.toBeNull();

      // Audit log row count unchanged for this tenant.
      const auditsAfterCount = (
        await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.tenantId, tenant.ctx.slug))
      ).length;
      expect(auditsAfterCount).toBe(auditsBeforeCount);
    });
  });

  describe('error paths: same-member noop + new_member_not_found + registration_not_found', () => {
    let tenant: TestTenant;
    let userId: string;
    const memberId = randomUUID();
    const eventInternalId = randomUUID();
    const registrationId = randomUUID();
    const corpPlanId = `test-plan-relink-err-corp-${randomUUID()}`;
    const partnershipPlanId = `test-plan-relink-err-partner-${randomUUID()}`;

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      const u = await createActiveTestUser('admin');
      userId = u.userId;
      await runInTenant(tenant.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: corpPlanId,
          planName: { en: 'Corp (err)' },
          benefitMatrix: premiumMatrix,
          planCategory: 'corporate',
          createdBy: u.userId,
        });
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: partnershipPlanId,
          planName: { en: 'Diamond (err)' },
          benefitMatrix: diamondMatrix,
          planCategory: 'partnership',
          includesCorporatePlanId: corpPlanId,
          createdBy: u.userId,
        });
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Err Member Co',
          country: 'TH',
          planId: partnershipPlanId,
          planYear: 2026,
          status: 'active',
        } as unknown as typeof members.$inferInsert);
        const contactId = randomUUID();
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId,
          memberId,
          firstName: 'Err',
          lastName: 'Member',
          email: 'err@member.example',
          isPrimary: true,
        } as unknown as typeof contacts.$inferInsert);
        await tx.insert(events).values({
          tenantId: tenant.ctx.slug,
          eventId: eventInternalId,
          source: 'eventcreate',
          externalId: `event_err_${Date.now()}`,
          name: 'Err Event',
          startDate: new Date('2026-06-21T18:00:00+07:00'),
          isPartnerBenefit: true,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
        await tx.insert(eventRegistrations).values({
          tenantId: tenant.ctx.slug,
          registrationId,
          eventId: eventInternalId,
          externalId: `att_err_${Date.now()}`,
          attendeeEmail: 'err@member.example',
          attendeeName: 'Err Member',
          attendeeCompany: 'Err Member Co',
          matchType: 'member_contact',
          matchedMemberId: memberId,
          matchedContactId: contactId,
          ticketType: 'Member',
          ticketPriceThb: 0,
          paymentStatus: 'free',
          countedAgainstPartnership: true,
          countedAgainstCulturalQuota: false,
          registeredAt: new Date('2026-06-15T10:00:00Z'),
          piiPseudonymisedAt: null,
        } as unknown as typeof eventRegistrations.$inferInsert);
      });
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('same-member relink short-circuits with ok({noop:true}) and emits no audit', async () => {
      const auditsBeforeCount = (
        await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.tenantId, tenant.ctx.slug))
      ).length;

      const result = await runRelinkRegistration(tenant.ctx.slug, {
        registrationId: registrationId as never,
        newMatchedMemberId: memberId as never,
        // Round-2 code-H1 — eventIdFromPath null skips the path-mismatch
        // check (these tests don't model URL-routing). Phase 9 happy-
        // path + error scenarios verify the use-case logic; the
        // path-mismatch case has its own dedicated test added below.
        eventIdFromPath: null,
        actorUserId: asUserId(userId),
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.noop).toBe(true);
      if (!result.value.noop) return;
      expect(result.value.matchedMemberId).toBe(memberId);

      const auditsAfterCount = (
        await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.tenantId, tenant.ctx.slug))
      ).length;
      expect(auditsAfterCount).toBe(auditsBeforeCount);
    });

    it('relink to an unknown member returns new_member_not_found and leaves the row unchanged', async () => {
      const ghostMemberId = randomUUID();
      const result = await runRelinkRegistration(tenant.ctx.slug, {
        registrationId: registrationId as never,
        newMatchedMemberId: ghostMemberId as never,
        // Round-2 code-H1 — eventIdFromPath null skips the path-mismatch
        // check (these tests don't model URL-routing). Phase 9 happy-
        // path + error scenarios verify the use-case logic; the
        // path-mismatch case has its own dedicated test added below.
        eventIdFromPath: null,
        actorUserId: asUserId(userId),
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('new_member_not_found');

      // Row's matched_member_id still equals the original (memberId).
      const rows = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select({ matchedMemberId: eventRegistrations.matchedMemberId })
          .from(eventRegistrations)
          .where(eq(eventRegistrations.registrationId, registrationId)),
      );
      expect(rows[0]?.matchedMemberId).toBe(memberId);
    });

    it('registration_not_found when registrationId does not exist in this tenant', async () => {
      const result = await runRelinkRegistration(tenant.ctx.slug, {
        registrationId: randomUUID() as never,
        newMatchedMemberId: memberId as never,
        // Round-2 code-H1 — eventIdFromPath null skips the path-mismatch
        // check (these tests don't model URL-routing). Phase 9 happy-
        // path + error scenarios verify the use-case logic; the
        // path-mismatch case has its own dedicated test added below.
        eventIdFromPath: null,
        actorUserId: asUserId(userId),
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('registration_not_found');
    });
  });

  // Round-1 test-H1 — covers the `event_archived` short-circuit at
  // relink-registration.ts:284, an admin-concurrent race (Admin A
  // archives at T0, Admin B relinks at T1). Without this scenario, a
  // regression that drops the archived guard would silently mutate
  // quotas on a quota-neutral event.
  describe('event_archived guard (Round-1 test-H1)', () => {
    let tenant: TestTenant;
    let userId: string;
    const memberId = randomUUID();
    const eventInternalId = randomUUID();
    const registrationId = randomUUID();
    const targetMemberId = randomUUID();
    const corpPlanId = `test-plan-relink-arch-corp-${randomUUID()}`;
    const partnershipPlanId = `test-plan-relink-arch-partner-${randomUUID()}`;

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      const u = await createActiveTestUser('admin');
      userId = u.userId;
      await runInTenant(tenant.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: corpPlanId,
          planName: { en: 'Corp (arch-guard)' },
          benefitMatrix: premiumMatrix,
          planCategory: 'corporate',
          createdBy: u.userId,
        });
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: partnershipPlanId,
          planName: { en: 'Diamond (arch-guard)' },
          benefitMatrix: diamondMatrix,
          planCategory: 'partnership',
          includesCorporatePlanId: corpPlanId,
          createdBy: u.userId,
        });
        await tx.insert(members).values([
          {
            tenantId: tenant.ctx.slug,
            memberId,
            memberNumber: nextSeedMemberNumber(),
            companyName: 'Arch Member A',
            country: 'TH',
            planId: partnershipPlanId,
            planYear: 2026,
            status: 'active',
          },
          {
            tenantId: tenant.ctx.slug,
            memberId: targetMemberId,
            memberNumber: nextSeedMemberNumber(),
            companyName: 'Arch Member B',
            country: 'TH',
            planId: partnershipPlanId,
            planYear: 2026,
            status: 'active',
          },
        ] as unknown as typeof members.$inferInsert[]);
        const contactId = randomUUID();
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId,
          memberId,
          firstName: 'Arch',
          lastName: 'Member',
          email: 'arch@member.example',
          isPrimary: true,
        } as unknown as typeof contacts.$inferInsert);
        // Event with archivedAt set (race: another admin archived
        // between the row insert and the relink call).
        await tx.insert(events).values({
          tenantId: tenant.ctx.slug,
          eventId: eventInternalId,
          source: 'eventcreate',
          externalId: `event_arch_${Date.now()}`,
          name: 'Archived Event',
          startDate: new Date('2026-06-21T18:00:00+07:00'),
          isPartnerBenefit: true,
          isCulturalEvent: false,
          archivedAt: new Date(),
        } as unknown as typeof events.$inferInsert);
        await tx.insert(eventRegistrations).values({
          tenantId: tenant.ctx.slug,
          registrationId,
          eventId: eventInternalId,
          externalId: `att_arch_${Date.now()}`,
          attendeeEmail: 'arch@member.example',
          attendeeName: 'Arch Member',
          attendeeCompany: 'Arch Member A',
          matchType: 'member_contact',
          matchedMemberId: memberId,
          matchedContactId: contactId,
          ticketType: 'Member',
          ticketPriceThb: 0,
          paymentStatus: 'free',
          // Note: pre-archive counted=true; archive flow would have
          // credited back, but we synthesize the state directly to
          // exercise the relink-guard, not the archive flow.
          countedAgainstPartnership: true,
          countedAgainstCulturalQuota: false,
          registeredAt: new Date('2026-06-15T10:00:00Z'),
          piiPseudonymisedAt: null,
        } as unknown as typeof eventRegistrations.$inferInsert);
      });
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('returns event_archived and emits no audit + leaves row unchanged', async () => {
      const auditsBeforeCount = (
        await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.tenantId, tenant.ctx.slug))
      ).length;

      const result = await runRelinkRegistration(tenant.ctx.slug, {
        registrationId: registrationId as never,
        newMatchedMemberId: targetMemberId as never,
        // Round-2 code-H1 — eventIdFromPath null skips the path-mismatch
        // check (these tests don't model URL-routing). Phase 9 happy-
        // path + error scenarios verify the use-case logic; the
        // path-mismatch case has its own dedicated test added below.
        eventIdFromPath: null,
        actorUserId: asUserId(userId),
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('event_archived');

      // No audit row (the guard fires before any audit emission).
      const auditsAfter = (
        await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.tenantId, tenant.ctx.slug))
      ).length;
      expect(auditsAfter).toBe(auditsBeforeCount);

      // Row state unchanged.
      const rows = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(eq(eventRegistrations.registrationId, registrationId)),
      );
      expect(rows[0]?.matchedMemberId).toBe(memberId);
      expect(rows[0]?.countedAgainstPartnership).toBe(true);
    });
  });

  // Round-1 test-H3 — covers the cultural credit-back + decrement
  // branches (relink-registration.ts:410-425 + :516-527). Cultural
  // quota uses per-year arithmetic distinct from per-event partnership
  // — a regression in scope-pair branching would silently miscredit.
  describe('cultural credit-back (Round-1 test-H3)', () => {
    let tenant: TestTenant;
    let userId: string;
    const corpPlanId = `test-plan-relink-cult-corp-${randomUUID()}`;
    const memberAId = randomUUID();
    const memberBId = randomUUID();
    const eventInternalId = randomUUID();
    const registrationId = randomUUID();

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      const u = await createActiveTestUser('admin');
      userId = u.userId;
      await runInTenant(tenant.ctx, async (tx) => {
        // Premium corporate matrix carries cultural_tickets_per_year=2;
        // no partnership block required (the event is cultural-only).
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: corpPlanId,
          planName: { en: 'Corp Cultural Bundle' },
          benefitMatrix: premiumMatrix,
          planCategory: 'corporate',
          createdBy: u.userId,
        });
        await tx.insert(members).values([
          {
            tenantId: tenant.ctx.slug,
            memberId: memberAId,
            memberNumber: nextSeedMemberNumber(),
            companyName: 'Cultural Member A',
            country: 'TH',
            planId: corpPlanId,
            planYear: 2026,
            status: 'active',
          },
          {
            tenantId: tenant.ctx.slug,
            memberId: memberBId,
            memberNumber: nextSeedMemberNumber(),
            companyName: 'Cultural Member B',
            country: 'TH',
            planId: corpPlanId,
            planYear: 2026,
            status: 'active',
          },
        ] as unknown as typeof members.$inferInsert[]);
        const contactAId = randomUUID();
        await tx.insert(contacts).values([
          {
            tenantId: tenant.ctx.slug,
            contactId: contactAId,
            memberId: memberAId,
            firstName: 'Alice',
            lastName: 'Cultural',
            email: 'alice@cultural-a.example',
            isPrimary: true,
          },
          {
            tenantId: tenant.ctx.slug,
            contactId: randomUUID(),
            memberId: memberBId,
            firstName: 'Bob',
            lastName: 'Cultural',
            email: 'bob@cultural-b.example',
            isPrimary: true,
          },
        ] as unknown as typeof contacts.$inferInsert[]);
        // Cultural-only event.
        await tx.insert(events).values({
          tenantId: tenant.ctx.slug,
          eventId: eventInternalId,
          source: 'eventcreate',
          externalId: `event_cult_${Date.now()}`,
          name: 'Cultural Event',
          startDate: new Date('2026-06-21T18:00:00+07:00'),
          isPartnerBenefit: false,
          isCulturalEvent: true,
        } as unknown as typeof events.$inferInsert);
        await tx.insert(eventRegistrations).values({
          tenantId: tenant.ctx.slug,
          registrationId,
          eventId: eventInternalId,
          externalId: `att_cult_${Date.now()}`,
          attendeeEmail: 'alice@cultural-a.example',
          attendeeName: 'Alice Cultural',
          attendeeCompany: 'Cultural Member A',
          matchType: 'member_contact',
          matchedMemberId: memberAId,
          matchedContactId: contactAId,
          ticketType: 'Cultural',
          ticketPriceThb: 0,
          paymentStatus: 'free',
          countedAgainstPartnership: false,
          countedAgainstCulturalQuota: true,
          registeredAt: new Date('2026-06-15T10:00:00Z'),
          piiPseudonymisedAt: null,
        } as unknown as typeof eventRegistrations.$inferInsert);
      });
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('cultural-only event: relink A→B credit-back + decrement + correct audits + scopes=[cultural]', async () => {
      const result = await runRelinkRegistration(tenant.ctx.slug, {
        registrationId: registrationId as never,
        newMatchedMemberId: memberBId as never,
        // Round-2 code-H1 — eventIdFromPath null skips the path-mismatch
        // check (these tests don't model URL-routing). Phase 9 happy-
        // path + error scenarios verify the use-case logic; the
        // path-mismatch case has its own dedicated test added below.
        eventIdFromPath: null,
        actorUserId: asUserId(userId),
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      if (result.value.noop) return;
      expect(result.value.quotaImpact.creditedBackFor).toBe(memberAId);
      expect(result.value.quotaImpact.decrementedFor).toBe(memberBId);
      expect(result.value.quotaImpact.scopes).toEqual(['cultural']);

      // Row updated: cultural counted=true on B, partnership stays false.
      const rows = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(eq(eventRegistrations.registrationId, registrationId)),
      );
      expect(rows[0]?.matchedMemberId).toBe(memberBId);
      expect(rows[0]?.countedAgainstCulturalQuota).toBe(true);
      expect(rows[0]?.countedAgainstPartnership).toBe(false);

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug));
      const creditBacks = auditRows.filter(
        (r) =>
          String(r.eventType) === 'quota_credit_back_archive' &&
          (r.payload as Record<string, unknown>).registrationId === registrationId,
      );
      expect(creditBacks.length).toBe(1);
      expect((creditBacks[0]!.payload as Record<string, unknown>).scope).toBe(
        'cultural',
      );

      const decrements = auditRows.filter(
        (r) =>
          String(r.eventType) === 'quota_cultural_decremented' &&
          (r.payload as Record<string, unknown>).registrationId === registrationId,
      );
      expect(decrements.length).toBe(1);
      expect((decrements[0]!.payload as Record<string, unknown>).memberId).toBe(
        memberBId,
      );
    });
  });

  // Round-1 test-H4 — covers the over-quota branch on the NEW member
  // (relink-registration.ts:485-496). A regression that flips the
  // over-quota path to emit `_decremented` instead would silently
  // inflate the new member's allotment.
  describe('over-quota on new member (Round-1 test-H4)', () => {
    let tenant: TestTenant;
    let userId: string;
    const corpPlanId = `test-plan-relink-oq-corp-${randomUUID()}`;
    const partnershipPlanId = `test-plan-relink-oq-partner-${randomUUID()}`;
    // Smaller partnership matrix so B can be saturated easily: 1
    // partnership ticket / event.
    const smallPartnershipMatrix: BenefitMatrix = {
      ...DEFAULT_TEST_BENEFIT_MATRIX,
      cultural_tickets_per_year: 0,
      partnership: {
        event_tickets_included: 1,
        booth_included: false,
        rollup_logo_at_events: false,
        logo_on_merch: false,
        video_duration_minutes: 1,
        video_frequency_scope: 'all_events',
        website_logo_months: 0,
        banner_per_year: 0,
        newsletter_promotion: false,
        enewsletter_logo: false,
        directory_ad_position: 'pages_1_and_2',
      },
    };
    const memberAId = randomUUID();
    const memberBId = randomUUID();
    const eventInternalId = randomUUID();
    const regToRelinkId = randomUUID();
    const regAlreadyOnBId = randomUUID();

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      const u = await createActiveTestUser('admin');
      userId = u.userId;
      await runInTenant(tenant.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: corpPlanId,
          planName: { en: 'Corp (oq)' },
          benefitMatrix: premiumMatrix,
          planCategory: 'corporate',
          createdBy: u.userId,
        });
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: partnershipPlanId,
          planName: { en: 'Small Partnership (oq)' },
          benefitMatrix: smallPartnershipMatrix,
          planCategory: 'partnership',
          includesCorporatePlanId: corpPlanId,
          createdBy: u.userId,
        });
        await tx.insert(members).values([
          {
            tenantId: tenant.ctx.slug,
            memberId: memberAId,
            memberNumber: nextSeedMemberNumber(),
            companyName: 'OQ Member A',
            country: 'TH',
            planId: partnershipPlanId,
            planYear: 2026,
            status: 'active',
          },
          {
            tenantId: tenant.ctx.slug,
            memberId: memberBId,
            memberNumber: nextSeedMemberNumber(),
            companyName: 'OQ Member B',
            country: 'TH',
            planId: partnershipPlanId,
            planYear: 2026,
            status: 'active',
          },
        ] as unknown as typeof members.$inferInsert[]);
        const contactAId = randomUUID();
        const contactBId = randomUUID();
        await tx.insert(contacts).values([
          {
            tenantId: tenant.ctx.slug,
            contactId: contactAId,
            memberId: memberAId,
            firstName: 'Alice',
            lastName: 'OQ',
            email: 'alice@oq-a.example',
            isPrimary: true,
          },
          {
            tenantId: tenant.ctx.slug,
            contactId: contactBId,
            memberId: memberBId,
            firstName: 'Bob',
            lastName: 'OQ',
            email: 'bob@oq-b.example',
            isPrimary: true,
          },
        ] as unknown as typeof contacts.$inferInsert[]);
        await tx.insert(events).values({
          tenantId: tenant.ctx.slug,
          eventId: eventInternalId,
          source: 'eventcreate',
          externalId: `event_oq_${Date.now()}`,
          name: 'OQ Event',
          startDate: new Date('2026-06-21T18:00:00+07:00'),
          isPartnerBenefit: true,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
        // Pre-seed: row counted on A (the one we'll relink), AND
        // another row already counted on B (so B's per-event quota = 1
        // is saturated when we try to relink to it).
        await tx.insert(eventRegistrations).values([
          {
            tenantId: tenant.ctx.slug,
            registrationId: regToRelinkId,
            eventId: eventInternalId,
            externalId: `att_oq_a_${Date.now()}`,
            attendeeEmail: 'alice@oq-a.example',
            attendeeName: 'Alice OQ',
            attendeeCompany: 'OQ Member A',
            matchType: 'member_contact',
            matchedMemberId: memberAId,
            matchedContactId: contactAId,
            ticketType: 'Member',
            ticketPriceThb: 0,
            paymentStatus: 'free',
            countedAgainstPartnership: true,
            countedAgainstCulturalQuota: false,
            registeredAt: new Date('2026-06-15T10:00:00Z'),
            piiPseudonymisedAt: null,
          },
          {
            tenantId: tenant.ctx.slug,
            registrationId: regAlreadyOnBId,
            eventId: eventInternalId,
            externalId: `att_oq_b_${Date.now()}`,
            attendeeEmail: 'bob@oq-b.example',
            attendeeName: 'Bob OQ',
            attendeeCompany: 'OQ Member B',
            matchType: 'member_contact',
            matchedMemberId: memberBId,
            matchedContactId: contactBId,
            ticketType: 'Member',
            ticketPriceThb: 0,
            paymentStatus: 'free',
            countedAgainstPartnership: true,
            countedAgainstCulturalQuota: false,
            registeredAt: new Date('2026-06-15T09:00:00Z'),
            piiPseudonymisedAt: null,
          },
        ] as unknown as typeof eventRegistrations.$inferInsert[]);
      });
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('relink A→B when B has no remaining quota: row persists countedAgainstPartnership=false + emits over_quota_warning (NOT decremented) + macro decrementedFor=null', async () => {
      const result = await runRelinkRegistration(tenant.ctx.slug, {
        registrationId: regToRelinkId as never,
        newMatchedMemberId: memberBId as never,
        // Round-2 code-H1 — eventIdFromPath null skips the path-mismatch
        // check (these tests don't model URL-routing). Phase 9 happy-
        // path + error scenarios verify the use-case logic; the
        // path-mismatch case has its own dedicated test added below.
        eventIdFromPath: null,
        actorUserId: asUserId(userId),
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      if (result.value.noop) return;
      // Credit-back still happened on A (was counted=true); decrement
      // NOT applied to B (over quota); decrementedFor must be null.
      expect(result.value.quotaImpact.creditedBackFor).toBe(memberAId);
      expect(result.value.quotaImpact.decrementedFor).toBeNull();
      // Scopes only includes partnership because A had a credit-back
      // change (B had no change — over_quota path leaves flag=false).
      expect(result.value.quotaImpact.scopes).toEqual(['partnership']);

      // Row matched_member_id = B, counted=false (over-quota persisted).
      const rows = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(eq(eventRegistrations.registrationId, regToRelinkId)),
      );
      expect(rows[0]?.matchedMemberId).toBe(memberBId);
      expect(rows[0]?.countedAgainstPartnership).toBe(false);

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug));
      // No `_decremented` for this registration on B.
      const decrementsForThisReg = auditRows.filter(
        (r) =>
          String(r.eventType) === 'quota_partnership_decremented' &&
          (r.payload as Record<string, unknown>).registrationId === regToRelinkId,
      );
      expect(decrementsForThisReg.length).toBe(0);
      // ONE over-quota warning for this registration on B.
      const overQuotaForThisReg = auditRows.filter(
        (r) =>
          String(r.eventType) === 'quota_over_quota_warning' &&
          (r.payload as Record<string, unknown>).registrationId === regToRelinkId,
      );
      expect(overQuotaForThisReg.length).toBe(1);
      expect(
        (overQuotaForThisReg[0]!.payload as Record<string, unknown>).memberId,
      ).toBe(memberBId);

      // Round-2 test-K closure — also assert the MACRO
      // `registration_relinked` audit's `quotaImpact.decrementedFor`
      // is null. Round-1 H4's stated regression was "over-quota flips
      // to decremented"; verifying ONLY the return value left a gap
      // where the macro payload could drift independently. Now both
      // the return AND the persisted audit row are pinned.
      const macroForThisReg = auditRows.filter(
        (r) =>
          String(r.eventType) === 'registration_relinked' &&
          (r.payload as Record<string, unknown>).registrationId === regToRelinkId,
      );
      expect(macroForThisReg.length).toBe(1);
      const macroPayload = macroForThisReg[0]!.payload as Record<string, unknown>;
      const macroQuotaImpact = macroPayload.quotaImpact as Record<string, unknown>;
      expect(macroQuotaImpact.decrementedFor).toBeNull();
      expect(macroQuotaImpact.creditedBackFor).toBe(memberAId);
    });
  });

  // Round-1 test-H2 — DB-layer pseudonymised guard test. The
  // Application pre-check has its own scenario; this verifies the
  // adapter's `WHERE pii_pseudonymised_at IS NULL` + probe-discriminator
  // independently. A regression that moves the Application pre-check
  // after the UPDATE (or that drops it entirely) would still surface
  // `pseudonymised_row_rejected` through this DB-layer path.
  describe('updateMatchAndQuota DB-layer pseudonymised guard (Round-1 test-H2)', () => {
    let tenant: TestTenant;
    const memberId = randomUUID();
    const eventInternalId = randomUUID();
    const regId = randomUUID();
    const corpPlanId = `test-plan-relink-dbguard-corp-${randomUUID()}`;
    const partnershipPlanId = `test-plan-relink-dbguard-partner-${randomUUID()}`;

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      const u = await createActiveTestUser('admin');
      await runInTenant(tenant.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: corpPlanId,
          planName: { en: 'Corp (dbguard)' },
          benefitMatrix: premiumMatrix,
          planCategory: 'corporate',
          createdBy: u.userId,
        });
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: partnershipPlanId,
          planName: { en: 'Diamond (dbguard)' },
          benefitMatrix: diamondMatrix,
          planCategory: 'partnership',
          includesCorporatePlanId: corpPlanId,
          createdBy: u.userId,
        });
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'DB-Guard Member',
          country: 'TH',
          planId: partnershipPlanId,
          planYear: 2026,
          status: 'active',
        } as unknown as typeof members.$inferInsert);
        await tx.insert(events).values({
          tenantId: tenant.ctx.slug,
          eventId: eventInternalId,
          source: 'eventcreate',
          externalId: `event_dbguard_${Date.now()}`,
          name: 'DB-Guard Event',
          startDate: new Date('2026-06-21T18:00:00+07:00'),
          isPartnerBenefit: true,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
        await tx.insert(eventRegistrations).values({
          tenantId: tenant.ctx.slug,
          registrationId: regId,
          eventId: eventInternalId,
          externalId: `att_dbguard_${Date.now()}`,
          attendeeEmail: 'pseudo@dbguard.example',
          attendeeName: 'pseudo',
          attendeeCompany: 'pseudo',
          matchType: 'non_member',
          matchedMemberId: null,
          matchedContactId: null,
          ticketType: 'Standard',
          ticketPriceThb: 50000,
          paymentStatus: 'paid',
          countedAgainstPartnership: false,
          countedAgainstCulturalQuota: false,
          registeredAt: new Date('2024-04-01T10:00:00Z'),
          piiPseudonymisedAt: new Date('2026-04-01T10:00:00Z'),
        } as unknown as typeof eventRegistrations.$inferInsert);
      });
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('repo.updateMatchAndQuota returns pseudonymised_row_rejected discriminator on a pseudonymised row (defence-in-depth)', async () => {
      // Call the adapter directly — bypasses the Application
      // pre-check at relink-registration.ts:261-266 so we exercise
      // ONLY the DB-layer guard.
      const { makeDrizzleRegistrationsRepository } = await import(
        '@/modules/events/infrastructure/drizzle-registrations-repository'
      );
      const result = await runInTenant(tenant.ctx, async (tx) => {
        const repo = makeDrizzleRegistrationsRepository(tx);
        return repo.updateMatchAndQuota(
          tenant.ctx.slug as never,
          regId as never,
          {
            type: 'member_contact',
            matchedMemberId: memberId as never,
            matchedContactId: null,
          },
          {
            countedAgainstPartnership: false,
            countedAgainstCulturalQuota: false,
          },
        );
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('pseudonymised_row_rejected');

      // Row state unchanged.
      const rows = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(eq(eventRegistrations.registrationId, regId)),
      );
      expect(rows[0]?.matchType).toBe('non_member');
      expect(rows[0]?.matchedMemberId).toBeNull();
      expect(rows[0]?.piiPseudonymisedAt).not.toBeNull();
    });
  });

  // Round-2 code-H1 closure (integration coverage) — verifies the
  // path-mismatch guard fires BEFORE any mutation. Test seeds 2
  // events; calls runRelinkRegistration with the registration of
  // event A but `eventIdFromPath` of event B → asserts
  // event_path_mismatch + zero audit/row change.
  describe('event_path_mismatch (Round-2 code-H1)', () => {
    let tenant: TestTenant;
    let userId: string;
    const memberId = randomUUID();
    const otherMemberId = randomUUID();
    const eventAId = randomUUID();
    const eventBId = randomUUID();
    const regId = randomUUID();
    const corpPlanId = `test-plan-relink-pm-corp-${randomUUID()}`;
    const partnershipPlanId = `test-plan-relink-pm-partner-${randomUUID()}`;

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      const u = await createActiveTestUser('admin');
      userId = u.userId;
      await runInTenant(tenant.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: corpPlanId,
          planName: { en: 'Corp (path-mismatch)' },
          benefitMatrix: premiumMatrix,
          planCategory: 'corporate',
          createdBy: u.userId,
        });
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: partnershipPlanId,
          planName: { en: 'Diamond (path-mismatch)' },
          benefitMatrix: diamondMatrix,
          planCategory: 'partnership',
          includesCorporatePlanId: corpPlanId,
          createdBy: u.userId,
        });
        await tx.insert(members).values([
          {
            tenantId: tenant.ctx.slug,
            memberId,
            memberNumber: nextSeedMemberNumber(),
            companyName: 'PM Member A',
            country: 'TH',
            planId: partnershipPlanId,
            planYear: 2026,
            status: 'active',
          },
          {
            tenantId: tenant.ctx.slug,
            memberId: otherMemberId,
            memberNumber: nextSeedMemberNumber(),
            companyName: 'PM Member B',
            country: 'TH',
            planId: partnershipPlanId,
            planYear: 2026,
            status: 'active',
          },
        ] as unknown as typeof members.$inferInsert[]);
        const contactId = randomUUID();
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId,
          memberId,
          firstName: 'PM',
          lastName: 'Member',
          email: 'pm@member.example',
          isPrimary: true,
        } as unknown as typeof contacts.$inferInsert);
        // Two events — registration belongs to A, attacker passes B
        // as eventIdFromPath.
        await tx.insert(events).values([
          {
            tenantId: tenant.ctx.slug,
            eventId: eventAId,
            source: 'eventcreate',
            externalId: `event_pm_a_${Date.now()}`,
            name: 'PM Event A (real)',
            startDate: new Date('2026-06-21T18:00:00+07:00'),
            isPartnerBenefit: true,
            isCulturalEvent: false,
          },
          {
            tenantId: tenant.ctx.slug,
            eventId: eventBId,
            source: 'eventcreate',
            externalId: `event_pm_b_${Date.now()}`,
            name: 'PM Event B (URL says this one)',
            startDate: new Date('2026-07-21T18:00:00+07:00'),
            isPartnerBenefit: true,
            isCulturalEvent: false,
          },
        ] as unknown as typeof events.$inferInsert[]);
        await tx.insert(eventRegistrations).values({
          tenantId: tenant.ctx.slug,
          registrationId: regId,
          eventId: eventAId,
          externalId: `att_pm_${Date.now()}`,
          attendeeEmail: 'pm@member.example',
          attendeeName: 'PM Attendee',
          attendeeCompany: 'PM Member A',
          matchType: 'member_contact',
          matchedMemberId: memberId,
          matchedContactId: contactId,
          ticketType: 'Member',
          ticketPriceThb: 0,
          paymentStatus: 'free',
          countedAgainstPartnership: true,
          countedAgainstCulturalQuota: false,
          registeredAt: new Date('2026-06-15T10:00:00Z'),
          piiPseudonymisedAt: null,
        } as unknown as typeof eventRegistrations.$inferInsert);
      });
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('URL eventId (B) ≠ registration.eventId (A) → event_path_mismatch + zero mutation + zero audit', async () => {
      const auditsBefore = (
        await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.tenantId, tenant.ctx.slug))
      ).length;

      const result = await runRelinkRegistration(tenant.ctx.slug, {
        registrationId: regId as never,
        newMatchedMemberId: otherMemberId as never,
        eventIdFromPath: eventBId as never, // attacker / client bug
        actorUserId: asUserId(userId),
        occurredAt: new Date(),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('event_path_mismatch');
      if (result.error.kind === 'event_path_mismatch') {
        expect(result.error.eventIdInPath).toBe(eventBId);
        expect(result.error.eventIdOnRegistration).toBe(eventAId);
      }

      // Zero audit row delta (use-case returned BEFORE any emit).
      const auditsAfter = (
        await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.tenantId, tenant.ctx.slug))
      ).length;
      expect(auditsAfter).toBe(auditsBefore);

      // Row state UNCHANGED — matched_member_id still memberId (A),
      // counted still true. This is the core invariant the Round-1
      // code-M1 fix violated by allowing the relink to commit
      // server-side before the post-commit check refused the response.
      const rows = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(eq(eventRegistrations.registrationId, regId)),
      );
      expect(rows[0]?.matchedMemberId).toBe(memberId);
      expect(rows[0]?.countedAgainstPartnership).toBe(true);
    });
  });

  /**
   * Staff-review R-S01 (review-20260516-155013.md) — converts the
   * mathematical proof of step-4b's deadlock-safe sorted-key lock
   * acquisition into a regression-protected integration assertion.
   *
   * Scenario: two registrations R1 + R2 on the same event, R1 initially
   * counted against Member A, R2 initially counted against Member B.
   * Concurrently fire `runRelinkRegistration(R1: A→B)` and
   * `runRelinkRegistration(R2: B→A)`. Each relink touches BOTH members'
   * advisory locks. Without sorted-key acquisition, thread1 would hold
   * A's lock waiting for B's, while thread2 would hold B's waiting for
   * A's — a classic A→B vs B→A deadlock. With sorted-key acquisition
   * (step 4b), both threads queue on the lexicographically-smaller key
   * FIRST, so one fully completes its critical section before the
   * other starts → both commits land deterministically with no
   * deadlock.
   *
   * Assertion shape:
   *   - Both `Promise.all` results are `Result.ok` (no lock failure /
   *     timeout / deadlock-rollback errors surface).
   *   - Final DB state: R1.matched=B + counted=true; R2.matched=A +
   *     counted=true (a clean swap).
   *   - Both registrations show the macro `registration_relinked`
   *     audit row.
   *   - Test completes well under the per-call advisory-lock timeout
   *     (Postgres' default `lock_timeout` is unlimited unless we set
   *     it; the suite-level vitest timeout is 30s — passing in <5s
   *     is comfortably outside any pathological deadlock window).
   *
   * If a future refactor accidentally reverts the sorted-key ordering
   * (e.g., acquires OLD before NEW without sorting), this test would
   * fail with a Postgres `40P01 deadlock_detected` error OR hang past
   * the vitest timeout.
   */
  describe('concurrent A→B + B→A relink (deadlock-safe sorted-key acquisition)', () => {
    let tenant: TestTenant;
    let userId: string;
    const corpPlanId = `test-plan-concurrent-corp-${randomUUID()}`;
    const partnershipPlanId = `test-plan-concurrent-partner-${randomUUID()}`;
    const memberAId = randomUUID();
    const memberBId = randomUUID();
    const eventInternalId = randomUUID();
    const reg1Id = randomUUID();
    const reg2Id = randomUUID();
    let contactAId: string;
    let contactBId: string;

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      const u = await createActiveTestUser('admin');
      userId = u.userId;
      contactAId = randomUUID();
      contactBId = randomUUID();
      await runInTenant(tenant.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: corpPlanId,
          planName: { en: 'Corp Bundle (concurrent)' },
          benefitMatrix: premiumMatrix,
          planCategory: 'corporate',
          createdBy: u.userId,
        });
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: partnershipPlanId,
          planName: { en: 'Diamond Partnership (concurrent)' },
          benefitMatrix: diamondMatrix,
          planCategory: 'partnership',
          includesCorporatePlanId: corpPlanId,
          createdBy: u.userId,
        });
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId: memberAId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Concurrent A Co',
          country: 'TH',
          planId: partnershipPlanId,
          planYear: 2026,
          status: 'active',
        } as unknown as typeof members.$inferInsert);
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId: contactAId,
          memberId: memberAId,
          firstName: 'Alice',
          lastName: 'Concurrent',
          email: 'alice@concurrent-a.example',
          isPrimary: true,
        } as unknown as typeof contacts.$inferInsert);
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId: memberBId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Concurrent B Co',
          country: 'TH',
          planId: partnershipPlanId,
          planYear: 2026,
          status: 'active',
        } as unknown as typeof members.$inferInsert);
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId: contactBId,
          memberId: memberBId,
          firstName: 'Bob',
          lastName: 'Concurrent',
          email: 'bob@concurrent-b.example',
          isPrimary: true,
        } as unknown as typeof contacts.$inferInsert);
        await tx.insert(tenantWebhookConfigs).values({
          tenantId: tenant.ctx.slug,
          source: 'eventcreate',
          webhookSecretActive: 'test-secret-' + 'c'.repeat(43),
          enabled: true,
        });
        await tx.insert(events).values({
          tenantId: tenant.ctx.slug,
          eventId: eventInternalId,
          source: 'eventcreate',
          externalId: `event_concurrent_${Date.now()}`,
          name: 'Concurrent Relink Event',
          startDate: new Date('2026-08-15T18:00:00+07:00'),
          isPartnerBenefit: true,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
        // R1: counted against A
        await tx.insert(eventRegistrations).values({
          tenantId: tenant.ctx.slug,
          registrationId: reg1Id,
          eventId: eventInternalId,
          externalId: `att_concurrent_1_${Date.now()}`,
          attendeeEmail: 'attendee1@concurrent.example',
          attendeeName: 'Attendee 1',
          attendeeCompany: 'Concurrent A Co',
          matchType: 'member_contact',
          matchedMemberId: memberAId,
          matchedContactId: contactAId,
          ticketType: null,
          ticketPriceThb: null,
          paymentStatus: 'paid',
          countedAgainstPartnership: true,
          countedAgainstCulturalQuota: false,
          registeredAt: new Date(),
          piiPseudonymisedAt: null,
        } as unknown as typeof eventRegistrations.$inferInsert);
        // R2: counted against B
        await tx.insert(eventRegistrations).values({
          tenantId: tenant.ctx.slug,
          registrationId: reg2Id,
          eventId: eventInternalId,
          externalId: `att_concurrent_2_${Date.now()}`,
          attendeeEmail: 'attendee2@concurrent.example',
          attendeeName: 'Attendee 2',
          attendeeCompany: 'Concurrent B Co',
          matchType: 'member_contact',
          matchedMemberId: memberBId,
          matchedContactId: contactBId,
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
      await tenant.cleanup();
    });

    it('R1 (A→B) + R2 (B→A) fired concurrently both succeed without deadlock; final state is a clean member swap', async () => {
      const t0 = Date.now();
      const [resA, resB] = await Promise.all([
        runRelinkRegistration(tenant.ctx.slug, {
          registrationId: reg1Id as never,
          newMatchedMemberId: memberBId as never,
          eventIdFromPath: null,
          actorUserId: asUserId(userId),
          occurredAt: new Date(),
        }),
        runRelinkRegistration(tenant.ctx.slug, {
          registrationId: reg2Id as never,
          newMatchedMemberId: memberAId as never,
          eventIdFromPath: null,
          actorUserId: asUserId(userId),
          occurredAt: new Date(),
        }),
      ]);
      const elapsed = Date.now() - t0;

      // Both succeed — no `lock_acquisition_failed`, no Postgres
      // `40P01 deadlock_detected` escaping as a `registrations_repo_error`.
      expect(resA.ok).toBe(true);
      expect(resB.ok).toBe(true);

      // Completes in well under a deadlock-detector window. Postgres'
      // default `deadlock_timeout` is 1s, after which one tx is killed
      // — if either thread waited that long, the test would have
      // observed it. We bound at 10s to allow slack for cross-region
      // Neon latency without being permissive of pathological cases.
      expect(elapsed).toBeLessThan(10_000);

      // Final state: clean swap. R1 → B, R2 → A; both still counted.
      const rows = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.tenantId, tenant.ctx.slug),
              eq(eventRegistrations.eventId, eventInternalId),
            ),
          )
          .orderBy(eventRegistrations.registrationId),
      );
      const r1 = rows.find((r) => r.registrationId === reg1Id)!;
      const r2 = rows.find((r) => r.registrationId === reg2Id)!;
      expect(r1.matchedMemberId).toBe(memberBId);
      expect(r1.matchType).toBe('member_contact');
      expect(r1.countedAgainstPartnership).toBe(true);
      expect(r2.matchedMemberId).toBe(memberAId);
      expect(r2.matchType).toBe('member_contact');
      expect(r2.countedAgainstPartnership).toBe(true);

      // Each relink emitted its own macro audit — total 2. Filter the
      // enum-typed eventType in JS rather than SQL because the
      // pg-enum union in Drizzle-inferred types is open-ended (F8
      // added many event types after F6 spec was drafted); the
      // happy-path test above uses the same `String(...)` pattern.
      const macroAudits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug));
      const concurrentMacros = macroAudits.filter((r) => {
        if (String(r.eventType) !== 'registration_relinked') return false;
        const p = r.payload as Record<string, unknown>;
        return p.registrationId === reg1Id || p.registrationId === reg2Id;
      });
      expect(concurrentMacros.length).toBe(2);
    });
  });

  /**
   * Constitution v1.4.0 Principle I (NON-NEG) Review-Gate blocker.
   * Mirrors archive-event.test.ts WARN-3 strengthening — verify both
   * the SELECT gate (registration_not_found) AND the post-probe state
   * (Tenant B's row's matched_member_id is unchanged) so an inverted
   * RLS bug that blocks the SELECT but allows the UPDATE would also
   * surface here.
   */
  describe('cross-tenant isolation (Principle I Review-Gate)', () => {
    let tenantA: TestTenant;
    let tenantB: TestTenant;
    let userA: string;
    const tenantBEventId = randomUUID();
    const tenantBMemberId = randomUUID();
    const tenantBRegistrationId = randomUUID();
    const tenantBContactId = randomUUID();
    const tenantBPlanId = `tenantB-plan-${randomUUID().slice(0, 8)}`;

    beforeAll(async () => {
      tenantA = await createTestTenant('test-swecham');
      tenantB = await createTestTenant('test-chamber');
      const u = await createActiveTestUser('admin');
      userA = u.userId;
      await runInTenant(tenantB.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenantB.ctx.slug,
          planId: tenantBPlanId,
          planName: { en: 'TenantB Corp (relink probe)' },
          benefitMatrix: premiumMatrix,
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
        await tx.insert(contacts).values({
          tenantId: tenantB.ctx.slug,
          contactId: tenantBContactId,
          memberId: tenantBMemberId,
          firstName: 'TenantB',
          lastName: 'Owner',
          email: 'owner@tenant-b.example',
          isPrimary: true,
        } as unknown as typeof contacts.$inferInsert);
        await tx.insert(events).values({
          tenantId: tenantB.ctx.slug,
          eventId: tenantBEventId,
          source: 'eventcreate',
          externalId: `event_tenantB_relink_${Date.now()}`,
          name: 'TenantB Event (must remain untouched)',
          startDate: new Date('2026-09-15T18:00:00+07:00'),
          isPartnerBenefit: true,
          isCulturalEvent: false,
        } as unknown as typeof events.$inferInsert);
        await tx.insert(eventRegistrations).values({
          tenantId: tenantB.ctx.slug,
          registrationId: tenantBRegistrationId,
          eventId: tenantBEventId,
          externalId: `att_tenantB_relink_${Date.now()}`,
          attendeeEmail: 'attendee@tenant-b.example',
          attendeeName: 'TenantB Attendee',
          attendeeCompany: 'TenantB Co',
          matchType: 'member_contact',
          matchedMemberId: tenantBMemberId,
          matchedContactId: tenantBContactId,
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

    it('Tenant A actor cannot relink Tenant B registration (registration_not_found via RLS) + Tenant B row unchanged', async () => {
      const ghostMember = randomUUID();
      const result = await runRelinkRegistration(tenantA.ctx.slug, {
        registrationId: tenantBRegistrationId as never,
        newMatchedMemberId: ghostMember as never,
        eventIdFromPath: null,
        actorUserId: asUserId(userA),
        occurredAt: new Date(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('registration_not_found');

      // Tenant B's registration row's matched_member_id is unchanged
      // — proves the UPDATE path did NOT reach across tenants even if
      // SELECT-side RLS were somehow bypassed.
      const tenantBRow = await runInTenant(tenantB.ctx, async (tx) =>
        tx
          .select({
            matchedMemberId: eventRegistrations.matchedMemberId,
            matchedContactId: eventRegistrations.matchedContactId,
            matchType: eventRegistrations.matchType,
          })
          .from(eventRegistrations)
          .where(eq(eventRegistrations.registrationId, tenantBRegistrationId))
          .limit(1),
      );
      expect(tenantBRow[0]?.matchedMemberId).toBe(tenantBMemberId);
      expect(tenantBRow[0]?.matchedContactId).toBe(tenantBContactId);
      expect(tenantBRow[0]?.matchType).toBe('member_contact');
    });
  });
});

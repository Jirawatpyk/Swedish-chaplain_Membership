/**
 * F6 Phase 10 T117 — retention-sweep integration test (live Neon Singapore).
 *
 * Verifies FR-032 end-to-end via the `pseudonymiseStaleNonMemberPii`
 * use-case wired through the cron route's composition root pattern:
 *   1. Seed non-member registrations at varying ages (some > 2y, some
 *      < 2y); seed a member-linked registration > 2y old as control.
 *   2. Run the sweep with a `cutoff` clamped to "2 years ago from
 *      occurredAt".
 *   3. Assert:
 *      - Eligible rows (non_member + unmatched, > 2y) → PII replaced
 *        with sha256:* hashes + pii_pseudonymised_at stamped
 *      - Member-linked row (control) → UNTOUCHED (matchType filter)
 *      - Rows < 2y old → UNTOUCHED (cutoff filter)
 *      - Per-row pii_pseudonymised audit + macro
 *        pii_pseudonymisation_sweep_run audit emitted
 *   4. Idempotency: re-run sweep → zero new pseudonymisations, zero
 *      new pii_pseudonymised audits (only macro re-emits).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant, db } from '@/lib/db';
import {
  events,
  eventRegistrations,
} from '@/modules/events/infrastructure/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { pseudonymiseStaleNonMemberPii } from '@/modules/events';
import { makeDrizzleRegistrationsRepository } from '@/modules/events/infrastructure/drizzle-registrations-repository';
import { makePinoAuditPort } from '@/modules/events/infrastructure/pino-audit-port';
import { asTenantId } from '@/modules/members';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createActiveTestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

function makeTestHasher() {
  return {
    hash(input: string): string {
      // Deterministic non-crypto for tests — just enough variety per input.
      let h = 0;
      for (let i = 0; i < input.length; i++) {
        h = ((h << 5) - h + input.charCodeAt(i)) | 0;
      }
      return `h${(h >>> 0).toString(36)}`;
    },
  };
}

describe('F6 Phase 10 T117 — pseudonymiseStaleNonMemberPii (FR-032)', () => {
  let tenant: TestTenant;
  let memberId: string;
  let eventId: string;
  let staleNonMemberRegId: string;
  let staleUnmatchedRegId: string;
  let freshNonMemberRegId: string;
  let staleMemberRegId: string; // control — must NOT pseudonymise

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    const user = await createActiveTestUser('admin');
    const planId = `test-plan-sweep-${randomUUID()}`;
    memberId = randomUUID();
    eventId = randomUUID();
    staleNonMemberRegId = randomUUID();
    staleUnmatchedRegId = randomUUID();
    freshNonMemberRegId = randomUUID();
    staleMemberRegId = randomUUID();
    const twoYearsAndOneDayAgo = new Date(
      Date.now() - (730 + 1) * 24 * 60 * 60 * 1000,
    );
    const oneYearAgo = new Date(
      Date.now() - 365 * 24 * 60 * 60 * 1000,
    );

    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Sweep Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        planCategory: 'corporate',
        createdBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: 'Sweep Member Co',
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active',
      } as unknown as typeof members.$inferInsert);
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: `sweep-event-${Date.now()}`,
        name: 'Sweep Test Event',
        startDate: twoYearsAndOneDayAgo,
        isPartnerBenefit: false,
        isCulturalEvent: false,
      } as unknown as typeof events.$inferInsert);
      await tx.insert(eventRegistrations).values([
        {
          tenantId: tenant.ctx.slug,
          registrationId: staleNonMemberRegId,
          eventId,
          source: 'eventcreate',
          externalId: `stale-nm-${Date.now()}`,
          attendeeEmail: 'stale-nm@example.com',
          attendeeName: 'Stale NonMember',
          attendeeCompany: 'Stale Co',
          matchType: 'non_member',
          matchedMemberId: null,
          paymentStatus: 'paid',
          ticketType: 'standard',
          countedAgainstPartnership: false,
          countedAgainstCulturalQuota: false,
          metadata: {},
          registeredAt: twoYearsAndOneDayAgo,
          piiPseudonymisedAt: null,
        },
        {
          tenantId: tenant.ctx.slug,
          registrationId: staleUnmatchedRegId,
          eventId,
          source: 'eventcreate',
          externalId: `stale-um-${Date.now()}`,
          attendeeEmail: 'stale-um@example.com',
          attendeeName: 'Stale Unmatched',
          attendeeCompany: null,
          matchType: 'unmatched',
          matchedMemberId: null,
          paymentStatus: 'paid',
          ticketType: 'standard',
          countedAgainstPartnership: false,
          countedAgainstCulturalQuota: false,
          metadata: {},
          registeredAt: twoYearsAndOneDayAgo,
          piiPseudonymisedAt: null,
        },
        {
          tenantId: tenant.ctx.slug,
          registrationId: freshNonMemberRegId,
          eventId,
          source: 'eventcreate',
          externalId: `fresh-nm-${Date.now()}`,
          attendeeEmail: 'fresh-nm@example.com',
          attendeeName: 'Fresh NonMember',
          attendeeCompany: 'Fresh Co',
          matchType: 'non_member',
          matchedMemberId: null,
          paymentStatus: 'paid',
          ticketType: 'standard',
          countedAgainstPartnership: false,
          countedAgainstCulturalQuota: false,
          metadata: {},
          registeredAt: oneYearAgo,
          piiPseudonymisedAt: null,
        },
        {
          tenantId: tenant.ctx.slug,
          registrationId: staleMemberRegId,
          eventId,
          source: 'eventcreate',
          externalId: `stale-m-${Date.now()}`,
          attendeeEmail: 'stale-m@example.com',
          attendeeName: 'Stale Member',
          attendeeCompany: 'Sweep Member Co',
          matchType: 'member_contact',
          matchedMemberId: memberId,
          paymentStatus: 'paid',
          ticketType: 'standard',
          countedAgainstPartnership: false,
          countedAgainstCulturalQuota: false,
          metadata: {},
          registeredAt: twoYearsAndOneDayAgo,
          piiPseudonymisedAt: null,
        },
      ] as unknown as Array<typeof eventRegistrations.$inferInsert>);
    });
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('sweep pseudonymises stale non_member + unmatched; leaves fresh + member-linked untouched', async () => {
    const occurredAt = new Date();
    const result = await runInTenant(tenant.ctx, async (tx) => {
      return pseudonymiseStaleNonMemberPii(
        { tenantId: asTenantId(tenant.ctx.slug), occurredAt },
        {
          registrationsRepo: makeDrizzleRegistrationsRepository(tx),
          audit: makePinoAuditPort(tx),
          hasher: makeTestHasher(),
        },
      );
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rowsScanned).toBe(2);
      expect(result.value.rowsPseudonymised).toBe(2);
    }

    // Verify stale non-member row was pseudonymised
    const staleNm = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(eventRegistrations)
        .where(eq(eventRegistrations.registrationId, staleNonMemberRegId)),
    );
    expect(staleNm[0]!.attendeeEmail).toMatch(/^sha256:/);
    expect(staleNm[0]!.piiPseudonymisedAt).not.toBeNull();

    // Stale unmatched also pseudonymised
    const staleUm = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(eventRegistrations)
        .where(eq(eventRegistrations.registrationId, staleUnmatchedRegId)),
    );
    expect(staleUm[0]!.attendeeEmail).toMatch(/^sha256:/);

    // Fresh non-member NOT pseudonymised (cutoff filter)
    const freshNm = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(eventRegistrations)
        .where(eq(eventRegistrations.registrationId, freshNonMemberRegId)),
    );
    expect(freshNm[0]!.attendeeEmail).toBe('fresh-nm@example.com');
    expect(freshNm[0]!.piiPseudonymisedAt).toBeNull();

    // Member-linked NOT pseudonymised (matchType filter)
    const staleM = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(eventRegistrations)
        .where(eq(eventRegistrations.registrationId, staleMemberRegId)),
    );
    expect(staleM[0]!.attendeeEmail).toBe('stale-m@example.com');
    expect(staleM[0]!.piiPseudonymisedAt).toBeNull();

    // Audit emissions
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug));
    const perRow = audits.filter(
      (a) => String(a.eventType) === 'pii_pseudonymised',
    );
    expect(perRow.length).toBe(2);

    const macro = audits.filter(
      (a) => String(a.eventType) === 'pii_pseudonymisation_sweep_run',
    );
    expect(macro.length).toBe(1);
    const macroPayload = macro[0]!.payload as Record<string, unknown>;
    expect(macroPayload.rowsScanned).toBe(2);
    expect(macroPayload.rowsPseudonymised).toBe(2);
  });

  it('idempotent re-run: zero new pseudonymisations, only macro audit re-emits', async () => {
    const auditsBefore = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug));
    const perRowBefore = auditsBefore.filter(
      (a) => String(a.eventType) === 'pii_pseudonymised',
    ).length;
    const macroBefore = auditsBefore.filter(
      (a) => String(a.eventType) === 'pii_pseudonymisation_sweep_run',
    ).length;

    const result = await runInTenant(tenant.ctx, async (tx) => {
      return pseudonymiseStaleNonMemberPii(
        {
          tenantId: asTenantId(tenant.ctx.slug),
          occurredAt: new Date(),
        },
        {
          registrationsRepo: makeDrizzleRegistrationsRepository(tx),
          audit: makePinoAuditPort(tx),
          hasher: makeTestHasher(),
        },
      );
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Stale rows already pseudonymised → scan returns 0 eligible
      expect(result.value.rowsScanned).toBe(0);
      expect(result.value.rowsPseudonymised).toBe(0);
    }

    const auditsAfter = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug));
    const perRowAfter = auditsAfter.filter(
      (a) => String(a.eventType) === 'pii_pseudonymised',
    ).length;
    const macroAfter = auditsAfter.filter(
      (a) => String(a.eventType) === 'pii_pseudonymisation_sweep_run',
    ).length;

    expect(perRowAfter).toBe(perRowBefore); // unchanged
    expect(macroAfter).toBe(macroBefore + 1); // macro emits per run
  });
});

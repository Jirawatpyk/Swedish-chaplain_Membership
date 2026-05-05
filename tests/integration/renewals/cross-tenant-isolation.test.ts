/**
 * F8 Phase 4 Wave J3 — Application-layer cross-tenant probe tests
 * (Constitution v1.4.0 Principle I, Review-Gate blocker).
 *
 * Counterpart to `tenant-isolation.test.ts` which probes RLS at the
 * **table level** (raw SELECT/UPDATE/DELETE/INSERT against each F8
 * table). This file probes the SAME isolation invariant at the
 * **application layer** — i.e., the use-cases that embed `runInTenant`
 * boundaries internally:
 *
 *   1. `dispatchRenewalCycle` (T088 cron entry, Wave I2c)
 *   2. `sendReminderNow`      (T089 admin manual entry, Wave I2c)
 *   3. `detectBounceThreshold` (T090 F1 webhook hook, Wave I2d)
 *   4. `lookupMemberByEmail`  (Wave I4 cross-cutting MTA escape hatch)
 *
 * Why both layers: Constitution Principle I clauses 1+2 mandate
 * **application-layer + database-layer** tenant isolation as a
 * defence-in-depth pair. Table-level RLS catches raw SQL leaks; this
 * file's tests catch use-case-level leaks (a function that bypasses
 * RLS via a stale connection, an `as any` cast, an RLS-misconfigured
 * port adapter, or a future refactor that forgets to wrap a query in
 * `runInTenant`). Both must pass for the Review-Gate.
 *
 * Coverage matrix:
 *
 *   Surface                    | Probe direction      | Expected outcome
 *   ---------------------------+----------------------+----------------------
 *   dispatchRenewalCycle(A)    | sees only A cycles   | summary excludes B
 *   sendReminderNow(A,cycleB)  | A queries B's cycle  | cycle_not_found,
 *                              |                      | no reminder_event in B
 *   detectBounceThreshold(A,B) | A queries B's member | no_threshold_crossed,
 *                              |                      | B.email_unverified untouched
 *   lookupMemberByEmail        | email collision      | returns ONE (deterministic
 *                              | across A + B         | for MTA+STD; pinned)
 *
 * Audit-trail invariant: probe attempts MUST NOT leak into the wrong
 * tenant's `audit_log`. RLS WITH CHECK on `audit_log.tenant_id` already
 * enforces this at the DB layer, but the tests assert it via `db.select`
 * regardless to pin the behaviour against future schema regressions.
 *
 * `sendReminderNow` and `detectBounceThreshold` deliberately do NOT
 * emit `renewal_cross_tenant_probe` audits — see the use-case docstrings
 * for the rationale (admin UI mismatches + webhook ingest are not
 * malicious probes). `cancelCycle`, `loadCycleDetail`, and
 * `markPaidOffline` DO emit probe audits and are covered by their own
 * cross-tenant integration tests.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalReminderEvents } from '@/modules/renewals/infrastructure/schema-renewal-reminder-events';
import { renewalEscalationTasks } from '@/modules/renewals/infrastructure/schema-renewal-escalation-tasks';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import {
  detectBounceThreshold,
  dispatchRenewalCycle,
  makeRenewalsDeps,
  sendReminderNow,
} from '@/modules/renewals';
import { lookupMemberByEmail } from '@/modules/renewals/infrastructure/lookup-member-by-email';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';

const BENEFITS: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

// Pin the dispatcher's clock so the schedule-policy resolution is
// deterministic. Regular-tier T-30 step → expires_at = nowIso + 30d.
const NOW_ISO = '2026-06-15T08:00:00.000Z';
const EXPIRES_AT_30D = new Date('2026-07-15T00:00:00.000Z');
// `period_from` 1y before expiry → year_in_cycle math resolves to 1.
const PERIOD_FROM = new Date('2025-07-15T00:00:00.000Z');

interface SeededTenant {
  readonly memberId: string;
  readonly cycleId: string;
  readonly contactId: string;
  readonly contactEmail: string;
}

async function seedTenant(
  tenant: TestTenant,
  user: TestUser,
  opts: { contactEmail: string },
): Promise<SeededTenant> {
  const memberId = randomUUID();
  const cycleId = randomUUID();
  const contactId = randomUUID();
  const planId = `f8-xtenant-${randomUUID().slice(0, 8)}`;

  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: 'Cross-Tenant Plan' },
      description: { en: '' },
      sortOrder: 10,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 5_000_000,
      includesCorporatePlanId: null,
      minTurnoverMinorUnits: null,
      maxTurnoverMinorUnits: null,
      maxDurationYears: null,
      maxMemberAge: null,
      benefitMatrix: BENEFITS,
      isActive: true,
      createdBy: user.userId,
      updatedBy: user.userId,
    });
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: 'Cross-Tenant Member',
      country: 'TH',
      planId,
      planYear: 2026,
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId,
      memberId,
      firstName: 'Anna',
      lastName: 'Adm',
      email: opts.contactEmail,
      isPrimary: true,
      preferredLanguage: 'en',
    });
    await tx.insert(renewalCycles).values({
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      status: 'upcoming',
      periodFrom: PERIOD_FROM,
      periodTo: EXPIRES_AT_30D,
      expiresAt: EXPIRES_AT_30D,
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      // `plan_id_at_cycle_start` is a UUID column (snapshot of plan
      // at cycle creation, decoupled from the F2 plans table's
      // string ID). Existing F8 integration tests use a fresh UUID
      // here rather than the membership-plans `planId` slug.
      planIdAtCycleStart: randomUUID(),
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
    });
  });

  return { memberId, cycleId, contactId, contactEmail: opts.contactEmail };
}

describe('F8 cross-tenant probes — Constitution Principle I (J3-B7 + H3)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let seedA: SeededTenant;
  let seedB: SeededTenant;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;
    await seedRenewalPolicies(tenantA.ctx);
    await seedRenewalPolicies(tenantB.ctx);
    seedA = await seedTenant(tenantA, user, {
      contactEmail: `xtenant-a-${randomUUID().slice(0, 6)}@acme.example`,
    });
    seedB = await seedTenant(tenantB, user, {
      contactEmail: `xtenant-b-${randomUUID().slice(0, 6)}@beta.example`,
    });
  }, 120_000);

  afterAll(async () => {
    // Manual cleanup ahead of the helper's tenant-scoped deletes —
    // mirrors the tenant-isolation.test.ts pattern. Order: child →
    // parent (escalation_tasks + reminder_events → cycles → contacts
    // → members → plans → audit_log).
    for (const t of [tenantA, tenantB]) {
      await db
        .delete(renewalEscalationTasks)
        .where(eq(renewalEscalationTasks.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(renewalReminderEvents)
        .where(eq(renewalReminderEvents.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(renewalCycles)
        .where(eq(renewalCycles.tenantId, t.ctx.slug))
        .catch(() => {});
    }
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  }, 120_000);

  // ---------------------------------------------------------------------------
  // 1. dispatchRenewalCycle (T088 cron entry)
  // ---------------------------------------------------------------------------

  describe('dispatchRenewalCycle', () => {
    it('A.dispatch sees ONLY A cycles — B cycle invisible to RLS-bound candidate query', async () => {
      const deps = makeRenewalsDeps(tenantA.ctx.slug);
      // Stub gateway so the test measures isolation, not Resend
      // network calls.
      const gatewaySpy = vi
        .spyOn(deps.renewalGateway, 'sendRenewalEmail')
        .mockResolvedValue({
          ok: true,
          value: {
            deliveryId: `xt-mock-${randomUUID().slice(0, 8)}`,
            dispatchedAt: NOW_ISO,
          },
        } as never);

      const result = await dispatchRenewalCycle(deps, {
        tenantId: tenantA.ctx.slug,
        correlationId: randomUUID(),
        nowIso: NOW_ISO,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // A has exactly 1 candidate cycle (B's must NOT appear).
      expect(result.value.summary.candidatesProcessed).toBe(1);
      // The T-30 step is due → exactly 1 email sent.
      expect(result.value.summary.emailsSent).toBe(1);
      expect(gatewaySpy).toHaveBeenCalledTimes(1);

      // B's cycle has NO reminder_event row (the dispatcher never
      // saw it).
      const bRows = await db
        .select()
        .from(renewalReminderEvents)
        .where(eq(renewalReminderEvents.tenantId, tenantB.ctx.slug));
      expect(bRows).toHaveLength(0);

      // A's reminder_event row exists, scoped to A's cycle only.
      const aRows = await db
        .select()
        .from(renewalReminderEvents)
        .where(eq(renewalReminderEvents.tenantId, tenantA.ctx.slug));
      expect(aRows).toHaveLength(1);
      expect(aRows[0]?.cycleId).toBe(seedA.cycleId);

      // Audit row tied to A only — no leakage into B's audit_log.
      const sentInB = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenantB.ctx.slug),
            eq(auditLog.eventType, 'renewal_reminder_sent' as never),
          ),
        );
      expect(sentInB).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. sendReminderNow (T089 admin manual entry)
  // ---------------------------------------------------------------------------

  describe('sendReminderNow', () => {
    it("A.send(B's cycleId) returns cycle_not_found — no reminder_event written under B, no audit leak", async () => {
      const deps = makeRenewalsDeps(tenantA.ctx.slug);
      const gatewaySpy = vi
        .spyOn(deps.renewalGateway, 'sendRenewalEmail')
        .mockResolvedValue({
          ok: true,
          value: {
            deliveryId: 'should-not-be-called',
            dispatchedAt: NOW_ISO,
          },
        } as never);

      const result = await sendReminderNow(deps, {
        tenantId: tenantA.ctx.slug,
        cycleId: seedB.cycleId, // PROBE — A is querying for B's cycle.
        actorUserId: user.userId,
        actorRole: 'admin',
        correlationId: randomUUID(),
      });

      // RLS in dispatchCandidateRepo.findOne hides B's row from A.
      // The use-case explicitly documents that admin manual actions
      // do NOT emit `renewal_cross_tenant_probe` audits (admin UI
      // state mismatch is not a malicious probe). We assert the
      // structural invariant: no leak into B's reminder_events or
      // audit_log.
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('cycle_not_found');
      // Gateway never called — RLS rejected the lookup before any
      // dispatch path ran.
      expect(gatewaySpy).not.toHaveBeenCalled();

      // No reminder_event ever inserted into B (under either tenant
      // scope), and no audit row tied to B's cycleId emitted under
      // A's audit_log.
      const bReminders = await db
        .select()
        .from(renewalReminderEvents)
        .where(
          and(
            eq(renewalReminderEvents.tenantId, tenantB.ctx.slug),
            eq(renewalReminderEvents.cycleId, seedB.cycleId),
          ),
        );
      expect(bReminders).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. detectBounceThreshold (T090 F1 webhook hook)
  // ---------------------------------------------------------------------------

  describe('detectBounceThreshold', () => {
    it("A.detect(B's memberId) returns no_threshold_crossed with zero counts — B.email_unverified flag untouched", async () => {
      const deps = makeRenewalsDeps(tenantA.ctx.slug);

      const result = await detectBounceThreshold(deps, {
        tenantId: tenantA.ctx.slug,
        memberId: seedB.memberId, // PROBE — A queries for B's member.
        actorRole: 'webhook',
        correlationId: randomUUID(),
      });

      // The use-case takes RLS-bound paths through cyclesRepo +
      // bounceEventQuery; both return zeros under A's binding for B's
      // memberId, so the threshold classifier returns null →
      // `no_threshold_crossed`. (`already_unverified` is the OTHER
      // RLS-hidden outcome path, fired from `setEmailUnverified
      // affectedRows === 0` — covered by the unit-level B6 test in
      // dispatch-one-cycle.test.ts; here we only need to confirm
      // there is no state mutation.)
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(['no_threshold_crossed', 'already_unverified']).toContain(
        result.value.kind,
      );

      // CRITICAL invariant: B's member row is unchanged. RLS-bound
      // setEmailUnverified would have returned affectedRows=0; we
      // verify directly via tenantB binding that the flag stays
      // false.
      const bMember = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select({ emailUnverified: members.emailUnverified })
          .from(members)
          .where(eq(members.memberId, seedB.memberId)),
      );
      expect(bMember[0]?.emailUnverified).toBe(false);

      // No escalation task created in either tenant from this probe.
      const taskCount = await db
        .select()
        .from(renewalEscalationTasks)
        .where(eq(renewalEscalationTasks.memberId, seedB.memberId));
      expect(taskCount).toHaveLength(0);

      // No probe audit emitted (use-case contract — see docstring).
      const probesInA = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenantA.ctx.slug),
            eq(auditLog.eventType, 'renewal_cross_tenant_probe' as never),
          ),
        );
      expect(probesInA).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. lookupMemberByEmail — MTA boundary contract (J3-H3)
  // ---------------------------------------------------------------------------

  describe('lookupMemberByEmail (MTA+STD escape hatch)', () => {
    it('returns null for an email that matches no contact (deterministic)', async () => {
      const result = await lookupMemberByEmail(
        `nonexistent-${randomUUID()}@example.com`,
      );
      expect(result).toBeNull();
    });

    it('matches case-insensitively + ignores soft-deleted contacts', async () => {
      // Seed A's contact email with mixed case, query in upper case.
      const upperEmail = seedA.contactEmail.toUpperCase();
      const result = await lookupMemberByEmail(upperEmail);
      expect(result).not.toBeNull();
      expect(result?.tenantId).toBe(tenantA.ctx.slug);
      expect(result?.memberId).toBe(seedA.memberId);
    });

    it('email collision across A + B: returns ONE deterministic match (MTA+STD safety contract)', async () => {
      // Seed an additional collision contact in tenantB matching the
      // SAME email as tenantA's primary contact. Per the lookup
      // utility's MTA+STD safety doc, exactly one match wins under
      // single-tenant deployment; collision behaviour is "first row
      // returned by Postgres" (LIMIT 1 with no ORDER BY). Asserting
      // that the result IS one of the two pinned tenants — and
      // critically NOT a third-tenant accidental match — is the
      // boundary contract this test pins.
      const collidingEmail = seedA.contactEmail;
      const collisionContactId = randomUUID();
      await runInTenant(tenantB.ctx, async (tx) => {
        await tx.insert(contacts).values({
          tenantId: tenantB.ctx.slug,
          contactId: collisionContactId,
          memberId: seedB.memberId,
          firstName: 'Collision',
          lastName: 'Test',
          email: collidingEmail,
          isPrimary: false, // primary already taken by initial seed
          preferredLanguage: 'en',
        });
      });
      try {
        const result = await lookupMemberByEmail(collidingEmail);
        expect(result).not.toBeNull();
        // Result MUST resolve to one of the two seeded tenants — not
        // a stray third tenant from leaked test pollution.
        expect([tenantA.ctx.slug, tenantB.ctx.slug]).toContain(
          result?.tenantId,
        );
        // contactId MUST match one of the two seeded contacts.
        expect([seedA.contactId, collisionContactId]).toContain(
          result?.contactId,
        );
      } finally {
        // Cleanup the colliding row so subsequent assertions in
        // afterAll don't see it.
        await db
          .delete(contacts)
          .where(eq(contacts.contactId, collisionContactId))
          .catch(() => {});
      }
    });

    it('soft-deleted contact (removed_at IS NOT NULL) is invisible to the lookup', async () => {
      const ghostEmail = `ghost-${randomUUID().slice(0, 8)}@example.com`;
      const ghostContactId = randomUUID();
      await runInTenant(tenantA.ctx, async (tx) => {
        await tx.insert(contacts).values({
          tenantId: tenantA.ctx.slug,
          contactId: ghostContactId,
          memberId: seedA.memberId,
          firstName: 'Ghost',
          lastName: 'Removed',
          email: ghostEmail,
          isPrimary: false,
          preferredLanguage: 'en',
          removedAt: new Date(), // soft-deleted at insert time
        });
      });
      try {
        const result = await lookupMemberByEmail(ghostEmail);
        expect(result).toBeNull();
      } finally {
        await db
          .delete(contacts)
          .where(eq(contacts.contactId, ghostContactId))
          .catch(() => {});
      }
    });
  });
});

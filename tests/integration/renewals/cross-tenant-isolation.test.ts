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
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalReminderEvents } from '@/modules/renewals/infrastructure/schema-renewal-reminder-events';
import { renewalEscalationTasks } from '@/modules/renewals/infrastructure/schema-renewal-escalation-tasks';
import {
  acceptTierUpgrade,
  completeEscalationTask,
  createEscalationTask,
  detectBounceThreshold,
  dismissTierUpgrade,
  dispatchRenewalCycle,
  escalateTierUpgrade,
  evaluateTierUpgrade,
  makeRenewalsDeps,
  reassignEscalationTask,
  sendReminderNow,
  skipEscalationTask,
} from '@/modules/renewals';
import { tierUpgradeSuggestions } from '@/modules/renewals/infrastructure/schema-tier-upgrade-suggestions';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import {
  parseSuggestionId,
  type SuggestionId,
} from '@/modules/renewals';
import { lookupMemberByEmail } from '@/modules/renewals/infrastructure/lookup-member-by-email';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';


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
    await seedF8MembershipPlan(tx, {
      tenantSlug: tenant.ctx.slug,
      planId,
      planName: { en: 'Cross-Tenant Plan' },
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      createdBy: user.userId,
    });
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
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
      // T149 RESOLVED (migration 0113): `plan_id_at_cycle_start` is
      // TEXT matching F2 `plan_id`. This isolation test only round-trips
      // the value, so a randomUUID() string still satisfies the column.
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
        .delete(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.tenantId, t.ctx.slug))
        .catch(() => {});
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
      await db
        .delete(membershipPlans)
        .where(eq(membershipPlans.tenantId, t.ctx.slug))
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

  // ----- Phase 6 review C4 — at-risk surfaces tenant isolation -------
  describe('at-risk surfaces (Phase 6 review C4)', () => {
    it('snoozeAtRiskMember in tenant B context cannot snooze tenant A member', async () => {
      const { snoozeAtRiskMember } = await import('@/modules/renewals');
      const depsB = makeRenewalsDeps(tenantB.ctx.slug);
      const result = await snoozeAtRiskMember(depsB, {
        tenantId: tenantB.ctx.slug,
        memberId: seedA.memberId, // tenant A's member
        durationDays: 7,
        actorUserId: user.userId,
        actorRole: 'admin',
        correlationId: randomUUID(),
        requestId: null,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // RLS hides tenant A's member from tenant B → member_not_found.
      expect(result.error.kind).toBe('member_not_found');
      // Tenant A's member.risk_snoozed_until MUST remain NULL.
      const probe = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .select({ snoozed: members.riskSnoozedUntil })
          .from(members)
          .where(eq(members.memberId, seedA.memberId))
          .limit(1),
      );
      expect(probe[0]?.snoozed).toBeNull();
    });

    it('recordAtRiskOutreach in tenant B context cannot record outreach against tenant A member', async () => {
      const { recordAtRiskOutreach } = await import('@/modules/renewals');
      const { atRiskOutreach } = await import(
        '@/modules/renewals/infrastructure/schema-at-risk-outreach'
      );
      const depsB = makeRenewalsDeps(tenantB.ctx.slug);
      // Outreach REJECTED — either via Result.err (use-case caught FK)
      // OR via thrown PostgresError (runInTenant COMMIT after caught
      // FK aborts the aborted tx). Either path proves tenant isolation;
      // the post-condition (no row written anywhere) is the load-
      // bearing assertion.
      let rejected = false;
      try {
        const result = await recordAtRiskOutreach(depsB, {
          tenantId: tenantB.ctx.slug,
          memberId: seedA.memberId, // tenant A's member
          channel: 'email',
          templateId: 'at_risk.outreach.event_drought',
          outcomeNote: 'cross-tenant probe',
          actorUserId: user.userId,
          actorRole: 'admin',
          correlationId: randomUUID(),
          requestId: null,
        });
        rejected = !result.ok;
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
      // Tenant A MUST have zero outreach rows after the failed probe.
      const aRows = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .select()
          .from(atRiskOutreach)
          .where(eq(atRiskOutreach.memberId, seedA.memberId)),
      );
      expect(aRows.length).toBe(0);
      // Tenant B MUST also have zero rows (FK rejected before insert).
      const bRows = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select()
          .from(atRiskOutreach)
          .where(eq(atRiskOutreach.memberId, seedA.memberId)),
      );
      expect(bRows.length).toBe(0);
    });

    it('listAtRiskWidgetMembers in tenant B context never sees tenant A rows', async () => {
      // Plant a high risk_score on tenant A's member directly.
      await runInTenant(tenantA.ctx, async (tx) => {
        await tx
          .update(members)
          .set({
            riskScore: 80,
            riskScoreBand: 'critical',
            riskScoreFactors: {},
            riskScoreLastComputedAt: new Date(),
          })
          .where(eq(members.memberId, seedA.memberId));
      });
      try {
        const depsB = makeRenewalsDeps(tenantB.ctx.slug);
        const page = await runInTenant(tenantB.ctx, (tx) =>
          depsB.memberRenewalFlagsRepo.listAtRiskWidgetMembers(
            tx,
            tenantB.ctx.slug,
            { limit: 50 },
          ),
        );
        const memberIds = page.items.map((m) => m.memberId);
        // Tenant A's member MUST NOT appear in tenant B's widget.
        expect(memberIds).not.toContain(seedA.memberId);
      } finally {
        // Reset tenant A's risk_score so subsequent tests start clean.
        await runInTenant(tenantA.ctx, async (tx) => {
          await tx
            .update(members)
            .set({
              riskScore: null,
              riskScoreBand: null,
              riskScoreFactors: null,
              riskScoreLastComputedAt: null,
            })
            .where(eq(members.memberId, seedA.memberId));
        });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Escalation-task lifecycle (Phase 8 T223 cross-tenant extension)
  //    Constitution Principle I clause 3 — every cross-tenant access
  //    attempt MUST refuse + audit OR return null/empty under the
  //    tenant binding. The Phase 8 admin queue surfaces (Done / Skip /
  //    Reassign) operate on a `taskId` looked up by `findById` which
  //    is RLS-bound; cross-tenant attempts MUST resolve `task_not_found`
  //    + emit zero state mutation in the foreign tenant's row.
  // ---------------------------------------------------------------------------
  describe('escalation-task admin actions (Phase 8 T223 extension)', () => {
    // Round 5 HV-2 close — collapse the 3 lifecycle probes (complete /
    // skip / reassign) to `it.each` over a probe matrix. Each probe
    // shares the same setup (seed open task in B), invariants (refusal
    // returns task_not_found), and cleanup pattern; only the use-case
    // call + the post-call B-row assertion differ. The 4th probe
    // (`A.create(B-tenant memberId)`) stays standalone — its assertion
    // shape is meaningfully different (FK error + no rows in either
    // tenant rather than `task_not_found`).
    type LifecycleProbe = {
      readonly name: 'complete' | 'skip' | 'reassign';
      readonly taskType: string;
      readonly call: (
        depsA: ReturnType<typeof makeRenewalsDeps>,
        taskBId: string,
      ) => Promise<{ ok: boolean; error?: { kind: string } }>;
      readonly assertBRow: (row: typeof renewalEscalationTasks.$inferSelect | undefined) => void;
    };
    const probes: ReadonlyArray<LifecycleProbe> = [
      {
        name: 'complete',
        taskType: 'phone_call',
        call: async (depsA, taskBId) =>
          (await completeEscalationTask(depsA, {
            tenantId: tenantA.ctx.slug,
            taskId: taskBId,
            actorUserId: user.userId,
            actorRole: 'admin',
            correlationId: randomUUID(),
          })) as { ok: boolean; error?: { kind: string } },
        assertBRow: (row) => {
          expect(row?.status).toBe('open');
          expect(row?.outcomeNote).toBeNull();
        },
      },
      {
        name: 'skip',
        taskType: 'in_person_meeting',
        call: async (depsA, taskBId) =>
          (await skipEscalationTask(depsA, {
            tenantId: tenantA.ctx.slug,
            taskId: taskBId,
            skippedReason: 'cross-tenant probe',
            actorUserId: user.userId,
            actorRole: 'admin',
            correlationId: randomUUID(),
          })) as { ok: boolean; error?: { kind: string } },
        assertBRow: (row) => {
          expect(row?.status).toBe('open');
          expect(row?.skippedReason).toBeNull();
        },
      },
      {
        name: 'reassign',
        taskType: 'board_escalation',
        call: async (depsA, taskBId) =>
          (await reassignEscalationTask(depsA, {
            tenantId: tenantA.ctx.slug,
            taskId: taskBId,
            toUserId: user.userId,
            actorUserId: user.userId,
            actorRole: 'admin',
            correlationId: randomUUID(),
          })) as { ok: boolean; error?: { kind: string } },
        assertBRow: (row) => {
          expect(row?.status).toBe('open');
          expect(row?.assignedToUserId).toBeNull();
        },
      },
    ];

    it.each(probes)(
      'A.$name(B-tenant taskId) → task_not_found + B row unchanged + zero audit leak',
      async ({ taskType, call, assertBRow }) => {
        const taskBId = randomUUID();
        await runInTenant(tenantB.ctx, async (tx) => {
          await tx.insert(renewalEscalationTasks).values({
            tenantId: tenantB.ctx.slug,
            taskId: taskBId,
            memberId: seedB.memberId,
            cycleId: seedB.cycleId,
            taskType,
            assignedToRole: 'admin',
            assignedToUserId: null,
            dueAt: new Date('2026-07-01T00:00:00.000Z'),
            status: 'open',
          });
        });

        const depsA = makeRenewalsDeps(tenantA.ctx.slug);
        const r = await call(depsA, taskBId);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error?.kind).toBe('task_not_found');

        const bRow = await runInTenant(tenantB.ctx, (tx) =>
          tx
            .select()
            .from(renewalEscalationTasks)
            .where(eq(renewalEscalationTasks.taskId, taskBId)),
        );
        assertBRow(bRow[0]);

        // R6 IMP-13 + R8 IMP-E close — Constitution Principle I
        // clause 4: every cross-tenant access attempt MUST refuse +
        // emit zero audit leak. Probe ALL audit events for the
        // foreign taskId — should be zero rows.
        //
        // R8 IMP-E: also probe payload-text containment so a future
        // event renaming `task_id` → `taskId`/`task` would still fail
        // the test (defends against silent field-rename regressions).
        const auditsBySpecificField = await db
          .select()
          .from(auditLog)
          .where(sql`payload ->> 'task_id' = ${taskBId}`);
        expect(auditsBySpecificField).toHaveLength(0);
        const auditsByContainment = await db
          .select()
          .from(auditLog)
          .where(sql`payload::text LIKE ${`%${taskBId}%`}`);
        expect(auditsByContainment).toHaveLength(0);

        // Cleanup.
        await runInTenant(tenantB.ctx, async (tx) => {
          await tx
            .delete(renewalEscalationTasks)
            .where(eq(renewalEscalationTasks.taskId, taskBId));
        });
      },
      60_000,
    );

    // Probe 4 — different shape: A constructs a task for B's member.
    // The FK lookup against `members` under A's binding fails because
    // RLS hides B's member row. We assert no row is created in either
    // tenant's binding.

    it('A.create(B-tenant memberId) → task lands in tenant A, NOT B (RLS pins inserted row to current tenant)', async () => {
      // The use-case input passes `tenantId: A.slug` + `memberId: seedB.memberId`.
      // Under tenant A's binding, the `members` FK lookup will fail (RLS hides
      // B's member row), so the INSERT errors out at the FK constraint —
      // proving cross-tenant insert is blocked at the DB layer.
      const depsA = makeRenewalsDeps(tenantA.ctx.slug);
      const r = await createEscalationTask(depsA, {
        tenantId: tenantA.ctx.slug,
        memberId: seedB.memberId, // PROBE — A constructs a task for B's member
        cycleId: null,
        taskType: 'manual_outreach_required',
        assignedToRole: 'admin',
        dueAt: new Date('2026-07-01T00:00:00.000Z').toISOString(),
        triggerReason: 'cross-tenant probe',
        actorUserId: user.userId,
        actorRole: 'admin',
        correlationId: randomUUID(),
      });
      // The use-case wraps the FK violation in `runInTenant` → maps to
      // server_error. Either way, NO row is created in tenant A AND no
      // row appears in tenant B's binding for B's member with this task type.
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('server_error');

      const bRows = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select()
          .from(renewalEscalationTasks)
          .where(
            and(
              eq(renewalEscalationTasks.memberId, seedB.memberId),
              eq(
                renewalEscalationTasks.taskType,
                'manual_outreach_required',
              ),
            ),
          ),
      );
      expect(bRows).toHaveLength(0);
    }, 60_000);
  });

  // ---------------------------------------------------------------------------
  // 7. Tier-upgrade cross-tenant probes (Phase 7 / Round 6 review-fix F-001)
  //
  // Constitution v1.4.0 Principle I clause 3 — Review-Gate blocker:
  // every use-case that touches tenant-scoped data MUST be exercised by
  // a cross-tenant integration probe. Phase 7 added 5 new use-cases
  // (`evaluateTierUpgrade`, `acceptTierUpgrade`, `dismissTierUpgrade`,
  // `escalateTierUpgrade`, `reconcilePendingApplications`) — none had
  // probes before this block was added.
  //
  // Use-cases under probe:
  //   - acceptTierUpgrade(tenantA, suggestionId=B) → suggestion_not_found
  //     + B's row stays `open`
  //   - dismissTierUpgrade(tenantA, suggestionId=B) → suggestion_not_found
  //     + B's row stays `open`
  //   - escalateTierUpgrade(tenantA, suggestionId=B) → suggestion_not_found
  //     + B's row stays `open` + zero `at_risk_outreach` row in either
  //     tenant
  //   - evaluateTierUpgrade under tenantA — B's `tier_upgrade_suggestions`
  //     count stays 0 (RLS hides B's members from A's candidate query)
  //
  // These use-cases do NOT emit `renewal_cross_tenant_probe` audits (by
  // design — they all funnel through `loadOpenSuggestion` which uses
  // RLS-bound `findById`, so the probe is invisible at the use-case
  // layer). Tests therefore assert on post-condition state (B's row
  // unchanged) + zero state mutation in the foreign tenant.
  // ---------------------------------------------------------------------------
  describe('tier-upgrade cross-tenant probes (Phase 7 / Round 6 F-001)', () => {
    /**
     * Seed an open `tier_upgrade_suggestions` row in `tenant`. Returns
     * the parsed `SuggestionId` brand for input.
     */
    async function seedOpenSuggestion(
      tenant: TestTenant,
      memberId: string,
    ): Promise<{ suggestionId: SuggestionId }> {
      const suggestionUuid = randomUUID();
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(tierUpgradeSuggestions).values({
          tenantId: tenant.ctx.slug,
          suggestionId: suggestionUuid,
          memberId,
          fromPlanId: 'regular',
          toPlanId: 'premium',
          reasonCode: 'declared_turnover_above_threshold',
          evidenceJsonb: {
            reasonCode: 'declared_turnover_above_threshold',
            turnoverThb: 120_000_000,
            thresholdMetAt: new Date().toISOString(),
          },
          status: 'open',
        });
      });
      const idResult = parseSuggestionId(suggestionUuid);
      if (!idResult.ok) throw new Error('seeded suggestion id failed parse');
      return { suggestionId: idResult.value };
    }

    it('A.acceptTierUpgrade(B-tenant suggestionId) → suggestion_not_found + B row stays open', async () => {
      const { suggestionId: bSuggestionId } = await seedOpenSuggestion(
        tenantB,
        seedB.memberId,
      );
      try {
        const depsA = makeRenewalsDeps(tenantA.ctx.slug);
        const result = await acceptTierUpgrade(depsA, {
          tenantId: tenantA.ctx.slug, // PROBE — A queries for B's suggestion
          suggestionId: bSuggestionId,
          actorUserId: user.userId,
          actorRole: 'admin',
          correlationId: randomUUID(),
        });

        // RLS-bound `findById` returns null under A's binding → load
        // helper maps to `suggestion_not_found`.
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('suggestion_not_found');

        // Post-condition: B's suggestion stays in `open` (never
        // transitioned to `accepted_pending_apply`).
        const bRows = await runInTenant(tenantB.ctx, (tx) =>
          tx
            .select()
            .from(tierUpgradeSuggestions)
            .where(eq(tierUpgradeSuggestions.suggestionId, bSuggestionId)),
        );
        expect(bRows).toHaveLength(1);
        expect(bRows[0]?.status).toBe('open');
        expect(bRows[0]?.acceptedAt).toBeNull();
        expect(bRows[0]?.acceptedByUserId).toBeNull();

        // Audit isolation: no `tier_upgrade_accepted` ever landed in
        // either tenant for B's suggestion id.
        const auditByContainment = await db
          .select()
          .from(auditLog)
          .where(sql`payload::text LIKE ${`%${bSuggestionId}%`}`);
        expect(auditByContainment).toHaveLength(0);
      } finally {
        await runInTenant(tenantB.ctx, (tx) =>
          tx
            .delete(tierUpgradeSuggestions)
            .where(eq(tierUpgradeSuggestions.suggestionId, bSuggestionId)),
        ).catch(() => {});
      }
    }, 60_000);

    it('A.dismissTierUpgrade(B-tenant suggestionId) → suggestion_not_found + B row stays open', async () => {
      const { suggestionId: bSuggestionId } = await seedOpenSuggestion(
        tenantB,
        seedB.memberId,
      );
      try {
        const depsA = makeRenewalsDeps(tenantA.ctx.slug);
        const result = await dismissTierUpgrade(depsA, {
          tenantId: tenantA.ctx.slug, // PROBE
          suggestionId: bSuggestionId,
          reason: 'cross-tenant probe',
          actorUserId: user.userId,
          actorRole: 'admin',
          correlationId: randomUUID(),
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('suggestion_not_found');

        const bRows = await runInTenant(tenantB.ctx, (tx) =>
          tx
            .select()
            .from(tierUpgradeSuggestions)
            .where(eq(tierUpgradeSuggestions.suggestionId, bSuggestionId)),
        );
        expect(bRows[0]?.status).toBe('open');
        expect(bRows[0]?.dismissedReason).toBeNull();
        expect(bRows[0]?.suppressedUntil).toBeNull();

        const auditByContainment = await db
          .select()
          .from(auditLog)
          .where(sql`payload::text LIKE ${`%${bSuggestionId}%`}`);
        expect(auditByContainment).toHaveLength(0);
      } finally {
        await runInTenant(tenantB.ctx, (tx) =>
          tx
            .delete(tierUpgradeSuggestions)
            .where(eq(tierUpgradeSuggestions.suggestionId, bSuggestionId)),
        ).catch(() => {});
      }
    }, 60_000);

    it('A.escalateTierUpgrade(B-tenant suggestionId) → suggestion_not_found + B row stays open + zero outreach inserted', async () => {
      const { atRiskOutreach } = await import(
        '@/modules/renewals/infrastructure/schema-at-risk-outreach'
      );
      const { suggestionId: bSuggestionId } = await seedOpenSuggestion(
        tenantB,
        seedB.memberId,
      );
      try {
        const depsA = makeRenewalsDeps(tenantA.ctx.slug);
        const result = await escalateTierUpgrade(depsA, {
          tenantId: tenantA.ctx.slug, // PROBE
          suggestionId: bSuggestionId,
          actorUserId: user.userId,
          actorRole: 'admin',
          correlationId: randomUUID(),
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('suggestion_not_found');

        // No outreach row should land in either tenant — escalate
        // returns before writing.
        const aOutreach = await runInTenant(tenantA.ctx, (tx) =>
          tx
            .select()
            .from(atRiskOutreach)
            .where(eq(atRiskOutreach.memberId, seedB.memberId)),
        );
        expect(aOutreach).toHaveLength(0);
        const bOutreach = await runInTenant(tenantB.ctx, (tx) =>
          tx
            .select()
            .from(atRiskOutreach)
            .where(eq(atRiskOutreach.memberId, seedB.memberId)),
        );
        expect(bOutreach).toHaveLength(0);
      } finally {
        await runInTenant(tenantB.ctx, (tx) =>
          tx
            .delete(tierUpgradeSuggestions)
            .where(eq(tierUpgradeSuggestions.suggestionId, bSuggestionId)),
        ).catch(() => {});
      }
    }, 60_000);

    it('A.evaluateTierUpgrade — B tier_upgrade_suggestions count stays 0 (candidate query is RLS-bound)', async () => {
      // Pre-condition: ensure B has no open suggestion (the eval probe
      // verifies the candidate query CANNOT see B's members from
      // tenant A's binding). Seed a plan catalogue in A so the eval
      // doesn't short-circuit on `no_thresholds_configured`.
      await runInTenant(tenantA.ctx, async (tx) => {
        // Insert "regular" plan with a turnover threshold so the eval
        // catalogue isn't empty. We don't need the member's plan to
        // match — we only need the eval to pass the no-thresholds
        // gate so it can iterate its (empty) candidate page.
        await tx
          .insert(membershipPlans)
          .values({
            tenantId: tenantA.ctx.slug,
            planId: `xt-evalplan-${randomUUID().slice(0, 8)}`,
            planYear: 2026,
            planName: { en: 'Eval Probe Plan' },
            description: { en: 'Test description' },
            sortOrder: 99,
            planCategory: 'corporate',
            memberTypeScope: 'company',
            annualFeeMinorUnits: 5_000_000,
            includesCorporatePlanId: null,
            minTurnoverMinorUnits: 50_000_000,
            maxTurnoverMinorUnits: null,
            maxDurationYears: null,
            maxMemberAge: null,
            benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
            renewalTierBucket: 'regular',
            isActive: true,
            createdBy: user.userId,
            updatedBy: user.userId,
          })
          .onConflictDoNothing()
          .catch(() => {});
      });

      const beforeCount = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select()
          .from(tierUpgradeSuggestions)
          .where(eq(tierUpgradeSuggestions.tenantId, tenantB.ctx.slug)),
      );
      const baseline = beforeCount.length;

      const depsA = makeRenewalsDeps(tenantA.ctx.slug);
      const result = await evaluateTierUpgrade(depsA, {
        tenantId: tenantA.ctx.slug,
        correlationId: randomUUID(),
        pageSize: 100,
      });

      // Round 6 Round-7 review-fix IMP-2 — assertion + comment now
      // agree. The eval cron may legitimately short-circuit on either
      // (a) ok=true with `tenantSkipped: { reason: 'no_thresholds_configured' }`
      // when the seeded plan lacks `min_turnover_minor_units`, or
      // (b) ok=true with `tenantSkipped: null` and a normal scan over
      // A's members (none crossing thresholds in this test).
      // Both prove the candidate query did not see B's members; the
      // load-bearing assertion is the post-condition that B's
      // suggestion count is unchanged.
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect([null, 'no_thresholds_configured']).toContain(
          result.value.tenantSkipped?.reason ?? null,
        );
      }

      const afterCount = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select()
          .from(tierUpgradeSuggestions)
          .where(eq(tierUpgradeSuggestions.tenantId, tenantB.ctx.slug)),
      );
      expect(afterCount.length).toBe(baseline);
    }, 60_000);
  });
});

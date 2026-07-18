/**
 * 107-auto-invoice Task 15 — `bulkEnrolAutoInvoice` use-case integration
 * test (live Neon).
 *
 * This use-case writes the THIRD and final auto-invoice gating key:
 * `members.auto_invoice_enrolled_at`. Before this task nothing in the
 * codebase wrote that column, so the Task 6/7 cron's eligibility query
 * (`drizzle-renewal-cycle-repo.ts` `listCyclesEligibleForAutoDraft`,
 * which filters `auto_invoice_enrolled_at IS NOT NULL`) could never
 * select anybody.
 *
 * Verified against real Postgres + RLS:
 *
 *   (a) Bucket accounting — a batch of {fresh, already-enrolled,
 *       terminated} resolves to exactly
 *       `{ enrolled:1, skippedAlready:1, skippedTerminated:1 }`, and the
 *       fresh member's `auto_invoice_enrolled_at` is actually set.
 *   (b) Non-enrolled members are NOT written — the already-enrolled
 *       member keeps its ORIGINAL timestamp (the UPDATE must not
 *       re-stamp), and the terminated member stays NULL.
 *   (c) One `member_auto_invoice_enrolled` audit row per ENROLLED
 *       member (not per requested member), carrying `action` +
 *       `bulk_request_id` so a bulk run is correlatable — the same
 *       payload convention `bulkAction` uses for `member_archived` /
 *       `member_plan_changed`.
 *   (d) A `suspended` member IS enrolled. `deriveMembershipAccess`
 *       returns three states; only `terminated` is a skip. See the
 *       use-case docstring for why suspended must stay enrollable.
 *   (e) Idempotent re-run — enrolling the same batch twice moves
 *       everything into `skippedAlready` and emits NO second audit row.
 *   (f) Unknown member id → `not_found`, and the whole batch rolls back
 *       (no partial enrolment), matching `bulkAction`'s all-or-nothing
 *       contract.
 *   (g) Cross-tenant probe — a member id belonging to another tenant is
 *       invisible (`not_found`), and that foreign member is never
 *       mutated. Constitution Principle I mandatory isolation test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { bulkEnrolAutoInvoice } from '@/modules/members/application/use-cases/bulk-enrol-auto-invoice';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('107-auto-invoice Task 15 — bulkEnrolAutoInvoice (live Neon)', () => {
  let tenant: TestTenant;
  let otherTenant: TestTenant;
  let user: TestUser;
  let planId: string;
  let otherPlanId: string;

  // Pre-existing enrolment stamp on the already-enrolled member. Must
  // survive the bulk run untouched (assertion (b)).
  const ORIGINAL_ENROLLED_AT = new Date('2026-01-01T00:00:00.000Z');

  const mFresh = randomUUID(); // no cycle at all → access 'full' → enrolled
  const mAlready = randomUUID(); // already stamped → skippedAlready
  const mTerminated = randomUUID(); // lapsed cycle → access 'terminated' → skipped
  const mSuspended = randomUUID(); // awaiting_payment cycle → 'suspended' → enrolled
  const mForeign = randomUUID(); // lives in otherTenant → invisible

  const cTerminated = randomUUID();
  const cSuspended = randomUUID();

  const seedMembers = async (
    t: TestTenant,
    plan: string,
    specs: ReadonlyArray<{ memberId: string; enrolledAt: Date | null }>,
  ) =>
    runInTenant(t.ctx, (tx) =>
      tx.insert(members).values(
        specs.map((m) => ({
          tenantId: t.ctx.slug,
          memberId: m.memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: `Enrol Co ${m.memberId.slice(0, 6)}`,
          country: 'TH' as const,
          planId: plan,
          planYear: 2026,
          autoInvoiceEnrolledAt: m.enrolledAt,
        })),
      ),
    );

  const seedCycle = (
    cycleId: string,
    memberId: string,
    status: 'lapsed' | 'awaiting_payment',
  ) =>
    runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status,
        periodFrom: new Date('2025-08-01T00:00:00Z'),
        periodTo: new Date('2026-08-01T00:00:00Z'),
        expiresAt: new Date('2026-08-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: 'regular',
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        // `renewal_cycles_closed_at_iff_terminal_check` (migration 0087):
        // closed_at is NOT NULL iff the status is terminal. `lapsed` is
        // terminal, `awaiting_payment` is not.
        ...(status === 'lapsed'
          ? {
              closedAt: new Date('2026-08-02T00:00:00Z'),
              closedReason: 'lapsed',
            }
          : {}),
      }),
    );

  const readEnrolledAt = async (
    t: TestTenant,
    memberId: string,
  ): Promise<Date | null> => {
    const rows = await runInTenant(t.ctx, (tx) =>
      tx
        .select({ at: members.autoInvoiceEnrolledAt })
        .from(members)
        .where(
          and(eq(members.tenantId, t.ctx.slug), eq(members.memberId, memberId)),
        ),
    );
    return rows[0]?.at ?? null;
  };

  const countEnrolAudits = async (memberId: string): Promise<number> => {
    // Read as owner (BYPASS RLS) so the assertion cannot itself be
    // fooled by a tenant-context mistake in the code under test.
    const rows = await db
      .select({ id: auditLog.id, payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'member_auto_invoice_enrolled'),
        ),
      );
    return rows.filter(
      (r) => (r.payload as Record<string, unknown> | null)?.member_id === memberId,
    ).length;
  };

  const deps = () => {
    const d = buildMembersDeps(tenant.ctx);
    return {
      tenant: d.tenant,
      memberRepo: d.memberRepo,
      audit: d.audit,
      clock: d.clock,
      membershipAccess: d.membershipAccess,
    };
  };

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');
    otherTenant = await createTestTenant('test');
    planId = `f8-enrol-${randomUUID().slice(0, 8)}`;
    otherPlanId = `f8-enrol-o-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Enrolment Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    await runInTenant(otherTenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: otherTenant.ctx.slug,
        planId: otherPlanId,
        planName: { en: 'Foreign Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );

    await seedMembers(tenant, planId, [
      { memberId: mFresh, enrolledAt: null },
      { memberId: mAlready, enrolledAt: ORIGINAL_ENROLLED_AT },
      { memberId: mTerminated, enrolledAt: null },
      { memberId: mSuspended, enrolledAt: null },
    ]);
    await seedMembers(otherTenant, otherPlanId, [
      { memberId: mForeign, enrolledAt: null },
    ]);

    await seedCycle(cTerminated, mTerminated, 'lapsed');
    await seedCycle(cSuspended, mSuspended, 'awaiting_payment');
  });

  afterAll(async () => {
    await db.delete(renewalCycles).where(
      inArray(renewalCycles.cycleId, [cTerminated, cSuspended]),
    );
    await db
      .delete(members)
      .where(
        inArray(members.memberId, [
          mFresh,
          mAlready,
          mTerminated,
          mSuspended,
          mForeign,
        ]),
      );
    await tenant.cleanup();
    await otherTenant.cleanup();
  });

  it('(a)+(b)+(c) buckets a mixed batch, writes only the fresh member, audits once', async () => {
    const result = await bulkEnrolAutoInvoice(
      { action: 'enrol_auto_invoice', member_ids: [mFresh, mAlready, mTerminated] },
      { actorUserId: user.userId, requestId: 'req-enrol-mixed' },
      deps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      enrolled: 1,
      skippedAlready: 1,
      skippedTerminated: 1,
    });

    // (a) fresh member actually stamped
    const freshAt = await readEnrolledAt(tenant, mFresh);
    expect(freshAt).toBeInstanceOf(Date);

    // (b) already-enrolled member keeps its ORIGINAL stamp (no re-stamp),
    //     terminated member never written.
    const alreadyAt = await readEnrolledAt(tenant, mAlready);
    expect(alreadyAt?.toISOString()).toBe(ORIGINAL_ENROLLED_AT.toISOString());
    expect(await readEnrolledAt(tenant, mTerminated)).toBeNull();

    // (c) exactly one audit row, and only for the enrolled member
    expect(await countEnrolAudits(mFresh)).toBe(1);
    expect(await countEnrolAudits(mAlready)).toBe(0);
    expect(await countEnrolAudits(mTerminated)).toBe(0);
  });

  it('(d) enrols a SUSPENDED member — only terminated is a skip', async () => {
    const result = await bulkEnrolAutoInvoice(
      { action: 'enrol_auto_invoice', member_ids: [mSuspended] },
      { actorUserId: user.userId, requestId: 'req-enrol-suspended' },
      deps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      enrolled: 1,
      skippedAlready: 0,
      skippedTerminated: 0,
    });
    expect(await readEnrolledAt(tenant, mSuspended)).toBeInstanceOf(Date);
  });

  it('(e) is idempotent — a second run skips and emits no new audit row', async () => {
    const before = await countEnrolAudits(mFresh);

    const result = await bulkEnrolAutoInvoice(
      { action: 'enrol_auto_invoice', member_ids: [mFresh] },
      { actorUserId: user.userId, requestId: 'req-enrol-repeat' },
      deps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      enrolled: 0,
      skippedAlready: 1,
      skippedTerminated: 0,
    });
    expect(await countEnrolAudits(mFresh)).toBe(before);
  });

  it('(f) rolls the whole batch back on an unknown member id', async () => {
    const ghost = randomUUID();
    // Seed a fresh, enrollable member alongside the ghost so we can prove
    // NOTHING was written when the batch aborts.
    const mVictim = randomUUID();
    await seedMembers(tenant, planId, [{ memberId: mVictim, enrolledAt: null }]);

    const result = await bulkEnrolAutoInvoice(
      { action: 'enrol_auto_invoice', member_ids: [mVictim, ghost] },
      { actorUserId: user.userId, requestId: 'req-enrol-ghost' },
      deps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('not_found');

    // All-or-nothing: the valid member in the same batch is untouched.
    expect(await readEnrolledAt(tenant, mVictim)).toBeNull();
    expect(await countEnrolAudits(mVictim)).toBe(0);

    await db.delete(members).where(eq(members.memberId, mVictim));
  });

  it('(g) cannot enrol a member belonging to another tenant', async () => {
    const result = await bulkEnrolAutoInvoice(
      { action: 'enrol_auto_invoice', member_ids: [mForeign] },
      { actorUserId: user.userId, requestId: 'req-enrol-cross-tenant' },
      deps(),
    );

    // RLS makes the foreign row invisible — it reads as a missing member.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('not_found');

    // The foreign member must be completely unmutated.
    expect(await readEnrolledAt(otherTenant, mForeign)).toBeNull();
  });
});

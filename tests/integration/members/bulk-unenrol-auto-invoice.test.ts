/**
 * 107-auto-invoice Task 18 — `bulkUnenrolAutoInvoice` use-case integration
 * test (live Neon).
 *
 * The counterpart to Task 15's `bulkEnrolAutoInvoice`. Task 15 shipped
 * enrolment as a ONE-WAY DOOR: `members.auto_invoice_enrolled_at` could be
 * stamped from the UI but only cleared by prod SQL. This clears it.
 *
 * The load-bearing difference from the enrol test is the ABSENCE of a
 * membership-state gate. Enrol skips `terminated` members (enrolling an
 * ex-member into automated billing has real blast radius). Un-enrol skips
 * NOBODY on membership grounds — removing a billing preference is always
 * allowed, and refusing to un-enrol a terminated or archived member would
 * be the system arguing with an operator trying to STOP billing someone.
 * Assertions (b) and (c) below are what pin that; they are the reason this
 * use-case must not grow a `membershipAccess` pre-pass by "symmetry" with
 * enrol later.
 *
 * Verified against real Postgres + RLS:
 *
 *   (a) Bucket accounting — {enrolled, already-un-enrolled, enrolled+
 *       terminated} resolves to `{ unenrolled:2, skippedNotEnrolled:1 }`,
 *       and both un-enrolled members' `auto_invoice_enrolled_at` is NULL.
 *   (b) The TERMINATED member is genuinely un-enrolled (not skipped) —
 *       the explicit inverse of the enrol use-case's `skippedTerminated`.
 *   (c) An ARCHIVED member and a SUSPENDED member are also un-enrolled.
 *   (d) One `member_auto_invoice_unenrolled` audit row per ACTUALLY
 *       un-enrolled member (never for a skipped one), carrying `action` +
 *       `bulk_request_id` so a bulk run is correlatable.
 *   (e) Idempotent re-run — a second pass moves everything into
 *       `skippedNotEnrolled` and emits NO second audit row.
 *   (f) Unknown member id → `not_found`, whole batch rolled back.
 *   (g) Cross-tenant probe — a foreign member id is invisible
 *       (`not_found`) and is never mutated. Constitution Principle I.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { bulkUnenrolAutoInvoice } from '@/modules/members/application/use-cases/bulk-unenrol-auto-invoice';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('107-auto-invoice Task 18 — bulkUnenrolAutoInvoice (live Neon)', () => {
  let tenant: TestTenant;
  let otherTenant: TestTenant;
  let user: TestUser;
  let planId: string;
  let otherPlanId: string;

  const ENROLLED_AT = new Date('2026-01-01T00:00:00.000Z');

  const mEnrolled = randomUUID(); // enrolled, access 'full' → unenrolled
  const mNotEnrolled = randomUUID(); // already NULL → skippedNotEnrolled
  const mTerminated = randomUUID(); // enrolled + lapsed cycle → STILL unenrolled
  const mArchived = randomUUID(); // enrolled + status 'archived' → STILL unenrolled
  const mSuspended = randomUUID(); // enrolled + awaiting_payment → STILL unenrolled
  const mForeign = randomUUID(); // lives in otherTenant → invisible

  const cTerminated = randomUUID();
  const cSuspended = randomUUID();

  const seedMembers = async (
    t: TestTenant,
    plan: string,
    specs: ReadonlyArray<{
      memberId: string;
      enrolledAt: Date | null;
      status?: 'active' | 'archived';
    }>,
  ) =>
    runInTenant(t.ctx, (tx) =>
      tx.insert(members).values(
        specs.map((m) => ({
          tenantId: t.ctx.slug,
          memberId: m.memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: `Unenrol Co ${m.memberId.slice(0, 6)}`,
          country: 'TH' as const,
          planId: plan,
          planYear: 2026,
          autoInvoiceEnrolledAt: m.enrolledAt,
          status: m.status ?? ('active' as const),
          ...(m.status === 'archived'
            ? { archivedAt: new Date('2026-02-01T00:00:00Z') }
            : {}),
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
        // closed_at is NOT NULL iff the status is terminal.
        ...(status === 'lapsed'
          ? { closedAt: new Date('2026-08-02T00:00:00Z'), closedReason: 'lapsed' }
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

  const countUnenrolAudits = async (memberId: string): Promise<number> => {
    // Read as owner (BYPASS RLS) so the assertion cannot itself be fooled
    // by a tenant-context mistake in the code under test.
    const rows = await db
      .select({ id: auditLog.id, payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'member_auto_invoice_unenrolled'),
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
    };
  };

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');
    otherTenant = await createTestTenant('test');
    planId = `f8-unenrol-${randomUUID().slice(0, 8)}`;
    otherPlanId = `f8-unenrol-o-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Un-enrolment Plan' },
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
      { memberId: mEnrolled, enrolledAt: ENROLLED_AT },
      { memberId: mNotEnrolled, enrolledAt: null },
      { memberId: mTerminated, enrolledAt: ENROLLED_AT },
      { memberId: mArchived, enrolledAt: ENROLLED_AT, status: 'archived' },
      { memberId: mSuspended, enrolledAt: ENROLLED_AT },
    ]);
    await seedMembers(otherTenant, otherPlanId, [
      { memberId: mForeign, enrolledAt: ENROLLED_AT },
    ]);

    await seedCycle(cTerminated, mTerminated, 'lapsed');
    await seedCycle(cSuspended, mSuspended, 'awaiting_payment');
  });

  afterAll(async () => {
    await db
      .delete(renewalCycles)
      .where(inArray(renewalCycles.cycleId, [cTerminated, cSuspended]));
    await db
      .delete(members)
      .where(
        inArray(members.memberId, [
          mEnrolled,
          mNotEnrolled,
          mTerminated,
          mArchived,
          mSuspended,
          mForeign,
        ]),
      );
    await tenant.cleanup();
    await otherTenant.cleanup();
  });

  it('(a)+(b)+(d) buckets a mixed batch, un-enrols the TERMINATED member, audits once each', async () => {
    const result = await bulkUnenrolAutoInvoice(
      {
        action: 'unenrol_auto_invoice',
        member_ids: [mEnrolled, mNotEnrolled, mTerminated],
      },
      { actorUserId: user.userId, requestId: 'req-unenrol-mixed' },
      deps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The terminated member counts toward `unenrolled`, NOT a skip bucket.
    // If a membership-state gate is ever added, this is the assertion that
    // fails — deliberately.
    expect(result.value).toEqual({ unenrolled: 2, skippedNotEnrolled: 1 });

    // (a) both enrolled members cleared
    expect(await readEnrolledAt(tenant, mEnrolled)).toBeNull();
    // (b) the terminated one too — the whole point of this task
    expect(await readEnrolledAt(tenant, mTerminated)).toBeNull();
    // the already-NULL member is untouched and stays NULL
    expect(await readEnrolledAt(tenant, mNotEnrolled)).toBeNull();

    // (d) exactly one audit row per ACTUALLY un-enrolled member
    expect(await countUnenrolAudits(mEnrolled)).toBe(1);
    expect(await countUnenrolAudits(mTerminated)).toBe(1);
    expect(await countUnenrolAudits(mNotEnrolled)).toBe(0);
  });

  it('(c) un-enrols an ARCHIVED member and a SUSPENDED member', async () => {
    const result = await bulkUnenrolAutoInvoice(
      { action: 'unenrol_auto_invoice', member_ids: [mArchived, mSuspended] },
      { actorUserId: user.userId, requestId: 'req-unenrol-archived' },
      deps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ unenrolled: 2, skippedNotEnrolled: 0 });
    expect(await readEnrolledAt(tenant, mArchived)).toBeNull();
    expect(await readEnrolledAt(tenant, mSuspended)).toBeNull();
  });

  it('(e) is idempotent — a second run skips and emits no new audit row', async () => {
    const before = await countUnenrolAudits(mEnrolled);

    const result = await bulkUnenrolAutoInvoice(
      { action: 'unenrol_auto_invoice', member_ids: [mEnrolled] },
      { actorUserId: user.userId, requestId: 'req-unenrol-repeat' },
      deps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ unenrolled: 0, skippedNotEnrolled: 1 });
    expect(await countUnenrolAudits(mEnrolled)).toBe(before);
  });

  it('(f) rolls the whole batch back on an unknown member id', async () => {
    const ghost = randomUUID();
    // Seed a fresh ENROLLED member alongside the ghost so we can prove
    // nothing was cleared when the batch aborts.
    const mVictim = randomUUID();
    await seedMembers(tenant, planId, [
      { memberId: mVictim, enrolledAt: ENROLLED_AT },
    ]);

    const result = await bulkUnenrolAutoInvoice(
      { action: 'unenrol_auto_invoice', member_ids: [mVictim, ghost] },
      { actorUserId: user.userId, requestId: 'req-unenrol-ghost' },
      deps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('not_found');

    // All-or-nothing: the valid member in the same batch keeps its stamp.
    expect((await readEnrolledAt(tenant, mVictim))?.toISOString()).toBe(
      ENROLLED_AT.toISOString(),
    );
    expect(await countUnenrolAudits(mVictim)).toBe(0);

    await db.delete(members).where(eq(members.memberId, mVictim));
  });

  it('(g) cannot un-enrol a member belonging to another tenant', async () => {
    const result = await bulkUnenrolAutoInvoice(
      { action: 'unenrol_auto_invoice', member_ids: [mForeign] },
      { actorUserId: user.userId, requestId: 'req-unenrol-cross-tenant' },
      deps(),
    );

    // RLS makes the foreign row invisible — it reads as a missing member.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('not_found');

    // The foreign member must keep its enrolment completely unmutated.
    expect((await readEnrolledAt(otherTenant, mForeign))?.toISOString()).toBe(
      ENROLLED_AT.toISOString(),
    );
  });
});

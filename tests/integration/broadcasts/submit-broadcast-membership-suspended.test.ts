/**
 * 059-membership-suspension Task 5 — live-Neon WIRING test for
 * `submitBroadcast` precondition (l): membership access.
 *
 * This is the test the feature's own post-mortem demands. The gate
 * exists to close a bug class where a benefit-suspension check compiles,
 * is unit-testable in isolation, and is STILL never reached in
 * production because nobody wired it into the composition root. So this
 * test does NOT construct a `MembershipAccessPort` stub — it calls the
 * REAL `makeSubmitBroadcastDeps()` factory (the exact composition root
 * every route + `proxySubmitBroadcast` delegates through) against a real
 * member with a real F8 `renewal_cycles` row on live Neon.
 *
 * Cross-module chain under test (all real, no mocks):
 *   submitBroadcast → deps.membershipAccess.getMembershipAccess()
 *     → membershipAccessBridge (F7 infra)
 *       → makeDrizzleRenewalCycleRepo.findLatestCycleForMember (F8 infra)
 *         → deriveMembershipAccess (F8 domain, pure predicate)
 *
 * `awaiting_payment` is used (not `lapsed`) because `deriveMembershipAccess`
 * treats it as UNCONDITIONALLY suspended (reason 'unpaid') regardless of
 * `expiresAt` — the simplest real seed that proves the gate without also
 * having to engineer an expired period boundary.
 *
 * Constitution Principle II (test-first) — this file is the acceptance
 * test proving the wiring, independent of
 * `tests/unit/broadcasts/submit-broadcast-membership.test.ts` (pure
 * unit coverage of the precondition's branches with a stub port).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { submitBroadcast, makeSubmitBroadcastDeps } from '@/modules/broadcasts';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('submitBroadcast — membership-access wiring (live Neon, 059 Task 5)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    planId = `f7-membership-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Membership-Suspended Wiring Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  async function seedMember(companyName: string): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName,
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    return memberId;
  }

  async function countBroadcastRowsForMember(memberId: string): Promise<number> {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(broadcasts)
        .where(
          and(
            eq(broadcasts.tenantId, tenant.ctx.slug),
            eq(broadcasts.requestedByMemberId, memberId),
          ),
        ),
    );
    return rows.length;
  }

  it('member whose LATEST cycle is awaiting_payment (suspended, NOT halted) → submit blocked, zero quota rows created', async () => {
    const memberId = await seedMember('Suspended Wiring Co');

    const periodFrom = new Date('2026-01-01T00:00:00Z');
    const periodTo = new Date('2027-01-01T00:00:00Z');
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'awaiting_payment',
        periodFrom,
        periodTo,
        expiresAt: periodTo,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      }),
    );

    // REAL composition root — no mocked MembershipAccessPort. Proves
    // the gate is wired into the actual production dependency graph
    // that every route (and proxySubmitBroadcast) delegates through,
    // not merely callable in isolation against a hand-built stub.
    const deps = makeSubmitBroadcastDeps(tenant.ctx.slug);

    const result = await submitBroadcast(deps, {
      memberId,
      submittedByUserId: user.userId,
      actorRole: 'member_self_service',
      tenantDisplayName: 'Test Chamber',
      memberDisplayName: 'Suspended Wiring Co',
      subject: 'Should never send',
      bodySource: 'plain',
      bodyHtml: '<p>Should never send</p>',
      segment: { kind: 'all_members' },
      scheduledFor: null,
      requestId: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_membership_suspended_blocked');
    }

    // No quota row reserved — a `broadcasts` row IS the quota
    // reservation (draft/submitted rows count toward
    // countForMemberQuota's `submittedOrApproved` bucket). Zero rows
    // for this member proves the suspended path never reached
    // `insertDraft` — the whole point of gating BEFORE rate-limit/plan/
    // quota, not after.
    expect(await countBroadcastRowsForMember(memberId)).toBe(0);

    // 059-membership-suspension Task 8 — proves the
    // `broadcast_membership_suspended_blocked` enum value exists live
    // (migration 0245) AND that the real `f7AuditAdapter` (wired via
    // `makeSubmitBroadcastDeps`, no mock) actually persisted the row.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'broadcast_membership_suspended_blocked'),
        ),
      );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.payload).toMatchObject({ memberId });
  });

  it('member with a lapsed (ended-terminal) LATEST cycle → also blocked (access=terminated)', async () => {
    const memberId = await seedMember('Terminated Wiring Co');

    // Terminal + expired-in-the-past → deriveMembershipAccess resolves
    // 'terminated' (not merely 'suspended'). The precondition's
    // `access !== 'full'` check must catch this arm too.
    const periodFrom = new Date('2024-01-01T00:00:00Z');
    const periodTo = new Date('2025-01-01T00:00:00Z');
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'lapsed',
        periodFrom,
        periodTo,
        expiresAt: periodTo,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        closedAt: periodTo,
        closedReason: 'lapsed',
      }),
    );

    const deps = makeSubmitBroadcastDeps(tenant.ctx.slug);
    const result = await submitBroadcast(deps, {
      memberId,
      submittedByUserId: user.userId,
      actorRole: 'member_self_service',
      tenantDisplayName: 'Test Chamber',
      memberDisplayName: 'Terminated Wiring Co',
      subject: 'Should never send',
      bodySource: 'plain',
      bodyHtml: '<p>Should never send</p>',
      segment: { kind: 'all_members' },
      scheduledFor: null,
      requestId: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_membership_suspended_blocked');
    }
    expect(await countBroadcastRowsForMember(memberId)).toBe(0);
  });

  it('member with NO renewal cycle at all → full access (control — precondition (l) does not block; reaches quota reservation)', async () => {
    const memberId = await seedMember('Good-Standing Wiring Co');

    const deps = makeSubmitBroadcastDeps(tenant.ctx.slug);
    const result = await submitBroadcast(deps, {
      memberId,
      submittedByUserId: user.userId,
      actorRole: 'member_self_service',
      tenantDisplayName: 'Test Chamber',
      memberDisplayName: 'Good-Standing Wiring Co',
      subject: 'Fine to send',
      bodySource: 'plain',
      bodyHtml: '<p>Fine to send</p>',
      segment: { kind: 'all_members' },
      scheduledFor: null,
      requestId: null,
    });

    // Control: must NOT be blocked by precondition (l). It may still be
    // rejected further downstream (e.g. empty segment — this tenant has
    // no other members to receive the broadcast) — the assertion here
    // is narrowly that the membership-access kind never fires for a
    // member with no cycle at all (F8 default: no cycle = 'full').
    if (!result.ok) {
      expect(result.error.kind).not.toBe('broadcast_membership_suspended_blocked');
    }
  });
});

/**
 * 059-membership-suspension task-19b (final gate sweep) — live-Neon WIRING
 * test for `inviteColleague`'s Task 6 membership-access gate.
 *
 * `tests/unit/members/invite-colleague-membership.test.ts` proves the gate's
 * BRANCHES against a hand-built `MembershipAccessPort` stub. That is
 * necessary but not sufficient — it can never catch the composition-root
 * bug class where the gate compiles, is unit-testable in isolation, and is
 * STILL never reached in production because nobody wired the real adapter
 * into `buildMembersDeps`. This file is the feature's own discipline
 * applied to F3: prove the gate is actually wired, not just the branch.
 *
 * Modelled directly on the F7 sibling wiring test,
 * `tests/integration/broadcasts/submit-broadcast-membership-suspended.test.ts`
 * (059-membership-suspension Task 5) — same shape, same real-deps
 * discipline, ported to F3's composition root.
 *
 * Cross-module chain under test (all real, no mocks):
 *   inviteColleague → deps.membershipAccess.getMembershipAccess()
 *     → membershipAccessBridge (F3 infra — its OWN copy, not F7's; see
 *       `src/modules/members/infrastructure/membership-access-bridge.ts`)
 *       → makeDrizzleRenewalCycleRepo.findLatestCycleForMember (F8 infra)
 *         → deriveMembershipAccess (F8 domain, pure predicate)
 *
 * `deps = buildMembersDeps(tenant.ctx)` is the exact composition root every
 * `/api/portal/**` colleague-invite route delegates through — no mocked
 * `MembershipAccessPort` here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { inviteColleague } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('inviteColleague — membership-access wiring (live Neon, 059 task-19b)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  let actorUser: TestUser;
  let planId: string;
  const sfx = randomUUID().slice(0, 8);

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    actorUser = await createActiveTestUser('member');
    tenant = await createTestTenant('test-swecham');
    planId = `f3-membership-${sfx}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Membership-Suspended Colleague-Invite Wiring Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(actorUser).catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 60_000);

  /**
   * Seeds a fresh member + its actor contact (the F3 primary-contact
   * check that runs immediately AFTER the membership-access gate).
   * `isPrimary: false` is used by the control case below to prove the
   * gate let the request through to the NEXT precondition.
   */
  async function seedMemberWithActorContact(opts: {
    companyName: string;
    isPrimary: boolean;
  }): Promise<{ memberId: string; actorContactId: string }> {
    const memberId = randomUUID();
    const actorContactId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: opts.companyName,
        country: 'TH',
        planId,
        planYear: 2026,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: actorContactId,
        memberId,
        firstName: 'Actor',
        lastName: 'Contact',
        email: `actor-${actorContactId.slice(0, 8)}@swecham.test`,
        preferredLanguage: 'en',
        isPrimary: opts.isPrimary,
        linkedUserId: actorUser.userId,
        removedAt: null,
      });
    });
    return { memberId, actorContactId };
  }

  async function countUsersWithEmail(email: string): Promise<number> {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email.toLowerCase()));
    return rows.length;
  }

  it('member whose LATEST cycle is awaiting_payment (suspended, NOT halted) → invite blocked, zero accounts provisioned', async () => {
    const { memberId, actorContactId } = await seedMemberWithActorContact({
      companyName: 'Suspended Colleague-Invite Co',
      isPrimary: true,
    });

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

    // REAL composition root — no mocked MembershipAccessPort. Proves the
    // gate is wired into the actual production dependency graph every
    // colleague-invite route delegates through, not merely callable in
    // isolation against a hand-built stub.
    const deps = buildMembersDeps(tenant.ctx);
    const inviteeEmail = `suspended-invite-${sfx}@swecham.test`;

    const result = await inviteColleague(deps, {
      memberId: memberId as never,
      actorUserId: actorUser.userId,
      actorContactId: actorContactId as never,
      sourceIp: '203.0.113.10',
      requestId: `it-membership-suspended-${sfx}`,
      body: {
        first_name: 'Should',
        last_name: 'NeverInvite',
        email: inviteeEmail,
        preferred_language: 'en',
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('membership_suspended');
    }

    // No F1 account was provisioned — the whole point of gating BEFORE the
    // actor-primary lookup and BEFORE createUser, not after. A suspended
    // member's colleague-invite must never reach account-provisioning.
    expect(await countUsersWithEmail(inviteeEmail)).toBe(0);
  }, 60_000);

  it('member with a lapsed (ended-terminal) LATEST cycle → also blocked (access=terminated), zero accounts provisioned', async () => {
    const { memberId, actorContactId } = await seedMemberWithActorContact({
      companyName: 'Terminated Colleague-Invite Co',
      isPrimary: true,
    });

    // Terminal + expired-in-the-past → deriveMembershipAccess resolves
    // 'terminated' (not merely 'suspended'). inviteColleague's
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

    const deps = buildMembersDeps(tenant.ctx);
    const inviteeEmail = `terminated-invite-${sfx}@swecham.test`;

    const result = await inviteColleague(deps, {
      memberId: memberId as never,
      actorUserId: actorUser.userId,
      actorContactId: actorContactId as never,
      sourceIp: '203.0.113.11',
      requestId: `it-membership-terminated-${sfx}`,
      body: {
        first_name: 'Should',
        last_name: 'AlsoNeverInvite',
        email: inviteeEmail,
        preferred_language: 'en',
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('membership_suspended');
    }
    expect(await countUsersWithEmail(inviteeEmail)).toBe(0);
  }, 60_000);

  it('member with NO renewal cycle at all → full access (control — the gate does not block; reaches the next precondition, actor-primary check)', async () => {
    // isPrimary: false — deterministically reaches (and fails at) the very
    // NEXT precondition after the membership gate, without having to run
    // the full createUser pipeline (and its account cleanup) just to prove
    // the gate itself let the request through.
    const { memberId, actorContactId } = await seedMemberWithActorContact({
      companyName: 'Good-Standing Colleague-Invite Co',
      isPrimary: false,
    });

    const deps = buildMembersDeps(tenant.ctx);
    const inviteeEmail = `good-standing-invite-${sfx}@swecham.test`;

    const result = await inviteColleague(deps, {
      memberId: memberId as never,
      actorUserId: actorUser.userId,
      actorContactId: actorContactId as never,
      sourceIp: '203.0.113.12',
      requestId: `it-membership-full-${sfx}`,
      body: {
        first_name: 'Fine',
        last_name: 'ToInvite',
        email: inviteeEmail,
        preferred_language: 'en',
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Control: must NOT be blocked by the membership-access gate. It IS
      // still rejected — by the very next precondition (actor must be the
      // primary contact) — proving the gate passed the request through
      // rather than merely never being reached.
      expect(result.error.type).not.toBe('membership_suspended');
      expect(result.error.type).toBe('not_primary');
    }
    expect(await countUsersWithEmail(inviteeEmail)).toBe(0);
  }, 60_000);
});

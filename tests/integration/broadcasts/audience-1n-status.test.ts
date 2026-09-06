/**
 * 108 PR-C T068 (US3 s1–s6, FR-020–FR-022, FR-029, SC-003, SC-009) — the 1:N
 * audience on live Neon through the REAL F7→F3 bridge (`membersBridge`),
 * the real contacts/members repos under RLS and the real suppression repo,
 * on BOTH resolver legs. No fixture sits in the path that decides who
 * receives a broadcast.
 *
 * Pinned:
 *   - `primary_only` (flag OFF): one primary per ELIGIBLE member — the
 *     `status = 'active'` predicate ships unflagged (FR-021 / SC-009), so an
 *     inactive, archived, erased or halted member's primary is out on this
 *     leg too, and the F3 read no longer truncates at 5,000 (research R8):
 *     5,001 eligible members is `broadcast_audience_too_large`, not a silent
 *     5,000;
 *   - `all_contacts` (flag ON): every live, not-opted-out contact of every
 *     eligible member, minus suppression, minus EVERY contact of the sender;
 *   - the same rules on a tier-filtered segment (US3 s6);
 *   - an opted-out-only member is an orphan on the ON leg and a
 *     `droppedByPreference` on the OFF leg (the PR-D pin, per mode).
 *
 * Simulated addresses only — no real PII.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { resolveSegmentRecipients, type ResolveSegmentInput } from '@/modules/broadcasts';
import { membersBridge } from '@/modules/broadcasts/infrastructure/members-bridge';
import { makeDrizzleMarketingUnsubscribesRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-marketing-unsubscribes-repo';
import { eventAttendeesStub } from '@/modules/broadcasts/infrastructure/event-attendees-stub';
import { marketingUnsubscribes } from '@/modules/broadcasts/infrastructure/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { seedPortalPlan } from '../helpers/portal-seed';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

type ContactSpec = {
  readonly email: string;
  readonly isPrimary: boolean;
  readonly optOut?: 'staff' | 'self';
};

async function seedMember(
  tenant: TestTenant,
  planId: string,
  specs: readonly ContactSpec[],
  member: { status?: 'active' | 'inactive' | 'archived'; halted?: boolean; erased?: boolean } = {},
  byUserId = '',
): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `1N ${memberId.slice(0, 6)}`,
      country: 'TH',
      planId,
      planYear: 2026,
      status: member.status ?? 'active',
      archivedAt: member.status === 'archived' ? new Date() : null,
      erasedAt: member.erased ? new Date() : null,
      broadcastsHaltedUntilAdminReview: member.halted ?? false,
    });
    if (specs.length === 0) return;
    await tx.insert(contacts).values(
      specs.map((s) => ({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Sim',
        lastName: s.email.slice(0, 6),
        email: s.email,
        preferredLanguage: 'en' as const,
        isPrimary: s.isPrimary,
        removedAt: null,
        marketingOptOutAt: s.optOut ? new Date('2026-09-01T00:00:00Z') : null,
        marketingOptOutSource: s.optOut ?? null,
        marketingOptOutByUserId: s.optOut ? byUserId : null,
      })),
    );
  });
  return memberId;
}

/** 5,001 active members with one primary each, batched (tenant B). */
async function seedBigAudience(tenant: TestTenant, planId: string, n: number, tag: string): Promise<void> {
  const CHUNK = 500;
  for (let start = 0; start < n; start += CHUNK) {
    const ids = Array.from({ length: Math.min(CHUNK, n - start) }, () => randomUUID());
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values(
        ids.map((memberId, i) => ({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: `Big ${start + i}`,
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active' as const,
          archivedAt: null,
        })),
      );
      await tx.insert(contacts).values(
        ids.map((memberId, i) => ({
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId,
          firstName: 'Big',
          lastName: String(start + i),
          email: `big-${start + i}-${tag}@example.test`,
          preferredLanguage: 'en' as const,
          isPrimary: true,
          removedAt: null,
        })),
      );
    });
  }
}

function deps(tenant: TestTenant, audienceMode: 'primary_only' | 'all_contacts') {
  return {
    tenant: tenant.ctx,
    membersBridge,
    eventAttendees: eventAttendeesStub,
    marketingUnsubscribes: makeDrizzleMarketingUnsubscribesRepo(tenant.ctx.slug),
    audienceMode,
    audienceCeiling: 5000,
  };
}

function input(over: Partial<ResolveSegmentInput> = {}): ResolveSegmentInput {
  return {
    segment: { kind: 'all_members' },
    phase: 'dispatch',
    requestingMemberId: null,
    customRecipients: null,
    ...over,
  };
}

const sorted = (xs: ReadonlyArray<string>): string[] => [...xs].sort();

describe('108 PR-C T068 — 1:N audience by member status, both legs (live Neon, real bridge)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;
  const corporatePlan = `1nc-${randomUUID().slice(0, 6)}`;
  const partnershipPlan = `1np-${randomUUID().slice(0, 6)}`;
  const tag = randomUUID().slice(0, 8);

  // Eligible members (tenant A)
  const p1 = `p1-${tag}@example.test`;
  const s1Unsub = `s1-unsub-${tag}@example.test`;
  const s2StaffOff = `s2-staffoff-${tag}@example.test`;
  const s3 = `s3-${tag}@example.test`;
  const p2 = `p2-${tag}@example.test`;
  const p3StaffOff = `p3-staffoff-${tag}@example.test`;
  const p9Partnership = `p9-${tag}@example.test`;
  const pSender = `sender-p-${tag}@example.test`;
  const sSender = `sender-s-${tag}@example.test`;
  // Ineligible members (tenant A) — their primaries must NEVER appear
  const p5Inactive = `p5-inactive-${tag}@example.test`;
  const p6Archived = `p6-archived-${tag}@example.test`;
  const p7Erased = `p7-erased-${tag}@example.test`;
  const p8Halted = `p8-halted-${tag}@example.test`;
  const never = [p5Inactive, p6Archived, p7Erased, p8Halted];

  let m3: string;
  let sender: string;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;
    await seedPortalPlan(tenantA.ctx.slug, admin.userId, corporatePlan);
    await seedPortalPlan(tenantB.ctx.slug, admin.userId, corporatePlan);
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenantA.ctx.slug,
        planId: partnershipPlan,
        planYear: 2026,
        planName: { en: '1N Partnership Plan' },
        description: { en: 'Test description' },
        sortOrder: 20,
        planCategory: 'partnership',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 500_000,
        includesCorporatePlanId: corporatePlan,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        isActive: true,
        createdBy: admin.userId,
        updatedBy: admin.userId,
      }),
    );
    const u = admin.userId;
    await seedMember(tenantA, corporatePlan, [
      { email: p1, isPrimary: true },
      { email: s1Unsub, isPrimary: false },
      { email: s2StaffOff, isPrimary: false, optOut: 'staff' },
      { email: s3, isPrimary: false },
    ], {}, u);
    await seedMember(tenantA, corporatePlan, [{ email: p2, isPrimary: true }]);
    m3 = await seedMember(tenantA, corporatePlan, [{ email: p3StaffOff, isPrimary: true, optOut: 'staff' }], {}, u);
    await seedMember(tenantA, partnershipPlan, [{ email: p9Partnership, isPrimary: true }]);
    sender = await seedMember(tenantA, corporatePlan, [
      { email: pSender, isPrimary: true },
      { email: sSender, isPrimary: false },
    ]);
    await seedMember(tenantA, corporatePlan, [{ email: p5Inactive, isPrimary: true }], { status: 'inactive' });
    await seedMember(tenantA, corporatePlan, [{ email: p6Archived, isPrimary: true }], { status: 'archived' });
    await seedMember(tenantA, corporatePlan, [{ email: p7Erased, isPrimary: true }], { erased: true });
    await seedMember(tenantA, corporatePlan, [{ email: p8Halted, isPrimary: true }], { halted: true });
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(marketingUnsubscribes).values({
        tenantId: tenantA.ctx.slug,
        emailLower: s1Unsub,
        memberId: null,
        reason: 'recipient_initiated',
        reasonText: null,
        sourceBroadcastId: null,
        sourceTokenHash: null,
      }),
    );
    await seedBigAudience(tenantB, corporatePlan, 5001, tag);
  }, 300_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 300_000);

  it('primary_only (flag OFF): one primary per ELIGIBLE member — inactive / archived / erased / halted are out (FR-021, SC-009)', async () => {
    const r = await resolveSegmentRecipients(deps(tenantA, 'primary_only'), input({ requestingMemberId: sender }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(sorted(r.value.recipients)).toEqual(sorted([p1, p2, p9Partnership]));
    for (const e of never) expect(r.value.recipients).not.toContain(e);
    // The opted-out primary of m3 is a preference drop on this leg (PR-D pin).
    expect(r.value.droppedByPreference).toBe(1);
    expect(r.value.orphans).toEqual([]);
  });

  it('all_contacts (flag ON): every eligible contact of every eligible member, minus suppression and ALL of the sender\'s contacts (US3 s1–s5)', async () => {
    const r = await resolveSegmentRecipients(deps(tenantA, 'all_contacts'), input({ requestingMemberId: sender }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(sorted(r.value.recipients)).toEqual(sorted([p1, s3, p2, p9Partnership]));
    expect(r.value.recipients).not.toContain(s1Unsub);
    expect(r.value.recipients).not.toContain(s2StaffOff);
    expect(r.value.recipients).not.toContain(pSender);
    expect(r.value.recipients).not.toContain(sSender);
    for (const e of never) expect(r.value.recipients).not.toContain(e);
    // m3's only contact is opted out → excluded in SQL → the member is an
    // orphan (FR-029), not a preference drop.
    expect(r.value.orphans).toEqual([m3]);
    expect(r.value.droppedByPreference).toBe(0);
  });

  it('tier: the same contact rules apply to members of the selected tiers only, on both legs (US3 s6)', async () => {
    const off = await resolveSegmentRecipients(
      deps(tenantA, 'primary_only'),
      input({ segment: { kind: 'tier', tierCodes: ['corporate'] }, requestingMemberId: sender }),
    );
    expect(off.ok).toBe(true);
    if (off.ok) expect(sorted(off.value.recipients)).toEqual(sorted([p1, p2]));

    const on = await resolveSegmentRecipients(
      deps(tenantA, 'all_contacts'),
      input({ segment: { kind: 'tier', tierCodes: ['corporate'] }, requestingMemberId: sender }),
    );
    expect(on.ok).toBe(true);
    if (on.ok) expect(sorted(on.value.recipients)).toEqual(sorted([p1, s3, p2]));

    const partnership = await resolveSegmentRecipients(
      deps(tenantA, 'all_contacts'),
      input({ segment: { kind: 'tier', tierCodes: ['partnership'] } }),
    );
    expect(partnership.ok).toBe(true);
    if (partnership.ok) expect(partnership.value.recipients).toEqual([p9Partnership]);
  });

  it('primary_only: the F3 read no longer truncates — 5,001 eligible members is broadcast_audience_too_large, never a silent 5,000 (research R8)', async () => {
    const r = await resolveSegmentRecipients(deps(tenantB, 'primary_only'), input());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toEqual({ kind: 'broadcast_audience_too_large', count: 5001, cap: 5000 });
  }, 120_000);
});

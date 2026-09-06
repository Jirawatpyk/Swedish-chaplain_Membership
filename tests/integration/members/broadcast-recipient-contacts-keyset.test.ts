/**
 * 108 PR-C T071 (US3 / FR-020, FR-021, FR-022, FR-029, FR-052) — the F3 side
 * of the 1:N marketing audience on live Neon: `findBroadcastRecipientContacts`
 * through the `getBroadcastRecipientContacts` use case and the real Drizzle
 * repo under RLS.
 *
 * Pinned (data-model § 1, research R8):
 *   - member eligibility: `status = 'active'`, not erased, not halted (+ tier);
 *     inactive / archived / erased / halted members contribute NO rows;
 *   - contact eligibility: `removed_at IS NULL AND marketing_opt_out_at IS NULL`
 *     (staff AND self opt-outs are excluded in the SQL);
 *   - LEFT JOIN: an eligible member with ZERO eligible contacts surfaces as ONE
 *     row with a null contact (FR-029 orphan) — both "no contacts at all" and
 *     "every contact opted out"; a member whose PRIMARY opted out but has a
 *     live secondary is NOT an orphan (FR-029: never merely for lacking a
 *     primary);
 *   - keyset order `(member_id, contact_id)`, resumable from a cursor INSIDE a
 *     member and from a cursor that names an orphan row (null contact id) —
 *     the case where a page boundary falls exactly on an orphan;
 *   - no hidden cap: `limit` is the only bound;
 *   - `email_lower` is lower-cased in the SQL (the stored address may be mixed
 *     case);
 *   - cross-tenant isolation (FR-052): a second tenant's contacts never appear.
 *
 * Simulated addresses only — no real PII.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { drizzleMemberRepo, getBroadcastRecipientContacts } from '@/modules/members';
import type { F7ContactRecipient } from '@/modules/members/application/ports/member-repo';
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

/**
 * Deterministic ids: every member id in this run shares one random 34-char
 * prefix and differs only in its last two hex digits, so the keyset order is
 * known up front (uuid sorts byte-wise = hex-string order). Contact ids the
 * same, under a second prefix.
 */
const memberBase = randomUUID().slice(0, 34);
const contactBase = randomUUID().slice(0, 34);
const mid = (n: number): string => `${memberBase}${n.toString(16).padStart(2, '0')}`;
const cid = (n: number): string => `${contactBase}${n.toString(16).padStart(2, '0')}`;

type ContactSpec = {
  readonly id: string;
  readonly isPrimary: boolean;
  readonly email?: string;
  readonly removed?: boolean;
  readonly optOut?: 'staff' | 'self';
};

async function seedMember(
  tenant: TestTenant,
  memberId: string,
  planId: string,
  specs: readonly ContactSpec[],
  member: {
    status?: 'active' | 'inactive' | 'archived';
    halted?: boolean;
    erased?: boolean;
  } = {},
  byUserId = '',
): Promise<void> {
  const tag = randomUUID().slice(0, 8);
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Keyset ${memberId.slice(-2)}`,
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
        contactId: s.id,
        memberId,
        firstName: 'Sim',
        lastName: s.id.slice(-2),
        email: s.email ?? `sim-${s.id.slice(-2)}-${tag}@example.test`,
        preferredLanguage: 'en' as const,
        isPrimary: s.isPrimary,
        removedAt: s.removed ? new Date('2026-05-01T00:00:00Z') : null,
        marketingOptOutAt: s.optOut ? new Date('2026-09-01T00:00:00Z') : null,
        marketingOptOutSource: s.optOut ?? null,
        marketingOptOutByUserId: s.optOut ? byUserId : null,
      })),
    );
  });
}

async function page(
  tenant: TestTenant,
  input: Parameters<typeof getBroadcastRecipientContacts>[1],
): Promise<readonly F7ContactRecipient[]> {
  const r = await getBroadcastRecipientContacts(
    { tenant: tenant.ctx, memberRepo: drizzleMemberRepo },
    input,
  );
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
}

const key = (r: F7ContactRecipient): readonly [string, string | null] => [
  r.memberId as string,
  r.contactId,
];

describe('108 PR-C T071 — broadcast recipient contacts, keyset (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;
  const corporatePlan = `kc-${randomUUID().slice(0, 6)}`;
  const partnershipPlan = `kp-${randomUUID().slice(0, 6)}`;
  const mixedCaseEmail = `M1.Primary-${randomUUID().slice(0, 8)}@Example.TEST`;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;
    await seedPortalPlan(tenantA.ctx.slug, admin.userId, corporatePlan);
    await seedPortalPlan(tenantB.ctx.slug, admin.userId, corporatePlan);
    // A second tier in tenant A so the tier filter has something to exclude.
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenantA.ctx.slug,
        planId: partnershipPlan,
        planYear: 2026,
        planName: { en: 'Keyset Partnership Plan' },
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
    // m01: primary on (mixed-case address) · secondary on · staff-off ·
    // self-off · removed → TWO eligible rows.
    await seedMember(tenantA, mid(1), corporatePlan, [
      { id: cid(0x11), isPrimary: true, email: mixedCaseEmail },
      { id: cid(0x12), isPrimary: false },
      { id: cid(0x13), isPrimary: false, optOut: 'staff' },
      { id: cid(0x14), isPrimary: false, optOut: 'self' },
      { id: cid(0x15), isPrimary: false, removed: true },
    ], {}, u);
    // m02: no contacts at all → orphan row.
    await seedMember(tenantA, mid(2), corporatePlan, []);
    // m03: its only contact opted out → orphan row (no ELIGIBLE contact).
    await seedMember(tenantA, mid(3), corporatePlan, [
      { id: cid(0x31), isPrimary: true, optOut: 'staff' },
    ], {}, u);
    // m04: primary opted out, secondary live → one row, NOT an orphan (FR-029).
    await seedMember(tenantA, mid(4), corporatePlan, [
      { id: cid(0x41), isPrimary: true, optOut: 'self' },
      { id: cid(0x42), isPrimary: false },
    ], {}, u);
    // m05..m08: ineligible members, each with a live primary that must NOT appear.
    await seedMember(tenantA, mid(5), corporatePlan, [{ id: cid(0x51), isPrimary: true }], { status: 'inactive' });
    await seedMember(tenantA, mid(6), corporatePlan, [{ id: cid(0x61), isPrimary: true }], { status: 'archived' });
    await seedMember(tenantA, mid(7), corporatePlan, [{ id: cid(0x71), isPrimary: true }], { erased: true });
    await seedMember(tenantA, mid(8), corporatePlan, [{ id: cid(0x81), isPrimary: true }], { halted: true });
    // m09: partnership tier, primary on.
    await seedMember(tenantA, mid(9), partnershipPlan, [{ id: cid(0x91), isPrimary: true }]);
    // Tenant B: an active member with a live primary — never visible from A.
    await seedMember(tenantB, mid(0xb1), corporatePlan, [{ id: cid(0xb1), isPrimary: true }]);
  }, 120_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  const expectedAll: ReadonlyArray<readonly [string, string | null]> = [
    [mid(1), cid(0x11)],
    [mid(1), cid(0x12)],
    [mid(2), null],
    [mid(3), null],
    [mid(4), cid(0x42)],
    [mid(9), cid(0x91)],
  ];

  it('all_members, one page: eligible contacts of eligible members in (member_id, contact_id) order; ineligible members contribute nothing', async () => {
    const rows = await page(tenantA, { segmentType: 'all_members', after: null, limit: 1000 });
    expect(rows.map(key)).toEqual(expectedAll);
  });

  it('an eligible member with no eligible contact is ONE orphan row (null contact, null email, not primary)', async () => {
    const rows = await page(tenantA, { segmentType: 'all_members', after: null, limit: 1000 });
    const orphans = rows.filter((r) => r.contactId === null);
    expect(orphans.map((r) => r.memberId)).toEqual([mid(2), mid(3)]);
    for (const o of orphans) {
      expect(o.emailLower).toBeNull();
      expect(o.isPrimary).toBe(false);
    }
  });

  it('a member whose primary opted out but has a live secondary is a recipient row, not an orphan (FR-029)', async () => {
    const rows = await page(tenantA, { segmentType: 'all_members', after: null, limit: 1000 });
    const m4 = rows.filter((r) => r.memberId === mid(4));
    expect(m4.map(key)).toEqual([[mid(4), cid(0x42)]]);
    expect(m4[0]?.isPrimary).toBe(false);
  });

  it('reports isPrimary and lower-cases the stored address', async () => {
    const rows = await page(tenantA, { segmentType: 'all_members', after: null, limit: 1000 });
    const first = rows.find((r) => r.contactId === cid(0x11));
    expect(first?.isPrimary).toBe(true);
    expect(first?.emailLower).toBe(mixedCaseEmail.toLowerCase());
    expect(rows.find((r) => r.contactId === cid(0x12))?.isPrimary).toBe(false);
  });

  it('tier: the same contact rules apply to members of the selected tiers only', async () => {
    const corporate = await page(tenantA, {
      segmentType: 'tier',
      tierCodes: ['corporate'],
      after: null,
      limit: 1000,
    });
    expect(corporate.map(key)).toEqual(expectedAll.slice(0, 5));

    const partnership = await page(tenantA, {
      segmentType: 'tier',
      tierCodes: ['partnership'],
      after: null,
      limit: 1000,
    });
    expect(partnership.map(key)).toEqual([[mid(9), cid(0x91)]]);

    const both = await page(tenantA, {
      segmentType: 'tier',
      tierCodes: ['partnership', 'corporate'],
      after: null,
      limit: 1000,
    });
    expect(both.map(key)).toEqual(expectedAll);
  });

  it('keyset: pages of 3 walked to exhaustion equal the single page — a page boundary that falls ON an orphan row resumes correctly', async () => {
    const seen: Array<readonly [string, string | null]> = [];
    let after: { memberId: string; contactId: string | null } | null = null;
    let pages = 0;
    for (;;) {
      const rows = await page(tenantA, { segmentType: 'all_members', after, limit: 3 });
      pages += 1;
      if (rows.length === 0) break;
      expect(rows.length).toBeLessThanOrEqual(3);
      seen.push(...rows.map(key));
      const last = rows[rows.length - 1]!;
      after = { memberId: last.memberId as string, contactId: last.contactId };
      if (pages > 10) throw new Error('keyset did not terminate');
    }
    // Page 1 ends on the orphan m02 (contact null); page 2 starts at m03.
    expect(seen).toEqual(expectedAll);
    expect(pages).toBe(3);
  });

  it('keyset: a cursor INSIDE a member resumes at that member\'s next contact', async () => {
    const rows = await page(tenantA, {
      segmentType: 'all_members',
      after: { memberId: mid(1), contactId: cid(0x11) },
      limit: 1000,
    });
    expect(rows.map(key)).toEqual(expectedAll.slice(1));
  });

  it('no hidden cap: limit is the only bound', async () => {
    const two = await page(tenantA, { segmentType: 'all_members', after: null, limit: 2 });
    expect(two.map(key)).toEqual(expectedAll.slice(0, 2));
    const all = await page(tenantA, { segmentType: 'all_members', after: null, limit: 6 });
    expect(all).toHaveLength(6);
  });

  it('cross-tenant isolation (FR-052): tenant B sees only its own member; tenant A never sees B', async () => {
    const b = await page(tenantB, { segmentType: 'all_members', after: null, limit: 1000 });
    expect(b.map(key)).toEqual([[mid(0xb1), cid(0xb1)]]);
    const a = await page(tenantA, { segmentType: 'all_members', after: null, limit: 1000 });
    expect(a.some((r) => r.memberId === mid(0xb1))).toBe(false);
  });
});

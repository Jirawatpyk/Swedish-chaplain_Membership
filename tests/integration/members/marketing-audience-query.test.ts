/**
 * 108 PR-D T045 (US4 / FR-035, FR-035c, FR-052, SC-004) — the Marketing
 * audience query on live Neon, through the production composition
 * (`buildMarketingAudienceDeps`): every filter, the count, the 50-row pages,
 * cross-tenant isolation through the real RLS, and the 20,000-contact page-1
 * budget (SC-004: < 3 s at 20k).
 *
 * Simulated emails only — no real PII.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { buildMarketingAudienceDeps } from '@/lib/contact-marketing-deps';
import { asMemberId, listMarketingAudience } from '@/modules/members';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { marketingUnsubscribes } from '@/modules/broadcasts/infrastructure/schema';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedPortalPlan } from '../helpers/portal-seed';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

type Spec = {
  readonly first: string;
  readonly last: string;
  readonly isPrimary: boolean;
  readonly email?: string;
  readonly removed?: boolean;
  readonly optOut?: { readonly source: 'staff' | 'self'; readonly byUserId: string };
};

async function seedMember(
  tenant: TestTenant,
  planId: string,
  company: string,
  specs: readonly Spec[],
  member: { status?: 'active' | 'inactive' | 'archived'; halted?: boolean } = {},
): Promise<{ memberId: string; contactIds: string[] }> {
  const memberId = randomUUID();
  const contactIds = specs.map(() => randomUUID());
  const rand = randomUUID().slice(0, 8);
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: company,
      country: 'TH',
      planId,
      planYear: 2026,
      status: member.status ?? 'active',
      archivedAt: member.status === 'archived' ? new Date() : null,
      broadcastsHaltedUntilAdminReview: member.halted ?? false,
    });
    await tx.insert(contacts).values(
      specs.map((s, i) => ({
        tenantId: tenant.ctx.slug,
        contactId: contactIds[i]!,
        memberId,
        firstName: s.first,
        lastName: s.last,
        email: s.email ?? `${s.first}.${s.last}-${rand}@example.test`.toLowerCase(),
        preferredLanguage: 'en' as const,
        isPrimary: s.isPrimary,
        removedAt: s.removed ? new Date('2026-05-01T00:00:00Z') : null,
        marketingOptOutAt: s.optOut ? new Date('2026-09-01T00:00:00Z') : null,
        marketingOptOutSource: s.optOut?.source ?? null,
        marketingOptOutByUserId: s.optOut?.byUserId ?? null,
      })),
    );
  });
  return { memberId, contactIds };
}

describe('108 PR-D — Marketing audience query (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;
  const planId = `aud-${randomUUID().slice(0, 6)}`;
  const suppressedEmail = `sim-unsub-${randomUUID().slice(0, 8)}@example.test`;
  // Cycle 13 (whole-branch LOW-7): staff-off AND suppressed — the badge says
  // "unsubscribed" (precedence), so the off_by_staff filter must not list it.
  const staffOffSuppressedEmail = `sim-both-${randomUUID().slice(0, 8)}@example.test`;
  let acme: { memberId: string; contactIds: string[] };
  let beta: { memberId: string; contactIds: string[] };
  let gamma: { memberId: string; contactIds: string[] };
  let bMember: { memberId: string; contactIds: string[] };

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-swecham');
    await seedPortalPlan(tenantA.ctx.slug, admin.userId, planId);
    await seedPortalPlan(tenantB.ctx.slug, admin.userId, planId);

    // Acme (active): P1 primary on · S1 secondary off-by-staff · S2 secondary
    // suppressed · S3 removed (never listed) · S4 secondary on.
    acme = await seedMember(tenantA, planId, 'Acme Co', [
      { first: 'Prim', last: 'Ary', isPrimary: true },
      { first: 'Sec', last: 'Staffoff', isPrimary: false, optOut: { source: 'staff', byUserId: admin.userId } },
      { first: 'Sec', last: 'Unsub', isPrimary: false, email: suppressedEmail },
      {
        first: 'Sec',
        last: 'Both',
        isPrimary: false,
        email: staffOffSuppressedEmail,
        optOut: { source: 'staff', byUserId: admin.userId },
      },
      { first: 'Sec', last: 'Removed', isPrimary: false, removed: true },
      { first: 'Sec', last: 'Zed-on', isPrimary: false },
    ]);
    // Beta (inactive): one primary on.
    beta = await seedMember(tenantA, planId, 'Beta Ltd', [{ first: 'Bea', last: 'Primary', isPrimary: true }], {
      status: 'inactive',
    });
    // Gamma (active but halted): one primary, self-opted-out.
    gamma = await seedMember(
      tenantA,
      planId,
      'Gamma Inc',
      [{ first: 'Gam', last: 'Primary', isPrimary: true, optOut: { source: 'self', byUserId: admin.userId } }],
      { halted: true },
    );
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(marketingUnsubscribes).values(
        [suppressedEmail, staffOffSuppressedEmail].map((email) => ({
          tenantId: tenantA.ctx.slug,
          emailLower: email.toLowerCase(),
          memberId: null,
          reason: 'recipient_initiated' as const,
          reasonText: null,
          sourceBroadcastId: null,
          sourceTokenHash: null,
        })),
      ),
    );
    bMember = await seedMember(tenantB, planId, 'Other Tenant Co', [
      { first: 'Oth', last: 'Er', isPrimary: true },
    ]);
  }, 120_000);

  afterAll(async () => {
    await db
      .delete(marketingUnsubscribes)
      .where(eq(marketingUnsubscribes.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  it('default view (eligible, no state): Acme\'s five live contacts, ordered company → last name; count matches', async () => {
    const r = await listMarketingAudience(
      { filter: { eligible: true }, page: 1 },
      buildMarketingAudienceDeps(tenantA.ctx),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.degraded).toBe(false);
    expect(r.value.total).toBe(5);
    expect(r.value.rows.map((x) => [x.companyName, x.lastName, x.state])).toEqual([
      ['Acme Co', 'Ary', 'on'],
      ['Acme Co', 'Both', 'unsubscribed'],
      ['Acme Co', 'Staffoff', 'off_by_staff'],
      ['Acme Co', 'Unsub', 'unsubscribed'],
      ['Acme Co', 'Zed-on', 'on'],
    ]);
  });

  it('eligible=false lifts the member leg: Beta (inactive) and Gamma (halted) join, with reasons', async () => {
    const r = await listMarketingAudience(
      { filter: { eligible: false }, page: 1 },
      buildMarketingAudienceDeps(tenantA.ctx),
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.total).toBe(7);
    const beaRow = r.value.rows.find((x) => x.memberId === beta.memberId)!;
    expect(beaRow).toMatchObject({ memberStatus: 'inactive', reasons: ['member_inactive'], state: 'on' });
    const gamRow = r.value.rows.find((x) => x.memberId === gamma.memberId)!;
    expect(gamRow).toMatchObject({
      memberHalted: true,
      state: 'off_by_contact',
      reasons: ['member_halted', 'off_by_contact'],
      changedSource: 'self',
      changedByUserId: admin.userId,
    });
  });

  it('pre-flight preset (secondary, on, eligible): only the secondary that will actually receive', async () => {
    const r = await listMarketingAudience(
      { filter: { kind: 'secondary', state: 'on', eligible: true }, page: 1 },
      buildMarketingAudienceDeps(tenantA.ctx),
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.total).toBe(1);
    expect(r.value.rows.map((x) => x.lastName)).toEqual(['Zed-on']);
  });

  it('state=off_by_staff → the staff-opted-out secondary, with who/when', async () => {
    const r = await listMarketingAudience(
      { filter: { state: 'off_by_staff', eligible: true }, page: 1 },
      buildMarketingAudienceDeps(tenantA.ctx),
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.rows.map((x) => x.lastName)).toEqual(['Staffoff']);
    expect(r.value.rows[0]).toMatchObject({
      changedByUserId: admin.userId,
      changedSource: 'staff',
      changedAt: new Date('2026-09-01T00:00:00Z'),
    });
  });

  it('state=unsubscribed → the suppressed secondaries only (incl. the staff-off one: precedence)', async () => {
    const r = await listMarketingAudience(
      { filter: { state: 'unsubscribed', eligible: true }, page: 1 },
      buildMarketingAudienceDeps(tenantA.ctx),
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.total).toBe(2);
    expect(r.value.rows.map((x) => [x.lastName, x.state])).toEqual([
      ['Both', 'unsubscribed'],
      ['Unsub', 'unsubscribed'],
    ]);
  });

  it('state=off_by_staff never lists a suppressed address — the badge would say "unsubscribed" (cycle 13, LOW-7)', async () => {
    const r = await listMarketingAudience(
      { filter: { state: 'off_by_staff', eligible: true }, page: 1 },
      buildMarketingAudienceDeps(tenantA.ctx),
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.total).toBe(1);
    expect(r.value.rows.map((x) => x.lastName)).toEqual(['Staffoff']);
  });

  it('kind=primary + memberId narrow to one row; q matches company and contact names', async () => {
    const deps = buildMarketingAudienceDeps(tenantA.ctx);
    const byMember = await listMarketingAudience(
      { filter: { kind: 'primary', memberId: asMemberId(acme.memberId), eligible: true }, page: 1 },
      deps,
    );
    expect(byMember.ok && byMember.value.rows.map((x) => x.lastName)).toEqual(['Ary']);

    const byCompany = await listMarketingAudience({ filter: { q: 'gamma', eligible: false }, page: 1 }, deps);
    expect(byCompany.ok && byCompany.value.rows.map((x) => x.companyName)).toEqual(['Gamma Inc']);

    const byContact = await listMarketingAudience({ filter: { q: 'zed-on', eligible: true }, page: 1 }, deps);
    expect(byContact.ok && byContact.value.rows.map((x) => x.lastName)).toEqual(['Zed-on']);
  });

  it('FR-052: tenant B sees only its own contact; none of tenant A\'s', async () => {
    const r = await listMarketingAudience(
      { filter: { eligible: false }, page: 1 },
      buildMarketingAudienceDeps(tenantB.ctx),
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.total).toBe(1);
    expect(r.value.rows.map((x) => x.memberId)).toEqual([bMember.memberId]);
    expect(r.value.rows.some((x) => x.memberId === acme.memberId)).toBe(false);
  });
});

// Staff review T4: this block seeds 200 members × 100 contacts over 200
// sequential transactions and then asserts WALL CLOCK against a 3 s budget.
// That is a legitimate SC-004 check and a bad fit for `integration-smoke.yml`,
// which is REQUIRED on `main`, capped at 20 minutes, and runs against a
// freshly created (cold, unvacuumed) Neon branch. It runs in the nightly
// sweep instead, which sets `RUN_SCALE_TESTS=1` — a genuine run, not a skip.
describe.runIf(process.env.RUN_SCALE_TESTS === '1')('108 PR-D — Marketing audience pagination + SC-004 budget (live Neon)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const planId = `aud20k-${randomUUID().slice(0, 6)}`;
  const MEMBERS = 200;
  const CONTACTS_PER_MEMBER = 100; // 20,000 contacts

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPortalPlan(tenant.ctx.slug, admin.userId, planId);
    // Bulk seed: 200 members × 100 contacts, inserted per member in one tx
    // each (Neon handles ~100-row multi-VALUES inserts comfortably).
    for (let m = 0; m < MEMBERS; m += 1) {
      const memberId = randomUUID();
      const tag = `${m.toString().padStart(3, '0')}`;
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: `Scale Co ${tag}`,
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active',
        });
        await tx.insert(contacts).values(
          Array.from({ length: CONTACTS_PER_MEMBER }, (_, i) => ({
            tenantId: tenant.ctx.slug,
            contactId: randomUUID(),
            memberId,
            firstName: 'Bulk',
            lastName: `C${i.toString().padStart(3, '0')}`,
            email: `bulk-${tag}-${i}-${randomUUID().slice(0, 6)}@example.test`,
            preferredLanguage: 'en' as const,
            isPrimary: i === 0,
          })),
        );
      });
    }
  }, 600_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 300_000);

  it('page 1 of the default view returns 50 rows with the full count, under the 3 s SC-004 budget', async () => {
    const started = performance.now();
    const r = await listMarketingAudience(
      { filter: { eligible: true }, page: 1 },
      buildMarketingAudienceDeps(tenant.ctx),
    );
    const elapsedMs = performance.now() - started;
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.rows).toHaveLength(50);
    expect(r.value.total).toBe(MEMBERS * CONTACTS_PER_MEMBER);
    expect(r.value.page).toBe(1);
    expect(r.value.pageSize).toBe(50);
    expect(elapsedMs, `page 1 took ${elapsedMs.toFixed(0)} ms`).toBeLessThan(3_000);
  }, 60_000);

  it('the last page is the remainder and a page past the end is empty', async () => {
    const deps = buildMarketingAudienceDeps(tenant.ctx);
    const lastPage = Math.ceil((MEMBERS * CONTACTS_PER_MEMBER) / 50);
    const last = await listMarketingAudience({ filter: { eligible: true }, page: lastPage }, deps);
    expect(last.ok && last.value.rows.length).toBe(50);
    const past = await listMarketingAudience({ filter: { eligible: true }, page: lastPage + 1 }, deps);
    expect(past.ok && past.value.rows).toEqual([]);
    expect(past.ok && past.value.total).toBe(MEMBERS * CONTACTS_PER_MEMBER);
  }, 60_000);

  it('the pre-flight preset at scale (secondary, on, eligible) stays inside the budget', async () => {
    const started = performance.now();
    const r = await listMarketingAudience(
      { filter: { kind: 'secondary', state: 'on', eligible: true }, page: 1 },
      buildMarketingAudienceDeps(tenant.ctx),
    );
    const elapsedMs = performance.now() - started;
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.total).toBe(MEMBERS * (CONTACTS_PER_MEMBER - 1));
    expect(elapsedMs, `preset page 1 took ${elapsedMs.toFixed(0)} ms`).toBeLessThan(3_000);
  }, 60_000);
});

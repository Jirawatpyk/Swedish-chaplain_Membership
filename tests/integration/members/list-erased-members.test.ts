/**
 * COMP-1 US3-D (Task 1) — Integration: `listErasedMembers` keyset list against
 * live Neon.
 *
 * The DPO erasure-evidence page's top-level list shows every erased member
 * (`erased_at IS NOT NULL`), newest-erasure-first, with keyset "load more".
 * This proves the read against live Neon:
 *   - returns ONLY erased members (the non-erased seed row is excluded);
 *   - orders newest-erasure-first ((erased_at DESC, member_id DESC));
 *   - returns the projected `{ memberId, memberNumber, erasedAt }` shape;
 *   - paginates by keyset: limit:1 → page 1 + nextCursor → page 2 → null;
 *   - is tenant-scoped: a 2nd tenant's erased member never leaks (Principle I).
 *
 * Seeds `erased_at` directly (the column is a plain timestamptz with no
 * trigger) at distinct, ordered instants so the ordering + paging assertions
 * are deterministic. Reuses the live-Neon harness shared by
 * `member-erasure-status.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { listErasedMembers } from '@/modules/members';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// ---- Test scaffold ---------------------------------------------------------

const PLAN_ID = 'test-list-erased-plan';

async function seedPlan(tenant: TestTenant, userId: string) {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(tenantInvoiceSettings).values({
      tenantId: tenant.ctx.slug,
      currencyCode: 'THB',
      vatRate: '0.0700',
      registrationFeeSatang: 100000n,
      legalNameTh: 'Test TH',
      legalNameEn: 'Test EN',
      taxId: '0000000000000',
      registeredAddressTh: 'Test Address TH',
      registeredAddressEn: 'Test Address EN',
      invoiceNumberPrefix: 'INV',
      creditNoteNumberPrefix: 'CN',
    });
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId: PLAN_ID,
      planYear: 2026,
      planName: { en: 'List Erased Plan' },
      description: { en: 'Test description' },
      sortOrder: 10,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 1_000_000,
      createdBy: userId,
      updatedBy: userId,
      benefitMatrix: {
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
      },
    });
  });
}

/** Seed a member with an explicit `erased_at` (null ⇒ never erased). */
async function seedMember(
  tenant: TestTenant,
  erasedAt: Date | null,
): Promise<{ memberId: string; memberNumber: number }> {
  const memberId = randomUUID();
  const memberNumber = nextSeedMemberNumber();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber,
      companyName: `List Erased Co ${memberNumber}`,
      country: 'TH',
      planId: PLAN_ID,
      planYear: 2026,
      status: 'active',
      erasedAt,
    });
  });
  return { memberId, memberNumber };
}

// ---- Test suite ------------------------------------------------------------

describe('listErasedMembers — live-Neon keyset list (COMP-1 US3-D)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;

  // Two distinct, ordered erasure instants in tenant A (older + newer) so the
  // newest-first ordering + keyset paging are deterministic.
  const olderErasedAt = new Date('2026-06-01T10:00:00.000Z');
  const newerErasedAt = new Date('2026-06-02T10:00:00.000Z');

  let olderMember: { memberId: string; memberNumber: number };
  let newerMember: { memberId: string; memberNumber: number };

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    const tenants = await createTwoTestTenants();
    tenantA = tenants.a;
    tenantB = tenants.b;
    await seedPlan(tenantA, admin.userId);
    await seedPlan(tenantB, admin.userId);

    // Tenant A: 2 erased (older, newer) + 1 non-erased.
    olderMember = await seedMember(tenantA, olderErasedAt);
    newerMember = await seedMember(tenantA, newerErasedAt);
    await seedMember(tenantA, null);

    // Tenant B: 1 erased member (cross-tenant isolation probe).
    await seedMember(tenantB, newerErasedAt);
  }, 60_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  });

  it('returns ONLY erased members, newest-erasure-first, projected', async () => {
    const page = await listErasedMembers(tenantA.ctx, { limit: 10 });

    expect(page.rows).toHaveLength(2);
    // Newest-first.
    expect(page.rows[0]?.memberId).toBe(newerMember.memberId);
    expect(page.rows[1]?.memberId).toBe(olderMember.memberId);
    // Projection shape.
    expect(page.rows[0]).toEqual({
      memberId: newerMember.memberId,
      memberNumber: newerMember.memberNumber,
      erasedAt: newerErasedAt,
    });
    // Full result fit within the page → no further cursor.
    expect(page.nextCursor).toBeNull();
  }, 30_000);

  it('paginates by keyset: limit:1 → page 1 + cursor → page 2', async () => {
    const page1 = await listErasedMembers(tenantA.ctx, { limit: 1 });
    expect(page1.rows).toHaveLength(1);
    expect(page1.rows[0]?.memberId).toBe(newerMember.memberId);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listErasedMembers(tenantA.ctx, {
      limit: 1,
      cursor: page1.nextCursor!,
    });
    expect(page2.rows).toHaveLength(1);
    expect(page2.rows[0]?.memberId).toBe(olderMember.memberId);

    // Drive one more page — the set is exhausted (1 < limit ⇒ no cursor).
    const page3 = await listErasedMembers(tenantA.ctx, {
      limit: 1,
      cursor: page2.nextCursor!,
    });
    expect(page3.rows).toHaveLength(0);
    expect(page3.nextCursor).toBeNull();
  }, 30_000);

  it('does NOT return another tenant’s erased member', async () => {
    const page = await listErasedMembers(tenantA.ctx, { limit: 100 });
    const ids = page.rows.map((r) => r.memberId);
    // Tenant A sees only its own 2 erased members.
    expect(ids).toHaveLength(2);
    expect(ids).toContain(newerMember.memberId);
    expect(ids).toContain(olderMember.memberId);
  }, 30_000);
});

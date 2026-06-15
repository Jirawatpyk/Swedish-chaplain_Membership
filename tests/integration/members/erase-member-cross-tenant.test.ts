/**
 * COMP-1 US1 (Member Erasure, Task 9) — Integration: cross-tenant isolation
 * (Principle I Review-Gate blocker, design §10).
 *
 * Seeds a member in tenant B, then drives `eraseMember` with the PRODUCTION
 * composition root `buildEraseMemberDeps(tenantA)` — i.e. tenant A's context —
 * against tenant B's member id. The atomic scrub tx runs under tenant A's
 * `app.current_tenant`, so the `findByIdInTx` SELECT … FOR UPDATE is filtered
 * by RLS to tenant A's namespace and finds nothing → `repo.not_found` →
 * `EraseNotFoundError` → `err({ type: 'not_found' })`. Tenant B's row MUST be
 * left fully intact.
 *
 * A `member_erasure_requested` audit MAY be emitted under tenant A even on the
 * cross-tenant miss (it records the attempt and is written before the lookup);
 * that is acceptable. The firm assertion is that tenant B's DATA is untouched.
 *
 * Reuses the live-Neon two-tenant harness (`createTwoTestTenants`) + the same
 * fee/plan seed + BYPASSRLS raw select as the sibling erase tests. No mocks —
 * RLS is the mechanism under test.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { asMemberId, type MemberId } from '@/modules/members';
import { eraseMember } from '@/modules/members/application/use-cases/erase-member';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const PLAN_ID = 'test-erase-xtenant-plan';

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
      planName: { en: 'Erase X-Tenant Plan' },
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

async function seedVictimMember(
  tenant: TestTenant,
): Promise<{ memberId: string; companyName: string }> {
  const memberId = randomUUID();
  const companyName = `Victim Co ${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName,
      country: 'TH',
      taxId: '0105536000123',
      planId: PLAN_ID,
      planYear: 2026,
      status: 'active',
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: 'Bjorn',
      lastName: 'Borg',
      email: `victim-${randomUUID().slice(0, 8)}@example.com`,
      phone: '+66898765432',
      roleTitle: 'CEO',
      preferredLanguage: 'sv',
      isPrimary: true,
    });
  });
  return { memberId, companyName };
}

/** Raw select of tenant B's member under tenant B context (RLS-scoped). */
async function selectMemberUnderTenant(tenant: TestTenant, memberId: string) {
  return runInTenant(tenant.ctx, (tx) =>
    tx
      .select({
        company_name: members.companyName,
        tax_id: members.taxId,
        erased_at: members.erasedAt,
      })
      .from(members)
      .where(eq(members.memberId, memberId))
      .limit(1),
  );
}

// ---- Test suite ------------------------------------------------------------

describe('eraseMember — cross-tenant isolation (Principle I)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    const tenants = await createTwoTestTenants();
    tenantA = tenants.a;
    tenantB = tenants.b;
    // Victim member lives in tenant B; plan must exist in B for the FK.
    await seedPlan(tenantB, admin.userId);
  }, 30_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  });

  it('erasing tenant B\'s member from tenant A returns not_found and leaves B intact', async () => {
    const { memberId, companyName } = await seedVictimMember(tenantB);

    // Sanity: the victim row is visible under tenant B before the attempt.
    const before = await selectMemberUnderTenant(tenantB, memberId);
    expect(before).toHaveLength(1);
    expect(before[0]?.company_name).toBe(companyName);

    // Drive erase with TENANT A's deps against TENANT B's member id.
    const depsA = buildEraseMemberDeps(tenantA.ctx);
    const result = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId: `rq-xtenant-${Date.now()}` },
      depsA,
    );

    // RLS hides tenant B's row from tenant A → findByIdInTx not_found →
    // err({ type: 'not_found' }).
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('not_found');

    // FIRM assertion: tenant B's data is fully intact (not scrubbed).
    const after = await selectMemberUnderTenant(tenantB, memberId);
    expect(after).toHaveLength(1);
    expect(after[0]?.company_name).toBe(companyName);
    expect(after[0]?.company_name).not.toBe('[erased]');
    expect(after[0]?.tax_id).toBe('0105536000123');
    expect(after[0]?.erased_at).toBeNull();
  }, 30_000);
});

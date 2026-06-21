/**
 * COMP-1 US3-A (Member Erasure, admin trigger — Task 2) — Integration:
 * `getMemberErasureStatus` narrow read, against live Neon.
 *
 * The member-detail page renders an "ErasedBanner" + hides write affordances
 * when a member has been erased. The `Member` aggregate does NOT carry
 * `erased_at`, and `getMember`/`findById` don't return it. This narrow read
 * returns `members.erased_at` plus whether the `member_erased` completion-proof
 * audit exists, in ONE round-trip — `erasedAt !== null` drives the banner +
 * write-affordance hiding, `completed` decides the banner's "completion
 * pending" line.
 *
 * Three cases (the source of truth for the driver-return shape + boolean
 * parsing — the function adjusts its raw-row consumption to make these pass):
 *   1. non-erased member         → { erasedAt: null, completed: false }
 *   2. erased + cascades complete → { erasedAt: <Date>, completed: true }
 *   3. unknown member id         → { erasedAt: null, completed: false }
 *
 * Reuses the live-Neon harness shared by `erase-member.test.ts`
 * (`createTestTenant` + plan/settings seed + `nextSeedMemberNumber` +
 * production `buildEraseMemberDeps`). A clean (no-in-flight) member's real
 * F7/F8 cascades return `ok`, so `member_erased` is emitted and
 * `cascadesComplete === true` — exactly what case 2 asserts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import {
  asMemberId,
  type MemberId,
  getMemberErasureStatus,
} from '@/modules/members';
import { eraseMember } from '@/modules/members/application/use-cases/erase-member';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// ---- Test scaffold ---------------------------------------------------------

const PLAN_ID = 'test-erasure-status-plan';

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
      planName: { en: 'Erasure Status Plan' },
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

/** Seed a plain active member (no contacts needed for this read). */
async function seedMember(tenant: TestTenant): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Erasure Status Co., Ltd.',
      legalEntityType: 'Co., Ltd.',
      country: 'TH',
      planId: PLAN_ID,
      planYear: 2026,
      status: 'active',
    });
  });
  return memberId;
}

// ---- Test suite ------------------------------------------------------------

describe('getMemberErasureStatus — live-Neon narrow read (COMP-1 US3-A)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPlan(tenant, admin.userId);
  }, 30_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  });

  it('non-erased member → { erasedAt: null, completed: false }', async () => {
    const memberId = await seedMember(tenant);

    const status = await getMemberErasureStatus(
      tenant.ctx,
      asMemberId(memberId) as MemberId,
    );

    expect(status.erasedAt).toBeNull();
    expect(status.completed).toBe(false);
  }, 30_000);

  it('erased + cascades complete → { erasedAt: <Date>, completed: true }', async () => {
    const memberId = await seedMember(tenant);

    const deps = buildEraseMemberDeps(tenant.ctx);
    const res = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId: `rq-status-${Date.now()}` },
      deps,
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    // Clean (no-in-flight) member → real F7/F8 cascades ok → member_erased
    // emitted → cascadesComplete true.
    expect(res.value.cascadesComplete).toBe(true);

    const status = await getMemberErasureStatus(
      tenant.ctx,
      asMemberId(memberId) as MemberId,
    );

    expect(status.erasedAt).toBeInstanceOf(Date);
    expect(status.completed).toBe(true);
  }, 30_000);

  it('unknown member id → { erasedAt: null, completed: false }', async () => {
    const status = await getMemberErasureStatus(
      tenant.ctx,
      asMemberId(randomUUID()) as MemberId,
    );

    expect(status.erasedAt).toBeNull();
    expect(status.completed).toBe(false);
  }, 30_000);
});

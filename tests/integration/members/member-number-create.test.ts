/**
 * CM-5 (055-member-number) — Integration: createMember persists
 * members.member_number from the per-tenant allocator, and consecutive
 * creates increment by 1. The persisted row's memberNumber is read back and
 * the member_number_assigned audit row is asserted present. Live Neon.
 *
 * Uses a throwaway UUID-suffixed test tenant + simulated dummy member
 * identities (no real PII). The tenant is torn down in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { createMember } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const MATRIX: BenefitMatrix = {
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
};

// Simulated dummy member identity — fake company + contact, never real PII.
function goodInput(planId: string) {
  return {
    company_name: `Numbered Co ${randomUUID().slice(0, 8)}`,
    country: 'TH',
    plan_id: planId,
    plan_year: 2026,
    primary_contact: {
      first_name: 'Anna',
      last_name: 'Andersson',
      email: `anna-${randomUUID().slice(0, 8)}@example.com`,
      preferred_language: 'en' as const,
    },
  };
}

describe('CM-5 — createMember persists member_number (integration)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'test-premium';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
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
        planId,
        planYear: 2026,
        planName: { en: 'Test Premium' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
    });
  }, 30_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('persists a positive member_number and increments on the next create', async () => {
    const deps = buildMembersDeps(tenant.ctx);

    const first = await createMember(
      goodInput(planId),
      { actorUserId: user.userId, requestId: `rq-${randomUUID().slice(0, 8)}` },
      deps,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const firstRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(members)
        .where(eq(members.memberId, first.value.memberId)),
    );
    expect(firstRows).toHaveLength(1);
    const n1 = firstRows[0]!.memberNumber;
    expect(n1).not.toBeNull();
    expect(n1!).toBeGreaterThan(0);

    // member_number_assigned audit row landed for the first member.
    const assignedAudit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'member_number_assigned'),
        ),
      );
    expect(assignedAudit.length).toBeGreaterThanOrEqual(1);
    const firstAssigned = assignedAudit.find(
      (r) => (r.payload as { member_id?: string }).member_id === first.value.memberId,
    );
    expect(firstAssigned).toBeDefined();
    expect((firstAssigned!.payload as { member_number?: number }).member_number).toBe(
      n1,
    );

    const second = await createMember(
      goodInput(planId),
      { actorUserId: user.userId, requestId: `rq-${randomUUID().slice(0, 8)}` },
      deps,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const secondRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(members)
        .where(eq(members.memberId, second.value.memberId)),
    );
    const n2 = secondRows[0]!.memberNumber;
    // Continuous per-tenant sequence: next allocation = previous + 1.
    expect(n2!).toBe(n1! + 1);
  });
});

/**
 * T136 — Integration: undelete-member on live Neon (US7 AS2, AS3).
 *
 * Verifies the 90-day undelete window (FR-005):
 *   1. Within window → member restored + audit row
 *   2. Beyond 90 days → state_error with daysSinceArchive
 *   3. Undelete on non-archived member → state_error
 *   4. Cross-tenant undelete → not_found (RLS)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { undeleteMember, asMemberId } from '@/modules/members';
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

/**
 * Seeds a member directly in `archived` status with a configurable
 * `archived_at` timestamp to simulate an old archive without waiting
 * 91 calendar days.
 */
async function seedArchivedMember(
  tenant: TestTenant,
  planId: string,
  archivedAt: Date | null,
): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: `Undelete Co ${Date.now()}-${randomUUID().slice(0, 6)}`,
      country: 'TH',
      planId,
      planYear: 2026,
      registrationDate: new Date().toISOString().slice(0, 10),
      registrationFeePaid: false,
      status: archivedAt ? 'archived' : 'active',
      archivedAt,
    }),
  );
  return memberId;
}

describe('undelete-member integration (T136, US7)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'test-undelete-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');
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
        planName: { en: 'Undelete Plan' },
        description: { en: '' },
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

  it('undeletes a member within 90-day window', async () => {
    // Archived 30 days ago — well within window
    const archivedAt = new Date(Date.now() - 30 * 86_400_000);
    const memberId = await seedArchivedMember(tenant, planId, archivedAt);
    const deps = buildMembersDeps(tenant.ctx);

    const result = await undeleteMember(
      asMemberId(memberId),
      { actorUserId: user.userId, requestId: `rq-und-${Date.now()}` },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('active');
    expect(result.value.archivedAt).toBeNull();

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.memberId, memberId)),
    );
    expect(rows[0]?.status).toBe('active');
    expect(rows[0]?.archivedAt).toBeNull();

    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'member_undeleted'),
        ),
      );
    const match = audits.find(
      (r) => (r.payload as { member_id?: string })?.member_id === memberId,
    );
    expect(match).toBeDefined();
  });

  it('rejects undelete beyond 90-day window', async () => {
    // Archived 91 days ago — just outside the window
    const archivedAt = new Date(Date.now() - 91 * 86_400_000);
    const memberId = await seedArchivedMember(tenant, planId, archivedAt);
    const deps = buildMembersDeps(tenant.ctx);

    const result = await undeleteMember(
      asMemberId(memberId),
      { actorUserId: user.userId, requestId: `rq-und-exp-${Date.now()}` },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('state_error');
      if (result.error.type === 'state_error') {
        expect(result.error.code).toBe('state.undelete_window_expired');
        expect(result.error.daysSinceArchive).toBeGreaterThanOrEqual(91);
      }
    }

    // Member is still archived
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.memberId, memberId)),
    );
    expect(rows[0]?.status).toBe('archived');
  });

  it('rejects undelete on a non-archived (active) member', async () => {
    const memberId = await seedArchivedMember(tenant, planId, null);
    const deps = buildMembersDeps(tenant.ctx);

    const result = await undeleteMember(
      asMemberId(memberId),
      { actorUserId: user.userId, requestId: `rq-und-act-${Date.now()}` },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('state_error');
      if (result.error.type === 'state_error') {
        expect(result.error.code).toBe('state.undelete_only_from_archived');
      }
    }
  });

  it('cross-tenant undelete returns not_found (RLS)', async () => {
    const archivedAt = new Date(Date.now() - 10 * 86_400_000);
    const memberId = await seedArchivedMember(tenant, planId, archivedAt);
    const otherTenant = await createTestTenant('test');
    try {
      const deps = buildMembersDeps(otherTenant.ctx);
      const result = await undeleteMember(
        asMemberId(memberId),
        { actorUserId: user.userId, requestId: `rq-und-x-${Date.now()}` },
        deps,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.type).toBe('not_found');
    } finally {
      await otherTenant.cleanup().catch(() => {});
    }
  });
});

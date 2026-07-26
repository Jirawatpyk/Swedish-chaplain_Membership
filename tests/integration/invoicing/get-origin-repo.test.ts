/**
 * 107-auto-invoice Task 10 — `InvoiceRepo.getOrigin` (live Neon).
 *
 * The generic issue route's refusal of an `auto_renewal` draft (the paired
 * ship gate closing Task 9's duplicate-§86/4 barrier bypass) depends on this
 * single-column read resolving the RIGHT enum value through RLS. Unit tests
 * mock the port; this proves the Drizzle wiring itself against a real
 * `invoices.origin` column (Task 1's migration 0259) — same discipline as
 * `auto-invoice-schema.test.ts`, which pins the column's DB-level default
 * but never reads it back through a repo method.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

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

describe('InvoiceRepo.getOrigin — 107-auto-invoice Task 10 (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'get-origin-repo-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({
      tenant,
      invoiceNumberPrefix: 'SC',
      receiptNumberPrefix: 'RC',
    });
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Get-Origin Repo Test Plan' },
        description: { en: 'Task 10 repo pin' },
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
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  async function insertDraft(origin: 'manual' | 'auto_renewal' | undefined): Promise<string> {
    const memberId = randomUUID();
    const invoiceId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Get-Origin Repo Test Co',
        country: 'TH',
        planId,
        planYear: 2026,
      });
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        draftByUserId: user.userId,
        status: 'draft',
        ...(origin !== undefined ? { origin } : {}),
      });
    });
    return invoiceId;
  }

  it('returns "manual" for a draft whose origin was omitted at insert (DB default)', async () => {
    const invoiceId = await insertDraft(undefined);
    const repo = makeDrizzleInvoiceRepo(tenant.ctx.slug);
    const origin = await repo.getOrigin(asInvoiceId(invoiceId), tenant.ctx.slug);
    expect(origin).toBe('manual');
  }, 60_000);

  it('returns "auto_renewal" for a queue-owned draft', async () => {
    const invoiceId = await insertDraft('auto_renewal');
    const repo = makeDrizzleInvoiceRepo(tenant.ctx.slug);
    const origin = await repo.getOrigin(asInvoiceId(invoiceId), tenant.ctx.slug);
    expect(origin).toBe('auto_renewal');
  }, 60_000);

  it('returns null for a non-existent invoice id (tenant-scoped, no throw)', async () => {
    const repo = makeDrizzleInvoiceRepo(tenant.ctx.slug);
    const origin = await repo.getOrigin(asInvoiceId(randomUUID()), tenant.ctx.slug);
    expect(origin).toBeNull();
  }, 60_000);
});

/**
 * R4-I3 — `applyReceiptPdfFailure` repo method integration test.
 *
 * Closes the end-to-end coverage gap from Round 4: the unit test in
 * `render-receipt-pdf.test.ts` mocks `applyReceiptPdfFailure` to
 * return a hardcoded discriminated kind. This test exercises the
 * REAL Drizzle repo on live Neon to verify both branches of the
 * discriminated return:
 *
 *   1. `kind='failed'` — invoice in `pending`/`failed` state →
 *      UPDATE matches, attempts incremented, status='failed'.
 *
 *   2. `kind='race_won_by_success'` — invoice already `rendered` →
 *      UPDATE matches zero rows due to `ne(status, 'rendered')` guard,
 *      re-fetch returns the rendered row, repo returns
 *      `{kind: 'race_won_by_success', invoice}` WITHOUT bumping
 *      attempts or overwriting status.
 *
 *   3. Tenant-isolation defense — invoice in a DIFFERENT tenant →
 *      throws `InvoiceApplyConflictError('applyReceiptPdfFailure')`
 *      because re-fetch finds no row under the bound tenant.
 *
 * This is the ground-truth contract for the C2/C-NEW-1 fix. Pre-this
 * file, only the unit-mock asserted the contract; if Drizzle's
 * `ne(receiptPdfStatus, 'rendered')` had subtle NULL-handling or
 * type-coercion behavior on real Postgres, no test would have caught it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { InvoiceApplyConflictError } from '@/modules/invoicing/application/lib/invoice-apply-conflict-error';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

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

async function seedPaidInvoice(
  tenant: TestTenant,
  user: TestUser,
  receiptStatus: 'pending' | 'failed' | 'rendered',
): Promise<{ invoiceId: string }> {
  const memberId = randomUUID();
  const invoiceId = randomUUID();
  const planId = `r4i3-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: 'R4-I3 Plan' },
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
    await tx
      .insert(tenantInvoiceSettings)
      .values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 500000n,
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'R4I3',
        creditNoteNumberPrefix: 'R4I3C',
      })
      .onConflictDoNothing({ target: tenantInvoiceSettings.tenantId });
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: 'R4-I3 Co',
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
      status: 'paid',
      draftByUserId: user.userId,
      fiscalYear: 2026,
      sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
      documentNumber: `R4I3-2026-${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`,
      issueDate: '2026-04-01',
      dueDate: '2026-05-01',
      paidAt: new Date(),
      paymentMethod: 'other',
      paymentDate: '2026-05-01',
      paymentRecordedByUserId: user.userId,
      subtotalSatang: 1_000_000n,
      vatRateSnapshot: '0.0700',
      vatSatang: 70_000n,
      totalSatang: 1_070_000n,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'monthly',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: {
        legal_name_th: 'ทดสอบ',
        legal_name_en: 'Test',
        tax_id: '0000000000000',
        address_th: 'Bangkok',
        address_en: 'Bangkok',
        logo_blob_key: null,
      },
      memberIdentitySnapshot: {
        legal_name: 'R4-I3 Co',
        tax_id: '1234567890123',
        address: 'Bangkok',
        primary_contact_name: 'R4-I3 Contact',
        primary_contact_email: 'r4i3@example.com',
      },
      pdfBlobKey: 'invoicing/test/r4i3.pdf',
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      receiptPdfStatus: receiptStatus,
      receiptPdfRenderAttempts: 0,
      receiptPdfBlobKey:
        receiptStatus === 'rendered' ? 'invoicing/test/r4i3_receipt_v1.pdf' : null,
      receiptPdfSha256: receiptStatus === 'rendered' ? 'd'.repeat(64) : null,
      receiptPdfTemplateVersion: receiptStatus === 'rendered' ? 1 : null,
    });
    await tx.insert(invoiceLines).values({
      tenantId: tenant.ctx.slug,
      lineId: randomUUID(),
      invoiceId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก',
      descriptionEn: 'Membership',
      unitPriceSatang: 1_000_000n,
      quantity: '1',
      proRateFactor: null,
      totalSatang: 1_000_000n,
      position: 1,
    });
  });
  return { invoiceId };
}

describe('R4-I3 — applyReceiptPdfFailure discriminated return on real Postgres', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
  }, 90_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await tenant.cleanup().catch(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('row in pending state → kind=failed, attempts incremented, status=failed', async () => {
    const { invoiceId } = await seedPaidInvoice(tenant, user, 'pending');
    const repo = makeDrizzleInvoiceRepo(tenant.ctx.slug);

    const outcome = await runInTenant(tenant.ctx, async () =>
      repo.withTx(async (tx) =>
        repo.applyReceiptPdfFailure(tx, {
          tenantId: tenant.ctx.slug,
          invoiceId: asInvoiceId(invoiceId),
          errorMessage: 'simulated render error from R4-I3',
        }),
      ),
    );

    expect(outcome.kind).toBe('failed');
    expect(outcome.invoice.receiptPdfStatus).toBe('failed');
    expect(outcome.invoice.receiptPdfRenderAttempts).toBe(1);
    expect(outcome.invoice.receiptPdfLastError).toContain('R4-I3');

    // Verify DB state matches the returned shape.
    const [row] = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenant.ctx.slug),
          eq(invoices.invoiceId, invoiceId),
        ),
      )
      .limit(1);
    expect(row?.receiptPdfStatus).toBe('failed');
    expect(row?.receiptPdfRenderAttempts).toBe(1);
  }, 60_000);

  it('row already rendered → kind=race_won_by_success, status STAYS rendered, attempts UNCHANGED', async () => {
    const { invoiceId } = await seedPaidInvoice(tenant, user, 'rendered');
    const repo = makeDrizzleInvoiceRepo(tenant.ctx.slug);

    const outcome = await runInTenant(tenant.ctx, async () =>
      repo.withTx(async (tx) =>
        repo.applyReceiptPdfFailure(tx, {
          tenantId: tenant.ctx.slug,
          invoiceId: asInvoiceId(invoiceId),
          errorMessage: 'simulated late failure (worker B already won)',
        }),
      ),
    );

    expect(outcome.kind).toBe('race_won_by_success');
    expect(outcome.invoice.receiptPdfStatus).toBe('rendered');
    expect(outcome.invoice.receiptPdfRenderAttempts).toBe(0);

    // Verify DB state was NOT corrupted by the failure write attempt.
    const [row] = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenant.ctx.slug),
          eq(invoices.invoiceId, invoiceId),
        ),
      )
      .limit(1);
    expect(row?.receiptPdfStatus).toBe('rendered');
    expect(row?.receiptPdfRenderAttempts).toBe(0);
    expect(row?.receiptPdfLastError).toBeNull();
  }, 60_000);

  it('row in another tenant → throws InvoiceApplyConflictError(applyReceiptPdfFailure)', async () => {
    // Seed in tenant A, attempt the write under tenant B's repo.
    const { invoiceId } = await seedPaidInvoice(tenant, user, 'pending');
    const otherTenant = await createTestTenant();
    try {
      const repo = makeDrizzleInvoiceRepo(otherTenant.ctx.slug);
      let thrown: unknown = null;
      try {
        await runInTenant(otherTenant.ctx, async () =>
          repo.withTx(async (tx) =>
            repo.applyReceiptPdfFailure(tx, {
              tenantId: otherTenant.ctx.slug,
              invoiceId: asInvoiceId(invoiceId),
              errorMessage: 'cross-tenant probe',
            }),
          ),
        );
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(InvoiceApplyConflictError);
      if (thrown instanceof InvoiceApplyConflictError) {
        expect(thrown.kind).toBe('applyReceiptPdfFailure');
      }
    } finally {
      await otherTenant.cleanup().catch(() => {});
    }
  }, 60_000);
});

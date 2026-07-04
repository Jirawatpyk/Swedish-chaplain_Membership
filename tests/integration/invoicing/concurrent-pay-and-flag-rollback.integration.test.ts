/**
 * 088-invoice-tax-flow-redesign — US1 review-hardening integration (live Neon):
 *
 *  1. CONCURRENT-DOUBLE-PAY — two `recordPayment` calls race on ONE issued bill
 *     (`Promise.all`). The row-lock + idempotent-replay + applyPayment WHERE
 *     `status='issued'` guard MUST admit exactly ONE §87 `RC` number and emit
 *     exactly ONE `tax_receipt_issued` (no double-mint on the new RC path).
 *  2. FLAG-ROLLBACK — a NEW-flow bill (issued while the flag was ON) paid with
 *     the flag OFF is REJECTED (`new_flow_bill_requires_flag_on`, SEC-MED),
 *     leaving the row `issued` with no RC number (no untaxed paid membership).
 *
 * REAL allocator + repo + audit; PDF/Blob mocked. Migrations 0230 + 0231 first.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import { recordPayment } from '@/modules/invoicing/application/use-cases/record-payment';
import {
  makeCreateInvoiceDraftDeps,
  makeIssueInvoiceDeps,
  makeRecordPaymentDeps,
} from '@/modules/invoicing/application/invoicing-deps';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { TaxAtPaymentFlag } from '@/modules/invoicing';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
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

const FIXED_NOW = '2026-07-01T09:00:00Z';
const PAYMENT_DATE = '2026-07-01';
const PLAN_ID = 'concurrent-rollback-plan';
const PLAN_YEAR = 2026;

function mockPdfBlob() {
  return {
    pdfRender: {
      render: vi.fn(async (_i: PdfRenderInput) => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(async () => {}),
      list: vi.fn(),
    },
  };
}
function issueDeps(slug: string) {
  return { ...makeIssueInvoiceDeps(slug), ...mockPdfBlob(), clock: { nowIso: () => FIXED_NOW }, taxAtPayment: 'on' as const };
}
function recordDeps(slug: string, taxAtPayment: TaxAtPaymentFlag) {
  return {
    ...makeRecordPaymentDeps(slug),
    ...mockPdfBlob(),
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment,
    asyncReceiptPdf: false,
  };
}

describe('088 US1-hardening — concurrent double-pay + flag rollback (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({
      tenant,
      legalNameTh: 'หอการค้าไทย-สวีเดน',
      legalNameEn: 'Thailand-Swedish Chamber of Commerce',
      registeredAddressTh: 'กรุงเทพฯ',
      registeredAddressEn: 'Bangkok',
      invoiceNumberPrefix: 'SC',
      receiptNumberPrefix: 'RC',
    });
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: PLAN_ID,
        planYear: PLAN_YEAR,
        planName: { en: 'Concurrent/Rollback Plan' },
        description: { en: 'Plan for the 088 concurrent+rollback hardening test' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_200_000,
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
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  async function seedMember(): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `CR Member ${memberId.slice(0, 8)}`,
        country: 'TH',
        taxId: '9999999999999',
        addressLine1: '99 Rama IV Road',
        city: 'Sathon',
        province: 'Bangkok',
        postalCode: '10120',
        planId: PLAN_ID,
        planYear: PLAN_YEAR,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'CR',
        lastName: 'Member',
        email: `cr.${memberId.slice(0, 8)}@member.example`,
        isPrimary: true,
      });
    });
    return memberId;
  }

  async function issueBill(memberId: string, tag: string): Promise<string> {
    const draft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `cr-draft-${tag}-${memberId}`,
      memberId,
      planId: PLAN_ID,
      planYear: PLAN_YEAR,
    });
    if (!draft.ok) throw new Error(`draft ${tag}: ${draft.error.code}`);
    const invoiceId = draft.value.invoiceId;
    const issued = await issueInvoice(issueDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `cr-issue-${tag}-${invoiceId}`,
      invoiceId,
    });
    if (!issued.ok) throw new Error(`issue ${tag}: ${JSON.stringify(issued)}`);
    return invoiceId;
  }

  async function countTaxReceipts(invoiceId: string): Promise<number> {
    const rows = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'tax_receipt_issued'),
          sql`(${auditLog.payload} ->> 'invoice_id') = ${invoiceId}`,
        ),
      );
    return rows.length;
  }

  it('concurrent double-pay — one RC number + one tax_receipt_issued (no double-mint)', async () => {
    const memberId = await seedMember();
    const invoiceId = await issueBill(memberId, 'concurrent');

    // Two record-payment calls race on the SAME issued bill.
    const [a, b] = await Promise.all([
      recordPayment(recordDeps(tenant.ctx.slug, 'on'), {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `cr-pay-a-${invoiceId}`,
        invoiceId,
        paymentMethod: 'bank_transfer',
        paymentDate: PAYMENT_DATE,
      }),
      recordPayment(recordDeps(tenant.ctx.slug, 'on'), {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `cr-pay-b-${invoiceId}`,
        invoiceId,
        paymentMethod: 'bank_transfer',
        paymentDate: PAYMENT_DATE,
      }),
    ]);

    // At least one call succeeds; the other is either an idempotent-replay
    // success (returns the already-paid row) OR a typed concurrent_state_change
    // — never a second successful mint.
    const okCount = [a, b].filter((r) => r.ok).length;
    expect(okCount).toBeGreaterThanOrEqual(1);
    for (const r of [a, b]) {
      if (!r.ok) expect(r.error.code).toBe('concurrent_state_change');
    }

    // The row carries EXACTLY ONE RC number (no second §87 allocated).
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    expect(row!.status).toBe('paid');
    expect(row!.receiptDocumentNumberRaw).toMatch(/^RC-2026-\d{6}$/);
    expect(row!.documentNumber).toBeNull();

    // EXACTLY ONE tax_receipt_issued audit row for this invoice.
    expect(await countTaxReceipts(invoiceId)).toBe(1);
  }, 90_000);

  it('flag rollback — a new-flow bill paid with the flag OFF is rejected (new_flow_bill_requires_flag_on)', async () => {
    const memberId = await seedMember();
    const invoiceId = await issueBill(memberId, 'rollback');

    // Roll the flag back OFF and try to pay the new-flow bill.
    const paid = await recordPayment(recordDeps(tenant.ctx.slug, 'off'), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `cr-rollback-pay-${invoiceId}`,
      invoiceId,
      paymentMethod: 'bank_transfer',
      paymentDate: PAYMENT_DATE,
    });
    expect(paid.ok).toBe(false);
    if (paid.ok) throw new Error('expected new_flow_bill_requires_flag_on');
    expect(paid.error.code).toBe('new_flow_bill_requires_flag_on');

    // Row untouched — still issued, no RC minted, no tax receipt emitted.
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    expect(row!.status).toBe('issued');
    expect(row!.receiptDocumentNumberRaw).toBeNull();
    expect(await countTaxReceipts(invoiceId)).toBe(0);
  }, 90_000);
});

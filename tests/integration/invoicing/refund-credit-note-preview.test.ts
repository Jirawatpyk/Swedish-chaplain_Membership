/**
 * Spec 122 US8b follow-up — the refund dialog's "Credit note to be issued"
 * preview equals the credit note the refund then ISSUES, against live Postgres.
 *
 * `previewRefundCreditNote` is read through the production deps factory
 * (`makePreviewRefundCreditNoteDeps` → `runInTenant`), then `issueCreditNote` issues the
 * note for the same amount; the stored `vat_satang` / `credit_amount_satang`
 * must equal what was previewed — for a full refund, a partial, and the last
 * of three partials (the completing note takes the residual VAT, so the notes
 * credit exactly the VAT charged).
 * Plus a cross-tenant read: another tenant's invoice previews as not found.
 *
 * Seeding mirrors `credit-note-partial-accumulation.test.ts` (membership
 * invoice, 1,000.00 THB + 7% VAT, receipt rendered).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { makeDrizzleCreditNoteRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { issueCreditNote } from '@/modules/invoicing/application/use-cases/issue-credit-note';
import type { IssueCreditNoteDeps } from '@/modules/invoicing/application/use-cases/issue-credit-note';
import { makePreviewRefundCreditNoteDeps, previewRefundCreditNote } from '@/modules/invoicing';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { makeRecipientLocaleFake } from '../../helpers/recipient-locale-fake';

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

const INVOICE_TOTAL = 107_000n; // 1,000 THB subtotal + 7% VAT
const INVOICE_SUBTOTAL = 100_000n;
const INVOICE_VAT = 7_000n;

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'CN Test Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

/**
 * Seed an invoice in a specified non-draft status. `paid` is the
 * happy-path shape for the credit-note flow; `issued` / `voided` /
 * `credited` are used by the rejection-branch tests below. The
 * `payment_*` fields satisfy the DB CHECK `invoices_paid_has_payment`
 * which is only relevant when status='paid'.
 */
async function seedInvoiceInStatus(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  status: 'paid' | 'issued' | 'void',
  seq = 1,
): Promise<{ invoiceId: string; memberId: string }> {
  const invoiceId = randomUUID();
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'CN Test Co',
      country: 'TH',
      planId,
      planYear: 2026,
    });

    // Paid invoice with snapshots, money fields, and PDF metadata —
    // must satisfy invoices_non_draft_has_snapshots + invoices_paid_has_payment.
    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      planYear: 2026,
      planId,
      draftByUserId: user.userId,
      status,
      pdfDocKind: 'invoice',
      // T166 — paid rows must have receipt_pdf_status NOT NULL per
      // migration 0056 CHECK. Issued/void rows leave it NULL.
      receiptPdfStatus: status === 'paid' ? 'rendered' : null,
      fiscalYear: 2026,
      sequenceNumber: seq,
      documentNumber: `CNIT-2026-${String(seq).padStart(6, '0')}`,
      issueDate: '2026-01-15',
      dueDate: '2026-02-14',
      subtotalSatang: INVOICE_SUBTOTAL,
      vatRateSnapshot: '0.0700',
      vatSatang: INVOICE_VAT,
      totalSatang: INVOICE_TOTAL,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'monthly',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      pdfBlobKey: 'invoicing/x/2026/seed.pdf',
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      paymentMethod: status === 'paid' ? 'bank_transfer' : null,
      paymentReference: status === 'paid' ? 'seed-ref' : null,
      paymentNotes: null,
      paymentRecordedByUserId: status === 'paid' ? user.userId : null,
      paymentDate: status === 'paid' ? '2026-02-01' : null,
      paidAt: status === 'paid' ? new Date('2026-02-01T03:00:00Z') : null,
      voidedAt: status === 'void' ? new Date('2026-03-01T03:00:00Z') : null,
      voidReason: status === 'void' ? 'seed void' : null,
      voidedByUserId: status === 'void' ? user.userId : null,
    });
    await tx.insert(invoiceLines).values({
      tenantId: tenant.ctx.slug,
      lineId: randomUUID(),
      invoiceId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก ปี 2026',
      descriptionEn: 'Membership 2026',
      unitPriceSatang: INVOICE_SUBTOTAL,
      totalSatang: INVOICE_SUBTOTAL,
      position: 1,
    });
  });
  return { invoiceId, memberId };
}

function makeDeps(tenantId: string): IssueCreditNoteDeps {
  return {
    pendingRefundGuard: { countPendingRefundsForInvoice: async () => 0 },
    onlinePaymentRefundGuard: { readRefundableOnlinePayment: async () => ({ kind: 'none' }) },
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    creditNoteRepo: makeDrizzleCreditNoteRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('b'.repeat(64)),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      signDownloadUrl: vi.fn(async () => 'https://blob.test/signed'),
      downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => [] as string[]),
    },
    audit: f4AuditAdapter,
    clock: { nowIso: () => '2026-04-18T10:00:00Z' },
    outbox: { enqueue: vi.fn(async () => {}) },
    recipientLocale: makeRecipientLocaleFake(),
    currentTemplateVersion: 1,
  };
}

async function issuedRows(tenant: TestTenant, invoiceId: string) {
  return runInTenant(tenant.ctx, (tx) =>
    tx
      .select({
        net: creditNotes.creditAmountSatang,
        vat: creditNotes.vatSatang,
        total: creditNotes.totalSatang,
        seq: creditNotes.sequenceNumber,
      })
      .from(creditNotes)
      .where(and(eq(creditNotes.tenantId, tenant.ctx.slug), eq(creditNotes.originalInvoiceId, invoiceId))),
  );
}

describe('refund credit-note preview equals the issued credit note', () => {
  let tenant: TestTenant;
  let otherTenant: TestTenant;
  let user: TestUser;
  const planId = 'cn-preview-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    otherTenant = await createTestTenant('test-chamber');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'CN Preview Plan' },
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
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'CNIT',
        creditNoteNumberPrefix: 'CN',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await otherTenant.cleanup().catch(() => {});
  });

  beforeEach(async () => {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.delete(creditNotes).where(eq(creditNotes.tenantId, tenant.ctx.slug));
      await tx.delete(invoiceLines).where(eq(invoiceLines.tenantId, tenant.ctx.slug));
      await tx.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug));
      await tx.delete(members).where(eq(members.tenantId, tenant.ctx.slug));
    });
  });

  async function previewThenIssue(invoiceId: string, amount: bigint, completes: boolean) {
    const preview = await previewRefundCreditNote(makePreviewRefundCreditNoteDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      invoiceId,
      creditTotalSatang: amount,
    });
    if (!preview.ok || preview.value.kind !== 'issue') {
      throw new Error(`expected an issue preview, got ${JSON.stringify(preview, (_k, v) => (typeof v === 'bigint' ? String(v) : v))}`);
    }
    const issued = await issueCreditNote(makeDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      creditTotalSatang: amount,
      reason: 'Refund preview parity',
      ...(completes ? { membershipEffect: 'keep' as const } : {}),
    });
    expect(issued.ok).toBe(true);
    return preview.value;
  }

  it('full refund — preview and issued note both carry the whole invoice VAT', async () => {
    const { invoiceId } = await seedInvoiceInStatus(tenant, user, planId, 'paid');
    const preview = await previewThenIssue(invoiceId, INVOICE_TOTAL, true);
    const [row] = await issuedRows(tenant, invoiceId);
    expect(preview).toEqual({ kind: 'issue', netSatang: INVOICE_SUBTOTAL, vatSatang: INVOICE_VAT, vatRateRaw: '0.0700' });
    expect(BigInt(row!.vat as unknown as string)).toBe(preview.vatSatang);
    expect(BigInt(row!.net as unknown as string)).toBe(preview.netSatang);
  }, 60_000);

  it('partial, partial, then the residual last partial — every preview equals its issued note', async () => {
    const { invoiceId } = await seedInvoiceInStatus(tenant, user, planId, 'paid');
    const previews = [
      await previewThenIssue(invoiceId, 33_333n, false),
      await previewThenIssue(invoiceId, 33_333n, false),
      await previewThenIssue(invoiceId, 40_334n, true),
    ];
    const rows = (await issuedRows(tenant, invoiceId)).sort((a, b) => a.seq - b.seq);
    expect(rows).toHaveLength(3);
    rows.forEach((row, i) => {
      expect(BigInt(row.vat as unknown as string)).toBe(previews[i]!.vatSatang);
      expect(BigInt(row.net as unknown as string)).toBe(previews[i]!.netSatang);
    });
    // Cumulative VAT: 2,181 + 2,180 + 2,639 = 7,000, exactly the VAT charged
    // (per-note proportional rounding gave 2,181 + 2,181 + 2,639 = 7,001).
    expect(previews.map((p) => p.vatSatang)).toEqual([2_181n, 2_180n, 2_639n]);
    expect(rows.reduce((sum, row) => sum + BigInt(row.vat as unknown as string), 0n)).toBe(INVOICE_VAT);
  }, 120_000);

  it("earlier VAT is summed for THIS invoice only — another invoice's notes do not count", async () => {
    const a = await seedInvoiceInStatus(tenant, user, planId, 'paid', 1);
    const b = await seedInvoiceInStatus(tenant, user, planId, 'paid', 2);
    await previewThenIssue(a.invoiceId, 33_333n, false);
    const previews = [
      await previewThenIssue(b.invoiceId, 33_333n, false),
      await previewThenIssue(b.invoiceId, 33_333n, false),
      await previewThenIssue(b.invoiceId, 40_334n, true),
    ];
    expect(previews.map((p) => p.vatSatang)).toEqual([2_181n, 2_180n, 2_639n]);
    const rows = await issuedRows(tenant, b.invoiceId);
    expect(rows.reduce((sum, row) => sum + BigInt(row.vat as unknown as string), 0n)).toBe(INVOICE_VAT);
  }, 120_000);

  it("another tenant's invoice previews as not found (RLS + tenant-scoped repo)", async () => {
    const { invoiceId } = await seedInvoiceInStatus(tenant, user, planId, 'paid');
    const r = await previewRefundCreditNote(makePreviewRefundCreditNoteDeps(otherTenant.ctx.slug), {
      tenantId: otherTenant.ctx.slug,
      invoiceId,
      creditTotalSatang: 33_333n,
    });
    expect(r).toEqual({ ok: false, error: { code: 'not_found' } });
  }, 60_000);
});

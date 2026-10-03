/**
 * §86/10 วรรคสอง — two credit notes against one invoice, issued on live Neon at
 * CURRENT_TEMPLATE_VERSION with the REAL react-pdf adapter.
 *
 * The unit tests cover the template's element tree and the use case's values
 * against mocks. This file proves the chain end to end: the row lock, the
 * earlier note's VAT read from the DB, the rendered PDF text, and the
 * `credit_note_issued` audit row that keeps the same statement.
 *
 * Fixture: a paid membership invoice of 1,070.00 (1,000.00 + 7% VAT).
 *   note 1 — 642.00 gross → net 600.00, VAT 42.00; correct value 400.00.
 *   note 2 — 428.00 gross → net 400.00, VAT 28.00; previously reduced 600.00,
 *            correct value 0.00. original − previously reduced − correct =
 *            difference on both notes.
 *
 * PDF text is whitespace-normalised before matching (pdf-parse may break a
 * line between runs); the English half of each bilingual label is matched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { PDFParse } from 'pdf-parse';
import { runInTenant } from '@/lib/db';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { makeDrizzleCreditNoteRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import { CURRENT_TEMPLATE_VERSION } from '@/modules/invoicing/infrastructure/pdf/template-registry';
import { formatThbSatang } from '@/modules/invoicing/infrastructure/pdf/format-thb';
import { issueCreditNote } from '@/modules/invoicing/application/use-cases/issue-credit-note';
import type { IssueCreditNoteDeps } from '@/modules/invoicing/application/use-cases/issue-credit-note';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
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

const INVOICE_SUBTOTAL = 100_000n;
const INVOICE_VAT = 7_000n;
const INVOICE_TOTAL = 107_000n;

/** SIMULATED identities only. */
const SNAP_TENANT = {
  legal_name_th: 'หอการค้าจำลอง',
  legal_name_en: 'Simulated Chamber',
  tax_id: '0000000000000',
  address_th: 'กรุงเทพมหานคร',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Simulated 8610 Co., Ltd.',
  tax_id: '1234567890123',
  address: '99/1 Simulated Rd, Bangkok',
  primary_contact_name: 'Sim Contact',
  primary_contact_email: 'sim@cn-8610.test',
};

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  const result = await parser.getText();
  return result.text.replace(/\s+/g, ' ');
}

const fmt = (satang: bigint) => formatThbSatang(satang, true);

/**
 * Every upload is captured with its key: issuing a credit note also re-renders
 * the ORIGINAL invoice with the credited annotation (its own blob key), so the
 * credit-note PDFs are picked out by `issueCreditNote`'s key shape.
 */
type CapturedUpload = { readonly key: string; readonly body: Uint8Array };
const isCreditNoteUpload = (u: CapturedUpload) => /\/credit-note_[^/]+\.pdf$/.test(u.key);

function makeDeps(tenantId: string, captured: CapturedUpload[]): IssueCreditNoteDeps {
  return {
    pendingRefundGuard: { countPendingRefundsForInvoice: async () => 0 },
    onlinePaymentRefundGuard: { readRefundableOnlinePayment: async () => ({ kind: 'none' }) },
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    creditNoteRepo: makeDrizzleCreditNoteRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    sequenceAllocator: postgresSequenceAllocator,
    // The REAL renderer — the point of this file.
    pdfRender: reactPdfRenderAdapter,
    blob: {
      uploadPdf: vi.fn(async ({ key, body }: { key: string; body: Uint8Array }) => {
        captured.push({ key, body });
        return { key, url: `https://blob.test/${key}` };
      }),
      uploadLogo: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      signDownloadUrl: vi.fn(async () => 'https://blob.test/signed'),
      downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => [] as string[]),
    },
    audit: f4AuditAdapter,
    clock: { nowIso: () => '2026-10-03T10:00:00Z' },
    outbox: { enqueue: vi.fn(async () => {}) },
    recipientLocale: makeRecipientLocaleFake(),
    currentTemplateVersion: CURRENT_TEMPLATE_VERSION,
  };
}

describe('§86/10 — credit notes at CURRENT_TEMPLATE_VERSION state their values (live Neon, real PDF)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'cn-8610-plan';
  const invoiceId = randomUUID();
  const memberId = randomUUID();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'CN 8610 Plan' },
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
        legalNameTh: SNAP_TENANT.legal_name_th,
        legalNameEn: SNAP_TENANT.legal_name_en,
        taxId: SNAP_TENANT.tax_id,
        registeredAddressTh: SNAP_TENANT.address_th,
        registeredAddressEn: SNAP_TENANT.address_en,
        invoiceNumberPrefix: 'CNPV',
        creditNoteNumberPrefix: 'CN',
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: SNAP_MEMBER.legal_name,
        country: 'TH',
        planId,
        planYear: 2026,
      });
      // A paid membership invoice — the shape credit-note-partial-accumulation
      // seeds (invoices_non_draft_has_snapshots + invoices_paid_has_payment).
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        draftByUserId: user.userId,
        status: 'paid',
        pdfDocKind: 'invoice',
        receiptPdfStatus: 'rendered',
        fiscalYear: 2026,
        sequenceNumber: 1,
        documentNumber: 'CNPV-2026-000001',
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
        paymentMethod: 'bank_transfer',
        paymentReference: 'seed-ref',
        paymentNotes: null,
        paymentRecordedByUserId: user.userId,
        paymentDate: '2026-02-01',
        paidAt: new Date('2026-02-01T03:00:00Z'),
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
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('a first note, then the completing note — each PDF reconciles and the audit row keeps the statement', async () => {
    const captured: CapturedUpload[] = [];
    const deps = makeDeps(tenant.ctx.slug, captured);

    const r1 = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-cn-8610-1-${invoiceId}`,
      invoiceId,
      creditTotalSatang: 64_200n,
      reason: 'Partial refund 1',
    });
    expect(r1.ok, r1.ok ? 'ok' : `note 1 err: ${JSON.stringify(r1)}`).toBe(true);

    const r2 = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-cn-8610-2-${invoiceId}`,
      invoiceId,
      creditTotalSatang: 42_800n,
      reason: 'Partial refund 2',
      membershipEffect: 'keep',
    });
    expect(r2.ok, r2.ok ? 'ok' : `note 2 err: ${JSON.stringify(r2)}`).toBe(true);

    // Both rows pin the current version, so both PDFs carry the statement.
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ v: creditNotes.pdfTemplateVersion })
        .from(creditNotes)
        .where(eq(creditNotes.originalInvoiceId, invoiceId)),
    );
    expect(rows.map((r) => r.v)).toEqual([CURRENT_TEMPLATE_VERSION, CURRENT_TEMPLATE_VERSION]);

    // Issue order: note 1's PDF uploads before note 2's.
    const creditNotePdfs = captured.filter(isCreditNoteUpload);
    expect(creditNotePdfs, `uploads: ${captured.map((u) => u.key).join(', ')}`).toHaveLength(2);
    const text1 = await extractPdfText(creditNotePdfs[0]!.body);
    expect(text1).toContain(`Value per original tax invoice: ${fmt(100_000n)}`);
    expect(text1).toContain(`Correct value: ${fmt(40_000n)}`);
    expect(text1).toContain(`Difference: ${fmt(60_000n)}`);
    expect(text1).toContain(`VAT on the difference: ${fmt(4_200n)}`);
    expect(text1, 'a first note has nothing previously reduced').not.toContain('Previously reduced');

    const text2 = await extractPdfText(creditNotePdfs[1]!.body);
    expect(text2).toContain(`Value per original tax invoice: ${fmt(100_000n)}`);
    expect(text2).toContain(`Previously reduced: ${fmt(60_000n)}`);
    expect(text2).toContain(`Correct value: ${fmt(0n)}`);
    expect(text2).toContain(`Difference: ${fmt(40_000n)}`);
    expect(text2).toContain(`VAT on the difference: ${fmt(2_800n)}`);

    // The audit rows keep the same statement (oldest first).
    const audit = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'credit_note_issued'),
            sql`${auditLog.payload}->>'original_invoice_id' = ${invoiceId}`,
          ),
        )
        .orderBy(sql`${auditLog.payload}->>'document_number'`),
    );
    expect(audit.map((a) => (a.payload as Record<string, unknown>)['section_86_10'])).toEqual([
      {
        original_value_satang: '100000',
        previously_reduced_satang: '0',
        correct_value_satang: '40000',
        difference_satang: '60000',
        difference_vat_satang: '4200',
        template_version: CURRENT_TEMPLATE_VERSION,
      },
      {
        original_value_satang: '100000',
        previously_reduced_satang: '60000',
        correct_value_satang: '0',
        difference_satang: '40000',
        difference_vat_satang: '2800',
        template_version: CURRENT_TEMPLATE_VERSION,
      },
    ]);
  }, 180_000);
});

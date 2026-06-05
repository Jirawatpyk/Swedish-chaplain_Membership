/**
 * T127 — Credit-note PDF render-input golden test.
 *
 * Pins Review C-1 (2026-04-20): the CN PDF must render with a SINGLE
 * synthetic line whose unitPrice === total === creditAmount (excl VAT)
 * and whose bilingual description references the original invoice
 * number. Protects against a future refactor that re-introduces
 * `loaded.lines` on the CN render path (which would make line-sum ≠
 * totals block — visually inconsistent AND a Thai RD §86/4 interpretation
 * risk for partial credit notes).
 *
 * This is a render-INPUT golden, not a PDF-bytes golden — it captures
 * the structured arguments passed to `pdfRender.render` (which a
 * regression would mangle before any bytes are produced). Cheaper +
 * more precise than binary diffing the output.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { makeDrizzleCreditNoteRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { issueCreditNote } from '@/modules/invoicing/application/use-cases/issue-credit-note';
import type { IssueCreditNoteDeps } from '@/modules/invoicing/application/use-cases/issue-credit-note';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
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

const ORIGINAL_DOC_NUMBER = 'T127-2026-000001';
const INVOICE_SUBTOTAL = 100_000n; // 1,000 THB
const INVOICE_VAT = 7_000n; // 7%
const INVOICE_TOTAL = 107_000n;

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'T127 Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

async function seedPaidInvoice(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
): Promise<{ invoiceId: string }> {
  const invoiceId = randomUUID();
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'T127 Co',
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
      status: 'paid',
      receiptPdfStatus: 'rendered',
      fiscalYear: 2026,
      sequenceNumber: 1,
      documentNumber: ORIGINAL_DOC_NUMBER,
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
      pdfBlobKey: 'invoicing/t127/2026/seed.pdf',
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      paymentMethod: 'bank_transfer',
      paymentReference: 'seed-ref',
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
  return { invoiceId };
}

function makeDepsWithRenderSpy(
  tenantId: string,
  captured: PdfRenderInput[],
): IssueCreditNoteDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    creditNoteRepo: makeDrizzleCreditNoteRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: {
      render: vi.fn(async (input: PdfRenderInput) => {
        captured.push(input);
        return {
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          sha256: Sha256Hex.ofUnsafe('b'.repeat(64)),
        };
      }),
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
    currentTemplateVersion: 1,
  };
}

describe('T127 — credit-note PDF render-input golden (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 't127-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'T127 Plan' },
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
        invoiceNumberPrefix: 'T127',
        creditNoteNumberPrefix: 'T127C',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  beforeEach(async () => {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.delete(creditNotes).where(eq(creditNotes.tenantId, tenant.ctx.slug));
      await tx.delete(invoiceLines).where(eq(invoiceLines.tenantId, tenant.ctx.slug));
      await tx.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug));
      await tx.delete(members).where(eq(members.tenantId, tenant.ctx.slug));
    });
  });

  it('partial CN (50%) renders exactly 1 synthetic line with unitPrice=total=creditAmount + bilingual original-doc ref', async () => {
    const { invoiceId } = await seedPaidInvoice(tenant, user, planId);
    const captured: PdfRenderInput[] = [];
    const deps = makeDepsWithRenderSpy(tenant.ctx.slug, captured);

    // 50% partial: credit_total 53_500 satang = 50_000 excl VAT + 3_500 VAT.
    const r = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      creditTotalSatang: 53_500n,
      reason: 'T127 golden test',
    });
    expect(r.ok).toBe(true);

    // The FIRST render call is the CN render (kind='credit_note').
    // Partial CN also triggers a J2 re-annotation render (kind='invoice')
    // as the SECOND call — the golden pins the CN one specifically.
    const cnRender = captured.find((c) => c.kind === 'credit_note');
    expect(cnRender, 'expected a credit_note render call').toBeDefined();
    if (cnRender?.kind !== 'credit_note') throw new Error('unreachable');

    // (1) Exactly ONE synthetic line — catches a future refactor that
    // re-introduces loaded.lines on the CN path.
    expect(
      cnRender.lines,
      'CN render MUST pass a single synthetic line — see Review C-1',
    ).toHaveLength(1);
    const line = cnRender.lines[0]!;

    // (2) unitPrice === total === creditAmount (excl VAT, 50_000 satang).
    expect(line.unitPrice.satang).toBe(50_000n);
    expect(line.total.satang).toBe(50_000n);
    expect(line.unitPrice.satang).toBe(line.total.satang);

    // (3) Bilingual description references the original invoice number.
    //     Exact prefix format is enforced by the use-case; assert the
    //     number is present in both languages so a refactor that drops
    //     one language fails here.
    expect(line.descriptionTh).toContain(ORIGINAL_DOC_NUMBER);
    expect(line.descriptionEn).toContain(ORIGINAL_DOC_NUMBER);

    // (4) CN-level totals match the line-level numbers — subtotal ===
    // unitPrice === total; vat is the 7% split; total is subtotal + vat.
    expect(cnRender.subtotal.satang).toBe(50_000n);
    expect(cnRender.vat.satang).toBe(3_500n);
    expect(cnRender.total.satang).toBe(53_500n);

    // (5) creditNote context carries the original document number +
    //     issue date + free-text reason. Template reads these for the
    //     reference block — regression here would drop the Thai RD
    //     "§86/5 reference to original tax document" requirement.
    expect(cnRender.creditNote?.originalDocumentNumber).toBe(ORIGINAL_DOC_NUMBER);
    expect(cnRender.creditNote?.reason).toBe('T127 golden test');
  }, 60_000);
});

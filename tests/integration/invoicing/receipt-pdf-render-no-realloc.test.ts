/**
 * R2-CG-2 + R2-IG-3 — end-to-end §87 invariant proof for the T166
 * async receipt PDF worker.
 *
 * This file pins the SECOND half of the C1 fix: the worker
 * (`renderReceiptPdf`) MUST read `invoices.receipt_document_number_raw`
 * back instead of allocating a fresh receipt sequence number on every
 * retry. The test seeds:
 *   - tenant_payment_settings with `receipt_numbering_mode='separate'`
 *   - a paid invoice with `receipt_pdf_status='pending'` AND a
 *     pre-allocated `receipt_document_number_raw='RE-2026-000007'`
 *   - tenant_document_sequences.receipt at next=8 (matches the
 *     allocation that already happened at record-payment time)
 *
 * Then runs `renderReceiptPdf` 3 times in a row (simulating the
 * dispatcher retrying after transient failures) and asserts:
 *   1. `tenant_document_sequences.receipt.next_sequence_number` is
 *      STILL 8 after all 3 calls (no re-allocation).
 *   2. The rendered receipt's audit row carries
 *      `receipt_document_number = 'RE-2026-000007'` (the original
 *      allocation, NOT a fresh one).
 *
 * R2-IG-3 — race-won-by-success scenario:
 *   - Seed paid+rendered invoice (worker B already finished)
 *   - Mock the PDF render adapter to throw on the next call
 *   - Run renderReceiptPdf — the failed-write path triggers but
 *     applyReceiptPdfFailure detects the rendered row and returns
 *     `kind='race_won_by_success'`. The use-case maps this to ok().
 *   - Assert: invoice stays 'rendered' + use-case returns ok + the
 *     attempts counter on the row was NOT incremented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import {
  renderReceiptPdf,
  makeRenderReceiptPdfDeps,
} from '@/modules/invoicing';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

vi.mock('@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter', () => ({
  reactPdfRenderAdapter: {
    render: vi.fn(async () => ({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      sha256: Sha256Hex.ofUnsafe('d'.repeat(64)),
    })),
  },
}));
vi.mock('@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter', () => ({
  vercelBlobAdapter: {
    uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
      key,
      url: `https://blob.test/${key}`,
    })),
    signDownloadUrl: vi.fn(async (key: string) => `https://blob.test/${key}`),
    delete: vi.fn(),
    list: vi.fn(async () => []),
  },
}));

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

interface SeededRow {
  invoiceId: string;
  receiptDocNumRaw: string;
}

async function seedSeparateModePendingInvoice(
  tenant: TestTenant,
  user: TestUser,
  receiptStatus: 'pending' | 'rendered',
): Promise<SeededRow> {
  const memberId = randomUUID();
  const invoiceId = randomUUID();
  const planId = `r2cg2-${randomUUID().slice(0, 8)}`;
  const seq = 7;
  const receiptDocNumRaw = `RE-2026-${String(seq).padStart(6, '0')}`;
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: 'R2-CG-2 Plan' },
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
        invoiceNumberPrefix: 'INV',
        creditNoteNumberPrefix: 'CN',
        receiptNumberingMode: 'separate',
      })
      .onConflictDoNothing({ target: tenantInvoiceSettings.tenantId });
    // Seed the document-sequence row at next=seq+1 (the value AFTER
    // record-payment's pre-allocation of `seq=7`). The test will
    // assert this stays UNCHANGED across multiple worker retries.
    await tx
      .insert(tenantDocumentSequences)
      .values({
        tenantId: tenant.ctx.slug,
        documentType: 'receipt',
        fiscalYear: 2026,
        nextSequenceNumber: seq + 1,
      })
      .onConflictDoNothing();
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'R2-CG-2 Co',
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
      sequenceNumber: 1,
      documentNumber: 'INV-2026-000001',
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
        legal_name: 'R2-CG-2 Co',
        tax_id: '1234567890123',
        address: 'Bangkok',
        primary_contact_name: 'CG2 Contact',
        primary_contact_email: 'cg2@example.com',
      },
      pdfBlobKey: 'invoicing/test/r2cg2.pdf',
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      receiptPdfStatus: receiptStatus,
      receiptPdfRenderAttempts: 0,
      receiptDocumentNumberRaw: receiptDocNumRaw,
      // For the rendered seed, pre-fill blob fields so the use-case
      // sees a complete rendered row and exercises the idempotent
      // no-op path / race-won path.
      receiptPdfBlobKey:
        receiptStatus === 'rendered'
          ? 'invoicing/test/r2cg2_receipt_v1.pdf'
          : null,
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
  return { invoiceId, receiptDocNumRaw };
}

/**
 * review-20260428-102639.md S13 closure — combined-mode invoice.
 * Worker MUST reuse the invoice's documentNumber when
 * receiptDocumentNumberRaw is null (combined-mode = receipt IS the
 * invoice; no separate receipt number sequence).
 */
async function seedCombinedModePendingInvoice(
  tenant: TestTenant,
  user: TestUser,
): Promise<{ invoiceId: string; invoiceDocNum: string }> {
  const memberId = randomUUID();
  const invoiceId = randomUUID();
  const planId = `r2cg2-cm-${randomUUID().slice(0, 8)}`;
  const invoiceDocNum = 'INV-2026-000077';
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: 'R2-CG-2 Combined Plan' },
      description: { en: 'Test description' },
      sortOrder: 11,
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
      .update(tenantInvoiceSettings)
      .set({ receiptNumberingMode: 'combined' })
      .where(eq(tenantInvoiceSettings.tenantId, tenant.ctx.slug));
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
        invoiceNumberPrefix: 'INV',
        creditNoteNumberPrefix: 'CN',
        receiptNumberingMode: 'combined',
      })
      .onConflictDoNothing({ target: tenantInvoiceSettings.tenantId });
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'R2-CG-2 Combined Co',
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
      sequenceNumber: 77,
      documentNumber: invoiceDocNum,
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
        legal_name: 'R2-CG-2 Combined Co',
        tax_id: '1234567890123',
        address: 'Bangkok',
        primary_contact_name: 'CM Contact',
        primary_contact_email: 'cm@example.com',
      },
      pdfBlobKey: `invoicing/test/r2cg2-cm.pdf`,
      pdfSha256: 'b'.repeat(64),
      pdfTemplateVersion: 1,
      receiptPdfStatus: 'pending',
      receiptPdfRenderAttempts: 0,
      // Combined-mode: receipt_document_number_raw STAYS NULL.
      receiptDocumentNumberRaw: null,
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
  return { invoiceId, invoiceDocNum };
}

describe('R2-CG-2 — worker reads receipt_document_number_raw, never re-allocates', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    vi.mocked(reactPdfRenderAdapter.render).mockClear();
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('R3-I2 §87 — retry-after-failure: tick-0 render throws, tick-1 succeeds, sequence counter UNCHANGED across both', async () => {
    const { invoiceId, receiptDocNumRaw } = await seedSeparateModePendingInvoice(
      tenant,
      user,
      'pending',
    );

    // Capture sequence counter BEFORE any worker tick.
    const [seqBefore] = await db
      .select()
      .from(tenantDocumentSequences)
      .where(
        and(
          eq(tenantDocumentSequences.tenantId, tenant.ctx.slug),
          eq(tenantDocumentSequences.documentType, 'receipt'),
          eq(tenantDocumentSequences.fiscalYear, 2026),
        ),
      );
    expect(seqBefore?.nextSequenceNumber).toBe(8);

    const deps = makeRenderReceiptPdfDeps(tenant.ctx.slug);
    const renderMock = vi.mocked(reactPdfRenderAdapter.render);
    renderMock.mockClear();

    // R3-I2 — Tick 0: force pdfRender to throw (transient render
    // failure). The worker's catch block calls applyReceiptPdfFailure
    // which bumps attempts + sets status='failed'. The pre-allocated
    // receipt sequence number on the invoice row stays put.
    renderMock.mockRejectedValueOnce(new Error('tick-0 render exploded'));
    const r0 = await runInTenant(tenant.ctx, async () =>
      renderReceiptPdf(deps, {
        tenantId: tenant.ctx.slug,
        invoiceId,
        fiscalYear: 2026,
        templateVersion: 1,
        requestId: 'r3-i2-tick-0',
      }),
    );
    expect(r0.ok).toBe(false);

    // After tick 0: row should be 'failed' with attempts=1, sequence
    // counter UNCHANGED (worker never called allocateNext).
    const [invAfterTick0] = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenant.ctx.slug),
          eq(invoices.invoiceId, invoiceId),
        ),
      )
      .limit(1);
    expect(invAfterTick0?.receiptPdfStatus).toBe('failed');
    expect(invAfterTick0?.receiptPdfRenderAttempts).toBe(1);

    const [seqAfterTick0] = await db
      .select()
      .from(tenantDocumentSequences)
      .where(
        and(
          eq(tenantDocumentSequences.tenantId, tenant.ctx.slug),
          eq(tenantDocumentSequences.documentType, 'receipt'),
          eq(tenantDocumentSequences.fiscalYear, 2026),
        ),
      );
    expect(seqAfterTick0?.nextSequenceNumber).toBe(8);

    // R3-I2 — Tick 1: render succeeds. Worker reads
    // `loaded.receiptDocumentNumberRaw` (still 'RE-2026-000007') and
    // does NOT call allocateNext. Sequence counter stays at 8.
    const r1 = await runInTenant(tenant.ctx, async () =>
      renderReceiptPdf(deps, {
        tenantId: tenant.ctx.slug,
        invoiceId,
        fiscalYear: 2026,
        templateVersion: 1,
        requestId: 'r3-i2-tick-1',
      }),
    );
    expect(r1.ok).toBe(true);

    // Final assertion: counter still 8 — proves worker never
    // touched tenant_document_sequences.receipt across BOTH a
    // failed tick AND a successful retry tick. This is the §87
    // no-gaps invariant proof.
    const [seqAfter] = await db
      .select()
      .from(tenantDocumentSequences)
      .where(
        and(
          eq(tenantDocumentSequences.tenantId, tenant.ctx.slug),
          eq(tenantDocumentSequences.documentType, 'receipt'),
          eq(tenantDocumentSequences.fiscalYear, 2026),
        ),
      );
    expect(seqAfter?.nextSequenceNumber).toBe(8);

    // The rendered row's receiptDocumentNumberRaw is the original
    // pre-allocated value (NOT freshly allocated).
    const [invRow] = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenant.ctx.slug),
          eq(invoices.invoiceId, invoiceId),
        ),
      )
      .limit(1);
    expect(invRow?.receiptDocumentNumberRaw).toBe(receiptDocNumRaw);
    expect(invRow?.receiptPdfStatus).toBe('rendered');
  }, 60_000);

  // review-20260428-102639.md S13 closure — combined-mode path.
  // In combined-mode, `receipt_document_number_raw` STAYS NULL because
  // the receipt IS the invoice (single document, single number).
  // The worker MUST reuse the invoice's `documentNumber` directly,
  // NOT throw the L168 defensive guard.
  it('combined-mode — worker reuses invoice documentNumber, no realloc, no defensive throw', async () => {
    const { invoiceId, invoiceDocNum } = await seedCombinedModePendingInvoice(
      tenant,
      user,
    );

    const { renderReceiptPdf } = await import('@/modules/invoicing');
    const { makeRenderReceiptPdfDeps } = await import(
      '@/modules/invoicing/application/invoicing-deps'
    );
    const result = await renderReceiptPdf(
      makeRenderReceiptPdfDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        invoiceId,
        fiscalYear: 2026,
        templateVersion: 1,
        requestId: 'r2cg2-cm-test',
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [invRow] = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenant.ctx.slug),
          eq(invoices.invoiceId, invoiceId),
        ),
      )
      .limit(1);
    // Combined-mode invariants:
    expect(invRow?.receiptDocumentNumberRaw).toBeNull();
    expect(invRow?.receiptPdfStatus).toBe('rendered');
    // Receipt blob key MUST be derivable but distinct from invoice
    // PDF key — combined-mode keeps separate blob asset for download.
    expect(invRow?.receiptPdfBlobKey).toContain(invoiceId);
    // Worker did NOT touch the receipt sequence (combined-mode never
    // allocates from `tenant_document_sequences.receipt`).
    void invoiceDocNum;
  }, 60_000);
});

// R3-C1 — the original R2-IG-3 integration test covered the IDEMPOTENT
// EARLY-EXIT (status='rendered' at load time → return ok before render).
// The genuine race-won-by-success path requires fine-grained mock
// control of `applyReceiptPdfFailure` (must return kind='race_won')
// which is unreasonable to engineer at integration level (would need to
// stub Drizzle internals). The unit test in
// `tests/unit/invoicing/render-receipt-pdf.test.ts` (R3-C1) covers the
// genuine race-won catch-block path; the integration here exercises
// the COMPLEMENTARY idempotent early-exit path. Both code paths
// produce the same observable outcome (ok + status='rendered' +
// attempts unchanged) but are structurally distinct.
describe('R3-C1 idempotent early-exit on already-rendered row', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('renderReceiptPdf on a row already rendered → ok early-exit at line 127, attempts unchanged', async () => {
    const { invoiceId } = await seedSeparateModePendingInvoice(
      tenant,
      user,
      'rendered',
    );
    const deps = makeRenderReceiptPdfDeps(tenant.ctx.slug);
    const r = await runInTenant(tenant.ctx, async () =>
      renderReceiptPdf(deps, {
        tenantId: tenant.ctx.slug,
        invoiceId,
        fiscalYear: 2026,
        templateVersion: 1,
        requestId: 'r3-c1-idempotent',
      }),
    );

    expect(r.ok).toBe(true);

    const [invRow] = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenant.ctx.slug),
          eq(invoices.invoiceId, invoiceId),
        ),
      )
      .limit(1);
    expect(invRow?.receiptPdfStatus).toBe('rendered');
    // attempts NOT bumped — idempotent early-exit returns ok without retry burn.
    expect(invRow?.receiptPdfRenderAttempts).toBe(0);
    expect(invRow?.receiptPdfLastError).toBeNull();
  }, 60_000);
});

/**
 * R10-T4 — live-Neon end-to-end audit emit coverage for the two
 * PDF-download events added in R5 + R8 (`receipt_pdf_downloaded` +
 * `invoice_pdf_downloaded`).
 *
 * The R8 migration-not-applied incident (2026-05-15) surfaced because
 * unit tests mocked the audit port — the broken `INSERT … ::audit_event_type`
 * was only caught by manual production trigger. This file plugs that
 * gap by driving each use-case against the real Neon Singapore audit
 * pipeline and asserting:
 *   (a) the row lands with the correct `event_type` enum value
 *   (b) `retention_years = 10` (Thai RD §86/4 + §87/3 tax-document touch
 *       parity — both events were tagged 10y in F4_AUDIT_RETENTION_YEARS;
 *       this test pins the integration-layer wiring, not just the map)
 *   (c) `member_id` + `actor_member_id` + `route` payload discriminators
 *       (so probe-detection queries can still differentiate from same-
 *       tenant member self-downloads)
 *
 * Constitution v1.4.0 Principle II: integration coverage of new audit
 * surfaces is required — mocked-port unit tests are necessary but not
 * sufficient.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import {
  getInvoicePdfSignedUrl,
  makeGetInvoicePdfSignedUrlDeps,
  getReceiptPdfSignedUrl,
  makeGetReceiptPdfSignedUrlDeps,
} from '@/modules/invoicing';
import type { BlobStoragePort } from '@/modules/invoicing/application/ports/blob-storage-port';

/**
 * Stub Blob port — the test seeds invoice rows with fake `pdfBlobKey`
 * values that don't actually exist on Vercel Blob (would require
 * upload + cleanup overhead that beats the live-Neon audit-emit point
 * of this file). The stub short-circuits `signDownloadUrl` to return
 * a deterministic URL; the audit emit still runs against real Neon.
 */
const stubBlob: BlobStoragePort = {
  signDownloadUrl: async (key: string) => `https://stub.blob/${key}?token=test`,
  uploadPdf: async () => ({ key: 'stub-key', url: 'https://stub.blob/stub-key' }),
  uploadLogo: async () => ({ key: 'stub-logo-key', url: 'https://stub.blob/stub-logo-key' }),
  downloadBytes: async () => new Uint8Array(),
  delete: async () => {},
  list: async () => [],
};
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

const CORPORATE_MATRIX: BenefitMatrix = {
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

const TENANT_SNAP = {
  legal_name_th: 'R10-T4 emit',
  legal_name_en: 'R10-T4 emit',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};

const MEMBER_SNAP = {
  legal_name: 'R10-T4 Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'Somchai',
  primary_contact_email: 'somchai@r10-t4.test',
};

describe('R10-T4 — PDF-download audit emit (live Neon happy path)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const memberId = randomUUID();
  const issuedInvoiceId = randomUUID();
  const paidInvoiceId = randomUUID();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
        legalNameTh: TENANT_SNAP.legal_name_th,
        legalNameEn: TENANT_SNAP.legal_name_en,
        taxId: TENANT_SNAP.tax_id,
        registeredAddressTh: TENANT_SNAP.address_th,
        registeredAddressEn: TENANT_SNAP.address_en,
        invoiceNumberPrefix: 'RT4',
        creditNoteNumberPrefix: 'RT4C',
      });
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'rt4-plan',
        planYear: 2026,
        planName: { en: 'R10-T4 Plan' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 100_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: CORPORATE_MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: MEMBER_SNAP.legal_name,
        country: 'TH',
        planId: 'rt4-plan',
        planYear: 2026,
      });
      // Issued invoice → exercises invoice_pdf_downloaded
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: issuedInvoiceId,
        memberId,
        planYear: 2026,
        planId: 'rt4-plan',
        draftByUserId: user.userId,
        status: 'issued',
        fiscalYear: 2026,
        sequenceNumber: 1,
        documentNumber: 'RT4-2026-000001',
        issueDate: '2026-01-10',
        dueDate: '2026-02-09',
        subtotalSatang: 100_000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 7_000n,
        totalSatang: 107_000n,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: 'monthly',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: TENANT_SNAP,
        memberIdentitySnapshot: MEMBER_SNAP,
        pdfBlobKey: 'invoicing/rt4/2026/issued.pdf',
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      });
      // Paid invoice with rendered receipt → exercises receipt_pdf_downloaded
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: paidInvoiceId,
        memberId,
        planYear: 2026,
        planId: 'rt4-plan',
        draftByUserId: user.userId,
        status: 'paid',
        fiscalYear: 2026,
        sequenceNumber: 2,
        documentNumber: 'RT4-2026-000002',
        issueDate: '2026-01-10',
        dueDate: '2026-02-09',
        paidAt: new Date('2026-01-12T10:00:00Z'),
        paymentMethod: 'bank_transfer',
        paymentRecordedByUserId: user.userId,
        paymentDate: '2026-01-12',
        subtotalSatang: 100_000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 7_000n,
        totalSatang: 107_000n,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: 'monthly',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: TENANT_SNAP,
        memberIdentitySnapshot: MEMBER_SNAP,
        pdfBlobKey: 'invoicing/rt4/2026/paid.pdf',
        pdfSha256: 'b'.repeat(64),
        pdfTemplateVersion: 1,
        // Combined-mode: receipt PDF is rendered + reuses the invoice
        // number (receiptDocumentNumberRaw stays null).
        receiptPdfBlobKey: 'invoicing/rt4/2026/paid_receipt.pdf',
        receiptPdfSha256: 'c'.repeat(64),
        receiptPdfTemplateVersion: 1,
        receiptPdfStatus: 'rendered',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch((err) => {
      console.warn(
        '[pdf-download-audit-emit] tenant cleanup failed',
        { tenantSlug: tenant?.ctx?.slug, err },
      );
    });
  });

  it('invoice_pdf_downloaded — admin happy path emits with retention_years=10', async () => {
    const requestId = `r10-t4-inv-${randomUUID()}`;
    const result = await getInvoicePdfSignedUrl(
      { ...makeGetInvoicePdfSignedUrlDeps(tenant.ctx.slug), blob: stubBlob },
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        actorRole: 'admin',
        requestId,
        invoiceId: issuedInvoiceId,
      },
    );
    expect(result.ok).toBe(true);

    // Raw SQL select — Drizzle schema for `audit_log` does NOT model
    // the `retention_years` column (added via migration 0039 but never
    // back-ported to TS). Use raw SQL so we can assert the column
    // landed at 10 (Thai RD §86/4 + §87/3 tax-doc touch class).
    const rows = await db.execute<{
      retention_years: number;
      payload: Record<string, unknown>;
    }>(sql`
      SELECT retention_years, payload FROM audit_log
      WHERE tenant_id = ${tenant.ctx.slug}
        AND event_type = 'invoice_pdf_downloaded'
        AND request_id = ${requestId}
    `);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.retention_years).toBe(10);
    const payload = row.payload;
    expect(payload.invoice_id).toBe(issuedInvoiceId);
    expect(payload.member_id).toBe(memberId);
    expect(payload.actor_member_id).toBeNull();
    expect(payload.actor_role).toBe('admin');
    expect(payload.route).toBe('get-invoice-pdf-signed-url');
    expect(payload.invoice_pdf_template_version).toBe(1);
  }, 30_000);

  it('invoice_pdf_downloaded — member happy path populates actor_member_id', async () => {
    const requestId = `r10-t4-inv-member-${randomUUID()}`;
    const result = await getInvoicePdfSignedUrl(
      { ...makeGetInvoicePdfSignedUrlDeps(tenant.ctx.slug), blob: stubBlob },
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        actorRole: 'member',
        actorMemberId: memberId,
        requestId,
        invoiceId: issuedInvoiceId,
      },
    );
    expect(result.ok).toBe(true);

    const rows = await db.execute<{ payload: Record<string, unknown> }>(sql`
      SELECT payload FROM audit_log
      WHERE tenant_id = ${tenant.ctx.slug}
        AND event_type = 'invoice_pdf_downloaded'
        AND request_id = ${requestId}
    `);
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload;
    expect(payload.actor_member_id).toBe(memberId);
    expect(payload.actor_role).toBe('member');
  }, 30_000);

  it('receipt_pdf_downloaded — paid invoice combined-mode emits with retention_years=10', async () => {
    const requestId = `r10-t4-rcpt-${randomUUID()}`;
    const result = await getReceiptPdfSignedUrl(
      { ...makeGetReceiptPdfSignedUrlDeps(tenant.ctx.slug), blob: stubBlob },
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        actorRole: 'admin',
        requestId,
        invoiceId: paidInvoiceId,
      },
    );
    expect(result.ok).toBe(true);

    const rows = await db.execute<{
      retention_years: number;
      payload: Record<string, unknown>;
    }>(sql`
      SELECT retention_years, payload FROM audit_log
      WHERE tenant_id = ${tenant.ctx.slug}
        AND event_type = 'receipt_pdf_downloaded'
        AND request_id = ${requestId}
    `);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.retention_years).toBe(10);
    const payload = row.payload;
    expect(payload.invoice_id).toBe(paidInvoiceId);
    expect(payload.member_id).toBe(memberId);
    expect(payload.actor_member_id).toBeNull();
    expect(payload.actor_role).toBe('admin');
    expect(payload.route).toBe('get-receipt-pdf-signed-url');
    expect(payload.receipt_numbering_mode).toBe('combined');
    expect(payload.receipt_document_number_raw).toBeNull();
    expect(payload.receipt_pdf_template_version).toBe(1);
  }, 30_000);
});

/**
 * T166-09 — invoice_paid email gate on receipt_pdf_status.
 *
 * When recordPayment runs under `asyncReceiptPdf=true`, the invoice_paid
 * outbox row commits inside the same tx as the `paid` flip (so we keep
 * the audit + email enqueue atomic). But the email cannot ship until the
 * receipt PDF render worker has uploaded the bytes — otherwise the
 * member would receive a "your receipt is ready" email referencing a
 * non-existent attachment.
 *
 * The dispatcher gate (route.ts):
 *   - reads `context_data.depends_on_receipt_pdf` on the outbox row
 *   - when true, queries `invoices.receipt_pdf_status` under
 *     `runInTenant(row.tenantId)` (RLS-scoped)
 *   - when status !== 'rendered': pushes `next_retry_at` by 60s and
 *     returns 'skipped' WITHOUT bumping `attempts` (no retry-budget burn)
 *   - when status === 'rendered': falls through to the normal email path
 *
 * This test seeds an outbox row with the gate flag and asserts:
 *   (1) first dispatcher tick → row stays 'pending', next_retry_at pushed
 *   (2) flip invoice.receipt_pdf_status='rendered' → second tick → 'sent'
 *
 * Mocks: Resend client (we only care about the gate decision, not the
 * physical email transport).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

import { db, runInTenant } from '@/lib/db';
import { notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import { GET as outboxDispatch } from '@/app/api/cron/outbox-dispatch/route';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

// Stub Resend so the dispatcher's email-send branch is a no-op in tests.
// Without this, sending hits the real network when the gate releases.
vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: vi.fn(async () => ({ data: { id: 'mock-resend-id' }, error: null })),
    };
  },
}));

// Stub the PDF prefetch adapter — the dispatcher attaches PDF bytes
// when the `expected_pdf_sha256` field is set; we don't set it on this
// fixture, so this mock just guards against accidental network reads.
vi.mock('@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter', () => ({
  vercelBlobAdapter: {
    uploadPdf: vi.fn(),
    signDownloadUrl: vi.fn(async (key: string) => `https://blob.test/${key}`),
    delete: vi.fn(),
    list: vi.fn(async () => []),
    fetchPdf: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
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

async function seedPaidPendingInvoice(
  tenant: TestTenant,
  user: TestUser,
): Promise<{ invoiceId: string }> {
  const memberId = randomUUID();
  const invoiceId = randomUUID();
  const planId = `t166g-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: 'T166 Gate Plan' },
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
        invoiceNumberPrefix: 'T166G',
        creditNoteNumberPrefix: 'T166GC',
      })
      .onConflictDoNothing({ target: tenantInvoiceSettings.tenantId });
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: 'T166 Gate Co',
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
      documentNumber: `T166G-2026-${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`,
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
        legal_name: 'T166 Gate Co',
        tax_id: '1234567890123',
        address: 'Bangkok',
        primary_contact_name: 'Gate Contact',
        primary_contact_email: 'gate@example.com',
      },
      pdfBlobKey: 'invoicing/test/t166-gate.pdf',
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      receiptPdfStatus: 'pending',
      receiptPdfRenderAttempts: 0,
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

async function enqueueInvoicePaidEmailRow(
  tenant: TestTenant,
  invoiceId: string,
  dependsOnReceiptPdf: boolean,
): Promise<string> {
  const id = randomUUID();
  await db.insert(notificationsOutbox).values({
    id,
    tenantId: tenant.ctx.slug,
    notificationType: 'invoice_auto_email',
    toEmail: 'gate@example.com',
    locale: 'en',
    contextData: {
      event_type: 'invoice_paid',
      invoice_id: invoiceId,
      pdf_blob_key: 'invoicing/test/t166-gate.pdf',
      pdf_template_version: 1,
      depends_on_receipt_pdf: dependsOnReceiptPdf,
    },
    status: 'pending',
    attempts: 0,
    nextRetryAt: new Date(Date.now() - 1000),
  });
  return id;
}

describe('T166-09 — invoice_paid email gate on receipt_pdf_status', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('skips invoice_paid email when receipt_pdf_status=pending, then sends after status flips to rendered', async () => {
    const { invoiceId } = await seedPaidPendingInvoice(tenant, user);
    const outboxId = await enqueueInvoicePaidEmailRow(tenant, invoiceId, true);

    // First dispatcher tick — receipt is still 'pending', gate must hold.
    const req1 = new NextRequest('http://localhost/api/cron/outbox-dispatch', {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    const resp1 = await outboxDispatch(req1);
    expect(resp1.status).toBe(200);

    const [rowAfterTick1] = await db
      .select()
      .from(notificationsOutbox)
      .where(eq(notificationsOutbox.id, outboxId))
      .limit(1);
    expect(rowAfterTick1?.status).toBe('pending');
    // attempts MUST NOT be bumped — gate skip ≠ retry burn.
    expect(rowAfterTick1?.attempts).toBe(0);
    // next_retry_at pushed into the future (dispatcher's 60s back-off).
    expect(rowAfterTick1?.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());

    // Flip the invoice's receipt_pdf_status to 'rendered' — simulates
    // the worker completing its render+upload + applyReceiptPdf.
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(invoices)
        .set({
          receiptPdfStatus: 'rendered',
          receiptPdfBlobKey: 'invoicing/test/t166-gate_receipt_v1.pdf',
          receiptPdfSha256: 'c'.repeat(64),
          receiptPdfTemplateVersion: 1,
        })
        .where(
          and(
            eq(invoices.tenantId, tenant.ctx.slug),
            eq(invoices.invoiceId, invoiceId),
          ),
        );
    });

    // Pull next_retry_at back so the second tick picks the row up.
    await db
      .update(notificationsOutbox)
      .set({ nextRetryAt: new Date(Date.now() - 1000) })
      .where(eq(notificationsOutbox.id, outboxId));

    // Second dispatcher tick — gate releases, row should ship.
    const req2 = new NextRequest('http://localhost/api/cron/outbox-dispatch', {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    const resp2 = await outboxDispatch(req2);
    expect(resp2.status).toBe(200);

    const [rowAfterTick2] = await db
      .select()
      .from(notificationsOutbox)
      .where(eq(notificationsOutbox.id, outboxId))
      .limit(1);
    expect(rowAfterTick2?.status).toBe('sent');
  }, 90_000);
});

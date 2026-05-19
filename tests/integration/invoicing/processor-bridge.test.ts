/**
 * T015 — F5 → F4 processor-bridge integration tests.
 *
 * Verifies the 3 F5 bridge wrappers against live Neon Singapore:
 *   1. `getInvoiceForPayment`          — DTO projection of existing F4 invoice
 *   2. `markPaidFromProcessor`         — processor-semantic input → F4 recordPayment
 *                                        end-to-end; asserts status='paid', payment
 *                                        reference/notes carry Stripe metadata
 *   3. `issueCreditNoteFromRefund`     — R2-E4 sister test; asserts the
 *                                        resulting credit_notes row has
 *                                        `source_refund_id` populated
 *
 * Mocking policy: the wrappers internally call `makeRecordPaymentDeps` /
 * `makeIssueCreditNoteDeps` which wire the FULL real adapters (pdf-
 * render + Blob + outbox + sequence allocator). We mock pdf/blob/outbox
 * at module-level via vi.mock because the SYSTEM UNDER TEST is the F4
 * bridge composition + DB persistence, not the real PDF/Blob/email
 * round-trip (those are covered by F4's own integration suite). Real
 * paths: DB, RLS, sequence allocator, audit emission.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asSatang } from '@/lib/money';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { payments, refunds } from '@/modules/payments/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

// --- Module-level mocks of external adapters --------------------------------
// The wrappers call makeXDeps() which wires these adapters. We mock the
// whole adapter module surface so every call returns deterministic stubs.
// The DB side (invoice repo, credit-note repo, sequence allocator, audit
// adapter) stays real.
vi.mock('@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter', async () => {
  // Dynamic import inside vi.mock factory so Sha256Hex resolves before the
  // mock resolves (module-level import can race with mock hoisting).
  const { Sha256Hex: S } = await import(
    '@/modules/invoicing/domain/value-objects/sha256-hex'
  );
  return {
    reactPdfRenderAdapter: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // '%PDF'
        sha256: S.ofUnsafe('b'.repeat(64)),
      })),
    },
  };
});
vi.mock('@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter', () => ({
  vercelBlobAdapter: {
    uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
      key,
      url: `https://blob.test/${key}`,
    })),
    uploadLogo: vi.fn(async ({ key }: { key: string }) => ({
      key,
      url: `https://blob.test/${key}`,
    })),
    signDownloadUrl: vi.fn(async () => 'https://blob.test/signed'),
    downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => [] as string[]),
  },
}));
vi.mock('@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter', () => ({
  resendEmailOutboxAdapter: {
    enqueue: vi.fn(async () => {}),
  },
}));

// Imports that depend on the mocked modules MUST come after the vi.mock calls.
import { getInvoiceForPayment } from '@/modules/invoicing/application/use-cases/get-invoice-for-payment';
import { markPaidFromProcessor } from '@/modules/invoicing/application/use-cases/mark-paid-from-processor';
import { issueCreditNoteFromRefund } from '@/modules/invoicing/application/use-cases/issue-credit-note-from-refund';
import { makeGetInvoiceDeps } from '@/modules/invoicing/application/invoicing-deps';

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

const INVOICE_TOTAL = 107_000n;
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
  legal_name: 'Bridge Test Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

/**
 * Seed an invoice in `issued` (for markPaidFromProcessor) or `paid`
 * (for issueCreditNoteFromRefund) status with all snapshot + money
 * columns populated so CHECK constraints pass.
 */
async function seedInvoice(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  status: 'issued' | 'paid',
): Promise<{ invoiceId: string; memberId: string }> {
  const invoiceId = randomUUID();
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: 'Bridge Test Co',
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
      status,
      fiscalYear: 2026,
      sequenceNumber: 1,
      documentNumber: 'BRDG-2026-000001',
      issueDate: '2026-04-15',
      dueDate: '2026-05-14',
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
      paymentDate: status === 'paid' ? '2026-04-20' : null,
      paidAt: status === 'paid' ? new Date('2026-04-20T03:00:00Z') : null,
      // T166 migration 0056 — `invoices_paid_has_receipt_status` CHECK
      // constraint requires `receipt_pdf_status` to be NOT NULL on
      // every `paid` row. Pre-T166 fixtures predated this constraint.
      // Seed with 'rendered' (matches the migration's backfill of
      // existing paid rows) so the INSERT passes the CHECK + downstream
      // tests don't accidentally exercise the async pipeline.
      receiptPdfStatus: status === 'paid' ? 'rendered' : null,
    });
    await tx.insert(invoiceLines).values({
      tenantId: tenant.ctx.slug,
      lineId: randomUUID(),
      invoiceId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก 2026',
      descriptionEn: 'Membership 2026',
      unitPriceSatang: INVOICE_SUBTOTAL,
      totalSatang: INVOICE_SUBTOTAL,
      position: 1,
    });
  });
  return { invoiceId, memberId };
}

describe('F5 → F4 processor-bridge integration (T015)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'bridge-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Bridge Plan' },
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
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: asSatang(0n),
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'BRDG',
        creditNoteNumberPrefix: 'CN',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  beforeEach(async () => {
    await runInTenant(tenant.ctx, async (tx) => {
      // Order matters for FK RESTRICT: credit_notes → refunds → payments,
      // and refunds → invoices, so delete CNs first, then refunds, then
      // payments, then invoices, then members.
      await tx.delete(creditNotes).where(eq(creditNotes.tenantId, tenant.ctx.slug));
      await tx.delete(refunds).where(eq(refunds.tenantId, tenant.ctx.slug));
      await tx.delete(payments).where(eq(payments.tenantId, tenant.ctx.slug));
      await tx.delete(invoiceLines).where(eq(invoiceLines.tenantId, tenant.ctx.slug));
      await tx.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug));
      await tx.delete(members).where(eq(members.tenantId, tenant.ctx.slug));
    });
  });

  // -----------------------------------------------------------------------
  // T014 — getInvoiceForPayment DTO projection
  // -----------------------------------------------------------------------
  it('getInvoiceForPayment projects {id,status,totalSatang,memberId,tenantId} DTO', async () => {
    const { invoiceId, memberId } = await seedInvoice(tenant, user, planId, 'issued');

    const result = await runInTenant(tenant.ctx, async () => {
      return getInvoiceForPayment(makeGetInvoiceDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        invoiceId,
      });
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(invoiceId);
    expect(result.value.status).toBe('issued');
    expect(result.value.totalSatang).toBe(INVOICE_TOTAL);
    expect(result.value.memberId).toBe(memberId);
    expect(result.value.tenantId).toBe(tenant.ctx.slug);
  }, 30_000);

  it('getInvoiceForPayment returns not_found when invoice does not exist', async () => {
    const fakeId = randomUUID();
    const result = await runInTenant(tenant.ctx, async () => {
      return getInvoiceForPayment(makeGetInvoiceDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        invoiceId: fakeId,
      });
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
  }, 30_000);

  // -----------------------------------------------------------------------
  // T012 — markPaidFromProcessor end-to-end
  // -----------------------------------------------------------------------
  it('markPaidFromProcessor transitions issued → paid + persists Stripe metadata', async () => {
    const { invoiceId } = await seedInvoice(tenant, user, planId, 'issued');

    const result = await runInTenant(tenant.ctx, async () => {
      return markPaidFromProcessor({
        tenantId: tenant.ctx.slug,
        invoiceId,
        actorUserId: user.userId,
        method: 'stripe_card',
        paymentIntentId: 'pi_test_abc123',
        chargeId: 'ch_test_xyz789',
        settlementDate: '2026-04-23',
      });
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify invoice row reflects the F4 → F5 mapping
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: invoices.status,
          paymentMethod: invoices.paymentMethod,
          paymentReference: invoices.paymentReference,
          paymentNotes: invoices.paymentNotes,
          paymentDate: invoices.paymentDate,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(row?.status).toBe('paid');
    // F4 enum doesn't include Stripe methods — wrapper maps to 'other'
    expect(row?.paymentMethod).toBe('other');
    // Processor intent id carried via payment_reference
    expect(row?.paymentReference).toBe('pi_test_abc123');
    // Human-readable hint in paymentNotes names both rail + ids
    expect(row?.paymentNotes).toContain('Stripe card');
    expect(row?.paymentNotes).toContain('pi_test_abc123');
    expect(row?.paymentNotes).toContain('ch_test_xyz789');
    expect(row?.paymentDate).toBe('2026-04-23');
  }, 30_000);

  it('markPaidFromProcessor handles PromptPay (null charge id) — paymentNotes omits charge=', async () => {
    const { invoiceId } = await seedInvoice(tenant, user, planId, 'issued');

    const result = await runInTenant(tenant.ctx, async () => {
      return markPaidFromProcessor({
        tenantId: tenant.ctx.slug,
        invoiceId,
        actorUserId: user.userId,
        method: 'stripe_promptpay',
        paymentIntentId: 'pi_test_pp456',
        chargeId: null,
        settlementDate: '2026-04-23',
      });
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ paymentNotes: invoices.paymentNotes })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(row?.paymentNotes).toContain('Stripe PromptPay');
    expect(row?.paymentNotes).toContain('pi_test_pp456');
    expect(row?.paymentNotes).not.toContain('charge=');
  }, 30_000);

  // -----------------------------------------------------------------------
  // T013 — issueCreditNoteFromRefund persists source_refund_id
  // -----------------------------------------------------------------------
  it('issueCreditNoteFromRefund creates CN with populated source_refund_id', async () => {
    const { invoiceId, memberId } = await seedInvoice(tenant, user, planId, 'paid');
    // Seed a real Payment + Refund row first — credit_notes.source_refund_id
    // has FK to refunds(id) ON DELETE RESTRICT; CN insert fails without a
    // matching refund row.
    const paymentId = `pay-${randomUUID()}`;
    const refundId = `rfnd-${randomUUID()}`;
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(payments).values({
        id: paymentId,
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        method: 'card',
        status: 'succeeded',
        amountSatang: INVOICE_TOTAL,
        currency: 'THB',
        processorPaymentIntentId: `pi_test_${randomUUID()}`,
        processorChargeId: `ch_test_${randomUUID()}`,
        processorEnvironment: 'test',
        attemptSeq: 1,
        cardBrand: 'visa',
        cardLast4: '4242',
        cardExpMonth: 12,
        cardExpYear: 2030,
        initiatedAt: new Date('2026-04-20T03:00:00Z'),
        completedAt: new Date('2026-04-20T03:00:10Z'),
        actorUserId: user.userId,
        correlationId: 'test-corr-payment',
      });
      await tx.insert(refunds).values({
        id: refundId,
        tenantId: tenant.ctx.slug,
        paymentId,
        invoiceId,
        amountSatang: asSatang(53_500n),
        reason: 'Customer requested partial refund',
        // `pending` here so the succeeded-iff biconditional CHECK lets us
        // insert without processor_refund_id + credit_note_id. F5 refund
        // flow will flip to 'succeeded' + attach CN in the real use-case.
        status: 'pending',
        initiatedAt: new Date('2026-04-23T03:00:00Z'),
        initiatorUserId: user.userId,
        correlationId: 'test-corr-refund',
      });
    });

    const result = await runInTenant(tenant.ctx, async () => {
      return issueCreditNoteFromRefund({
        tenantId: tenant.ctx.slug,
        invoiceId,
        refundId,
        amountSatang: asSatang(53_500n), // partial refund (50% of total)
        reason: 'Customer requested partial refund',
        actorUserId: user.userId,
      });
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourceRefundId).toBe(refundId);

    // Verify the DB row — not just the in-memory return value.
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          sourceRefundId: creditNotes.sourceRefundId,
          reason: creditNotes.reason,
        })
        .from(creditNotes)
        .where(eq(creditNotes.tenantId, tenant.ctx.slug)),
    );
    expect(row?.sourceRefundId).toBe(refundId);
    expect(row?.reason).toBe('Customer requested partial refund');

    // Parent invoice should be partially_credited (53_500 < 107_000).
    const [inv] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ status: invoices.status })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(inv?.status).toBe('partially_credited');
  }, 30_000);

  it('F4-manual issueCreditNote still produces source_refund_id=NULL', async () => {
    // Regression guard — the optional `sourceRefundId` param must not
    // leak a non-null value when not supplied. F4 admin-issued CNs
    // continue to carry NULL as before sub-batch B extension.
    const { invoiceId } = await seedInvoice(tenant, user, planId, 'paid');

    // Import lazily to avoid hoisting interactions with the mocks above.
    const { issueCreditNote } = await import(
      '@/modules/invoicing/application/use-cases/issue-credit-note'
    );
    const { makeIssueCreditNoteDeps } = await import(
      '@/modules/invoicing/application/invoicing-deps'
    );

    const result = await runInTenant(tenant.ctx, async () => {
      return issueCreditNote(makeIssueCreditNoteDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        invoiceId,
        creditTotalSatang: asSatang(10_000n),
        reason: 'F4 manual issue',
      });
    });
    expect(result.ok).toBe(true);

    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ sourceRefundId: creditNotes.sourceRefundId })
        .from(creditNotes)
        .where(eq(creditNotes.tenantId, tenant.ctx.slug)),
    );
    expect(row?.sourceRefundId).toBeNull();
  }, 30_000);
});

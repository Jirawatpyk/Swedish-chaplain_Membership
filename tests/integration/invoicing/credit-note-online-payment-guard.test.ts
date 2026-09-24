/**
 * Manual credit note vs a refundable ONLINE (Stripe) payment (live Postgres).
 *
 * The trap: the F5 refund pre-flight caps every Stripe refund at the
 * invoice's un-credited headroom (`total − credited`, see
 * `checkRefundNotExceedingRemainder`). A MANUAL credit note moves no money,
 * yet it consumes that headroom — so after a manual full CN on a card /
 * PromptPay-paid invoice the member's payment can no longer be refunded
 * through the system at all (a partial CN of X locks X out the same way).
 *
 * The guard: `issueCreditNote` refuses a manual CN (no `sourceRefundId`) with
 * `online_payment_refundable` while the invoice carries a succeeded online
 * payment with refundable money left, UNLESS the caller explicitly sends
 * `onlinePaymentRefundAcknowledged: true` (legitimate cases exist — e.g. the
 * money went back by bank transfer). The refusal happens before `allocateNext`
 * so no §87 credit-note number is burned.
 *
 * Deps are the REAL composition (`makeIssueCreditNoteDeps`) so the
 * invoicing→payments seam is exercised against real `payments` rows; only
 * the PDF render, Blob upload and outbox are stubbed.
 *
 * Run in isolation:
 *   pnpm test:integration tests/integration/invoicing/credit-note-online-payment-guard.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { issueCreditNote, makeIssueCreditNoteDeps } from '@/modules/invoicing';
import type { IssueCreditNoteDeps } from '@/modules/invoicing/application/use-cases/issue-credit-note';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { payments } from '@/modules/payments/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
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
  legal_name: 'Online CN Guard Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

/**
 * Seed a `paid` membership invoice. `channel: 'card'` also seeds a succeeded
 * F5 payment for the full total (and stamps the invoice the way
 * `markPaidFromProcessor` does — `payment_method='other'`); `'bank_transfer'`
 * is a manually-recorded payment with no F5 row.
 */
async function seedPaidInvoice(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  channel: 'card' | 'bank_transfer',
): Promise<{ invoiceId: string }> {
  const invoiceId = randomUUID();
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Online CN Guard Co',
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
      pdfDocKind: 'invoice',
      receiptPdfStatus: 'rendered',
      fiscalYear: 2026,
      sequenceNumber: 1,
      documentNumber: 'OCG-2026-000001',
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
      paymentMethod: channel === 'card' ? 'other' : 'bank_transfer',
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
    if (channel === 'card') {
      const now = new Date('2026-02-01T03:00:00Z');
      await tx.insert(payments).values({
        id: `pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        method: 'card',
        status: 'succeeded',
        amountSatang: INVOICE_TOTAL,
        currency: 'THB',
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        processorChargeId: `ch_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        attemptSeq: 1,
        cardBrand: 'visa',
        cardLast4: '4242',
        cardExpMonth: 12,
        cardExpYear: 2030,
        initiatedAt: now,
        completedAt: now,
        actorUserId: user.userId,
        correlationId: 'corr-online-cn-guard',
      });
    }
  });
  return { invoiceId };
}

/** Real composition; only PDF render / Blob / outbox / clock are stubbed. */
function makeDeps(tenantId: string): IssueCreditNoteDeps {
  return {
    ...makeIssueCreditNoteDeps(tenantId),
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
    clock: { nowIso: () => '2026-04-18T10:00:00Z' },
    outbox: { enqueue: vi.fn(async () => {}) },
  };
}

describe('manual credit note vs a refundable online payment', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'online-cn-guard-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Online CN Guard Plan' },
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
        invoiceNumberPrefix: 'OCG',
        creditNoteNumberPrefix: 'OCGC',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  beforeEach(async () => {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.delete(creditNotes).where(eq(creditNotes.tenantId, tenant.ctx.slug));
      await tx.delete(payments).where(eq(payments.tenantId, tenant.ctx.slug));
      await tx.delete(invoiceLines).where(eq(invoiceLines.tenantId, tenant.ctx.slug));
      await tx.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug));
      await tx.delete(members).where(eq(members.tenantId, tenant.ctx.slug));
    });
  });

  async function readInvoiceAndCnCount(invoiceId: string) {
    return runInTenant(tenant.ctx, async (tx) => {
      const [inv] = await tx
        .select({
          status: invoices.status,
          creditedTotalSatang: invoices.creditedTotalSatang,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId));
      const cns = await tx
        .select({ id: creditNotes.creditNoteId })
        .from(creditNotes)
        .where(eq(creditNotes.originalInvoiceId, invoiceId));
      return {
        status: inv?.status,
        credited: BigInt(inv!.creditedTotalSatang as unknown as string),
        cnCount: cns.length,
      };
    });
  }

  it('refuses a FULL manual CN on a card-paid invoice without the acknowledgement — no CN, no headroom consumed', async () => {
    const { invoiceId } = await seedPaidInvoice(tenant, user, planId, 'card');

    const r = await issueCreditNote(makeDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      creditTotalSatang: INVOICE_TOTAL,
      reason: 'member asked for a refund',
      membershipEffect: 'cancel_membership',
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('online_payment_refundable');
    // The payment's refund headroom is untouched: still fully refundable.
    expect(await readInvoiceAndCnCount(invoiceId)).toEqual({
      status: 'paid',
      credited: 0n,
      cnCount: 0,
    });
  }, 60_000);

  it('refuses a PARTIAL manual CN on a card-paid invoice too — a partial CN locks the same amount out of refund', async () => {
    const { invoiceId } = await seedPaidInvoice(tenant, user, planId, 'card');

    const r = await issueCreditNote(makeDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      creditTotalSatang: 53_500n,
      reason: 'partial correction',
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('online_payment_refundable');
    expect(await readInvoiceAndCnCount(invoiceId)).toEqual({
      status: 'paid',
      credited: 0n,
      cnCount: 0,
    });
  }, 60_000);

  it('issues the manual CN on a card-paid invoice when staff explicitly acknowledge it', async () => {
    const { invoiceId } = await seedPaidInvoice(tenant, user, planId, 'card');

    const r = await issueCreditNote(makeDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      creditTotalSatang: INVOICE_TOTAL,
      reason: 'refunded by bank transfer (card expired)',
      membershipEffect: 'keep',
      onlinePaymentRefundAcknowledged: true,
    });

    expect(r.ok).toBe(true);
    expect(await readInvoiceAndCnCount(invoiceId)).toEqual({
      status: 'credited',
      credited: INVOICE_TOTAL,
      cnCount: 1,
    });

    // The override is on the (10-year) audit trail, with what was refundable.
    const [audit] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'credit_note_issued'),
            sql`${auditLog.payload}->>'original_invoice_id' = ${invoiceId}`,
          ),
        ),
    );
    const payload = audit!.payload as Record<string, unknown>;
    expect(payload.online_payment_refund_acknowledged).toBe(true);
    expect(payload.online_refundable_satang_at_issue).toBe(INVOICE_TOTAL.toString());
  }, 60_000);

  it('does not require the acknowledgement for a bank-transfer-paid invoice (no online payment to refund)', async () => {
    const { invoiceId } = await seedPaidInvoice(tenant, user, planId, 'bank_transfer');

    const r = await issueCreditNote(makeDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      creditTotalSatang: INVOICE_TOTAL,
      reason: 'document correction',
      membershipEffect: 'keep',
    });

    expect(r.ok).toBe(true);
    expect(await readInvoiceAndCnCount(invoiceId)).toEqual({
      status: 'credited',
      credited: INVOICE_TOTAL,
      cnCount: 1,
    });
  }, 60_000);
});

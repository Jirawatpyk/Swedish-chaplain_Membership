/**
 * A.18 (#3) — async (PromptPay) refund lifecycle, live Neon.
 *
 * PromptPay refunds settle ASYNCHRONOUSLY: Stripe's `refunds.create` returns
 * `status: 'pending'`, and the terminal outcome arrives later as a
 * `charge.refund.updated` webhook. This suite drives the full A.9 → A.11
 * lifecycle against real Postgres:
 *
 *   SUCCEEDED variant:
 *     1. `issueRefund` (A.9) with Stripe → `pending`  → result `kind:'pending'`;
 *        the refund row stays `pending` with its `processor_refund_id`
 *        attached, NO credit note is booked, the payment stays `succeeded`,
 *        the invoice stays `paid`.
 *     2. `charge.refund.updated(succeeded)` → `processRefundUpdated` (A.11)
 *        finalises: F4 credit note issued (exactly ONE, §87 +1), refund flips
 *        `succeeded`, payment flips `partially_refunded`, invoice
 *        `partially_credited`.
 *
 *   FAILED variant:
 *     1. `issueRefund` → `pending` (row pending, no CN).
 *     2. `charge.refund.updated(failed)` → `processRefundUpdated` →
 *        `reconciled_failed`: refund flips `failed`, NO credit note, payment
 *        stays `succeeded` (a failed refund never reduces the receipt).
 *
 * Mocking policy: live Postgres for every DB write (payments/refunds repos,
 * F4 credit-note repo, §87 sequence allocator, audit). ONLY the Stripe
 * gateway boundary (returns `pending`) and F4's external adapters (PDF
 * render, Blob upload, email outbox) are stubbed — the SYSTEM UNDER TEST is
 * the F5 lifecycle + DB persistence, not the Stripe SDK / PDF round-trip.
 * Every money assertion reads DB state directly.
 *
 * Run in isolation:
 *   pnpm test:integration tests/integration/payments/async-promptpay-refund-lifecycle.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { asSatang } from '@/lib/money';
import { ok } from '@/lib/result';
import { db, runInTenant } from '@/lib/db';

// --- Module-level mocks of F4 external adapters (real CN path, mocked I/O) ---
vi.mock('@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter', async () => {
  const { Sha256Hex: S } = await import(
    '@/modules/invoicing/domain/value-objects/sha256-hex'
  );
  return {
    reactPdfRenderAdapter: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
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
    uploadLogo: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
    signDownloadUrl: vi.fn(async () => 'https://blob.test/signed'),
    downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => [] as string[]),
  },
}));
vi.mock('@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter', () => ({
  resendEmailOutboxAdapter: { enqueue: vi.fn(async () => {}) },
}));

// Imports that transitively touch the mocked modules MUST come after vi.mock.
import { issueRefund, type IssueRefundDeps } from '@/modules/payments';
import { processRefundUpdated } from '@/modules/payments/application/use-cases/process-refund-updated';
import { invoicingBridge } from '@/modules/payments/infrastructure/invoicing-bridge';
import { systemClock } from '@/modules/payments/application/ports/clock-port';
import { f5AuditAdapter } from '@/modules/payments/infrastructure/audit/drizzle-payments-audit';
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import { makeDrizzleRefundsRepo } from '@/modules/payments/infrastructure/repos/drizzle-refunds-repo';
import { makeDrizzleProcessorEventsRepo } from '@/modules/payments/infrastructure/repos/drizzle-processor-events-repo';
import { payments } from '@/modules/payments/infrastructure/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { asPaymentId, type PaymentId } from '@/modules/payments/domain/payment';
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

const INVOICE_TOTAL = 107_000n;
const INVOICE_SUBTOTAL = 100_000n;
const INVOICE_VAT = 7_000n;
const REFUND_AMOUNT = 53_500n; // partial
const FISCAL_YEAR = 2026;
const PLAN_ID = 'async-pp-plan';

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Async PP Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

describe('async PromptPay refund lifecycle — live Neon (A.18 #3)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: PLAN_ID,
        planYear: FISCAL_YEAR,
        planName: { en: 'Async PromptPay Plan' },
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
        registrationFeeSatang: asSatang(0n),
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'APP',
        creditNoteNumberPrefix: 'CN',
      });
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  /** Seed a PAID membership invoice + succeeded PromptPay payment (no refund). */
  async function seedPaidInvoice(label: string): Promise<{
    invoiceId: string;
    paymentId: PaymentId;
  }> {
    const invoiceId = randomUUID();
    const memberId = randomUUID();
    const paymentId = asPaymentId(`pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`);
    // Doc number MUST match the `PREFIX-YYYY-NNNNNN` grammar (6-digit numeric
    // sequence) or the invoice-repo row mapper throws "corrupt document_number".
    const seq = Math.floor(Math.random() * 900_000) + 1;

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Async PP Co',
        country: 'TH',
        planId: PLAN_ID,
        planYear: FISCAL_YEAR,
      });
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: FISCAL_YEAR,
        planId: PLAN_ID,
        draftByUserId: user.userId,
        status: 'paid',
        pdfDocKind: 'invoice',
        receiptPdfStatus: 'rendered',
        fiscalYear: FISCAL_YEAR,
        sequenceNumber: seq,
        documentNumber: `APP-2026-${String(seq).padStart(6, '0')}`,
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
        paymentMethod: 'promptpay',
        paymentReference: 'seed-ref',
        paymentRecordedByUserId: user.userId,
        paymentDate: '2026-04-20',
        paidAt: new Date('2026-04-20T03:00:00Z'),
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
      await tx.insert(payments).values({
        id: paymentId,
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        method: 'promptpay',
        status: 'succeeded',
        amountSatang: INVOICE_TOTAL,
        currency: 'THB',
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        processorChargeId: `ch_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        attemptSeq: 1,
        cardBrand: null,
        cardLast4: null,
        cardExpMonth: null,
        cardExpYear: null,
        initiatedAt: new Date('2026-04-20T03:00:00Z'),
        completedAt: new Date('2026-04-20T03:00:10Z'),
        actorUserId: user.userId,
        correlationId: `corr-async-${label}`,
      });
    });
    return { invoiceId, paymentId };
  }

  /** issueRefund deps whose Stripe gateway returns an ASYNC `pending` refund. */
  function pendingRefundDeps(processorRefundId: string): IssueRefundDeps {
    return {
      paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
      refundsRepo: makeDrizzleRefundsRepo(tenant.ctx.slug),
      tenantSettingsRepo: {
        async getByTenantId() {
          return {
            tenantId: tenant.ctx.slug,
            processor: 'stripe' as const,
            processorEnvironment: 'test' as const,
            processorAccountId: `acct_test_${tenant.ctx.slug.slice(-8)}`,
            processorPublishableKey: `pk_test_${tenant.ctx.slug.slice(-8)}`,
            enabledMethods: ['card', 'promptpay'] as const,
            onlinePaymentEnabled: true,
            autoEmailOnPayment: true,
            promptpayQrExpirySeconds: 900,
            allowAnonymousPaylink: false,
          };
        },
        async findByProcessorAccountId() {
          return null;
        },
      },
      processorGateway: {
        createPaymentIntent: vi.fn(),
        retrievePaymentIntent: vi.fn(),
        cancelPaymentIntent: vi.fn(),
        // PromptPay: Stripe accepts the refund but it settles asynchronously.
        createRefund: vi.fn(async () =>
          ok({ id: processorRefundId, status: 'pending', amountSatang: asSatang(0n) }),
        ),
        retrieveRefund: vi.fn(),
      },
      // REAL bridge — NOT exercised on the pending path (issueRefund books no
      // CN until the webhook settles), but wired to prove that.
      invoicingBridge,
      audit: f5AuditAdapter,
      clock: systemClock,
      generateRefundId: () => `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
      idempotencyKeyFactory: (k) => k,
    };
  }

  function webhookDeps() {
    return {
      paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
      refundsRepo: makeDrizzleRefundsRepo(tenant.ctx.slug),
      processorEventsRepo: makeDrizzleProcessorEventsRepo(),
      invoicingBridge,
      audit: f5AuditAdapter,
      clock: systemClock,
    };
  }

  async function readCreditNoteSeq(): Promise<number> {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ next: tenantDocumentSequences.nextSequenceNumber })
        .from(tenantDocumentSequences)
        .where(
          and(
            eq(tenantDocumentSequences.tenantId, tenant.ctx.slug),
            eq(tenantDocumentSequences.documentType, 'credit_note'),
            eq(tenantDocumentSequences.fiscalYear, FISCAL_YEAR),
          ),
        ),
    );
    return rows[0]?.next ?? 1;
  }

  async function cnCountForRefund(refundId: string): Promise<number> {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ id: creditNotes.creditNoteId })
        .from(creditNotes)
        .where(
          and(
            eq(creditNotes.tenantId, tenant.ctx.slug),
            eq(creditNotes.sourceRefundId, refundId),
          ),
        ),
    );
    return rows.length;
  }

  async function refundRow(refundId: string): Promise<{ status: string; creditNoteId: string | null }> {
    const rows = (await db.execute(sql`
      SELECT status, credit_note_id FROM refunds
      WHERE tenant_id = ${tenant.ctx.slug} AND id = ${refundId}
    `)) as unknown as Array<{ status: string; credit_note_id: string | null }>;
    const row = rows[0];
    return { status: row?.status ?? 'MISSING', creditNoteId: row?.credit_note_id ?? null };
  }

  async function paymentStatus(paymentId: PaymentId): Promise<string> {
    const [row] = await db
      .select({ status: payments.status })
      .from(payments)
      .where(and(eq(payments.tenantId, tenant.ctx.slug), eq(payments.id, paymentId)));
    return row?.status ?? 'MISSING';
  }

  async function invoiceState(invoiceId: string): Promise<{ status: string; credited: bigint }> {
    const [row] = await db
      .select({ status: invoices.status, credited: invoices.creditedTotalSatang })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    return {
      status: row?.status ?? 'MISSING',
      credited: BigInt((row?.credited ?? 0n) as unknown as string),
    };
  }

  it('SUCCEEDED: createRefund→pending (no CN) → charge.refund.updated(succeeded) → CN issued + flips', async () => {
    const { invoiceId, paymentId } = await seedPaidInvoice('SUC001');
    const reId = `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const seqBefore = await readCreditNoteSeq();

    // Step 1 — admin issues the refund; Stripe returns `pending`.
    const refundResult = await issueRefund(pendingRefundDeps(reId), {
      tenantId: tenant.ctx.slug,
      paymentId,
      amountSatang: asSatang(REFUND_AMOUNT),
      reason: 'PromptPay partial refund',
      actorUserId: user.userId,
      correlationId: 'corr-async-suc',
      requestId: 'req-async-suc',
    });
    expect(refundResult.ok).toBe(true);
    if (!refundResult.ok) return;
    expect(refundResult.value.kind).toBe('pending');
    if (refundResult.value.kind !== 'pending') return;
    const refundId = refundResult.value.refund.id;
    expect(refundResult.value.refund.processorRefundId).toBe(reId);

    // Pending state asserted against the DB directly: row pending, NO CN, no flips.
    expect((await refundRow(refundId)).status).toBe('pending');
    expect(await cnCountForRefund(refundId)).toBe(0);
    expect(await paymentStatus(paymentId)).toBe('succeeded');
    expect((await invoiceState(invoiceId)).status).toBe('paid');
    expect(await readCreditNoteSeq()).toBe(seqBefore); // no §87 number burned yet

    // Step 2 — the async `charge.refund.updated(succeeded)` webhook settles it.
    const settle = await processRefundUpdated(webhookDeps(), {
      tenantId: tenant.ctx.slug,
      requestId: 'req-async-suc-webhook',
      eventId: `evt_${randomUUID().slice(0, 12)}`,
      processorRefundId: reId,
      chargeId: 'ch_x',
      refundStatus: 'succeeded',
      amountSatang: asSatang(REFUND_AMOUNT),
      processorEnv: 'test',
    });
    expect(settle.ok).toBe(true);
    if (!settle.ok) return;
    expect(settle.value.kind).toBe('reconciled_succeeded');

    // Now: exactly ONE CN, §87 advanced by exactly 1, refund succeeded, flips landed.
    const settled = await refundRow(refundId);
    expect(settled.status).toBe('succeeded');
    expect(settled.creditNoteId).not.toBeNull();
    expect(await cnCountForRefund(refundId)).toBe(1);
    expect((await readCreditNoteSeq()) - seqBefore).toBe(1);
    expect(await paymentStatus(paymentId)).toBe('partially_refunded');
    const inv = await invoiceState(invoiceId);
    expect(inv.status).toBe('partially_credited');
    expect(inv.credited).toBe(REFUND_AMOUNT);
  }, 90_000);

  it('CROSS-EVENT: charge.refund.updated(succeeded) + refund.updated(succeeded) for the SAME refund → exactly ONE credit note, §87 +1', async () => {
    // Stripe DEPRECATED charge.refund.updated ("only sent for refunds with a
    // corresponding charge; listen to refund.updated for updates on all
    // refunds instead") and MAY deliver BOTH channels for the same settlement
    // (distinct event ids). Both route to processRefundUpdated. Prove that two
    // succeeded deliveries for one refund book exactly ONE credit note (the
    // 2nd finds the row already terminal → already_finalized no-op) — the
    // real F4 CN + §87 sequence run on live Neon here (not stubbed).
    const { invoiceId, paymentId } = await seedPaidInvoice('XEV001');
    const reId = `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const seqBefore = await readCreditNoteSeq();

    const refundResult = await issueRefund(pendingRefundDeps(reId), {
      tenantId: tenant.ctx.slug,
      paymentId,
      amountSatang: asSatang(REFUND_AMOUNT),
      reason: 'PromptPay refund settled via both webhook channels',
      actorUserId: user.userId,
      correlationId: 'corr-async-xev',
      requestId: 'req-async-xev',
    });
    expect(refundResult.ok).toBe(true);
    if (!refundResult.ok) return;
    expect(refundResult.value.kind).toBe('pending');
    if (refundResult.value.kind !== 'pending') return;
    const refundId = refundResult.value.refund.id;
    expect((await refundRow(refundId)).status).toBe('pending');

    // Delivery 1 — the (deprecated) charge.refund.updated(succeeded) finalises.
    const settle1 = await processRefundUpdated(webhookDeps(), {
      tenantId: tenant.ctx.slug,
      requestId: 'req-async-xev-1',
      eventId: `evt_${randomUUID().slice(0, 12)}`,
      sourceEventType: 'charge.refund.updated',
      processorRefundId: reId,
      chargeId: 'ch_x',
      refundStatus: 'succeeded',
      amountSatang: asSatang(REFUND_AMOUNT),
      processorEnv: 'test',
    });
    expect(settle1.ok).toBe(true);
    if (!settle1.ok) return;
    expect(settle1.value.kind).toBe('reconciled_succeeded');

    // Delivery 2 — the forward-path refund.updated(succeeded) for the SAME
    // refund (distinct event id) → terminal-row no-op, NO second credit note.
    const settle2 = await processRefundUpdated(webhookDeps(), {
      tenantId: tenant.ctx.slug,
      requestId: 'req-async-xev-2',
      eventId: `evt_${randomUUID().slice(0, 12)}`,
      sourceEventType: 'refund.updated',
      processorRefundId: reId,
      chargeId: 'ch_x',
      refundStatus: 'succeeded',
      amountSatang: asSatang(REFUND_AMOUNT),
      processorEnv: 'test',
    });
    expect(settle2.ok).toBe(true);
    if (!settle2.ok) return;
    expect(settle2.value.kind).toBe('already_finalized');

    // Exactly ONE credit note across BOTH deliveries; §87 advanced by exactly 1.
    expect(await cnCountForRefund(refundId)).toBe(1);
    expect((await readCreditNoteSeq()) - seqBefore).toBe(1);
    const settled = await refundRow(refundId);
    expect(settled.status).toBe('succeeded');
    expect(settled.creditNoteId).not.toBeNull();
    expect(await paymentStatus(paymentId)).toBe('partially_refunded');
    expect((await invoiceState(invoiceId)).status).toBe('partially_credited');
  }, 90_000);

  it('FAILED: createRefund→pending (no CN) → charge.refund.updated(failed) → reconciled_failed, NO CN', async () => {
    const { invoiceId, paymentId } = await seedPaidInvoice('FAI001');
    const reId = `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const seqBefore = await readCreditNoteSeq();

    const refundResult = await issueRefund(pendingRefundDeps(reId), {
      tenantId: tenant.ctx.slug,
      paymentId,
      amountSatang: asSatang(REFUND_AMOUNT),
      reason: 'PromptPay refund that will fail',
      actorUserId: user.userId,
      correlationId: 'corr-async-fail',
      requestId: 'req-async-fail',
    });
    // Assert the pending mapping EXPLICITLY before narrowing (mirror the
    // SUCCEEDED variant): a mis-mapped non-pending kind must fail loudly here,
    // not silently `return` past every downstream assertion.
    expect(refundResult.ok).toBe(true);
    if (!refundResult.ok) return;
    expect(refundResult.value.kind).toBe('pending');
    if (refundResult.value.kind !== 'pending') return;
    const refundId = refundResult.value.refund.id;
    expect((await refundRow(refundId)).status).toBe('pending');

    // The async settlement reports FAILED.
    const settle = await processRefundUpdated(webhookDeps(), {
      tenantId: tenant.ctx.slug,
      requestId: 'req-async-fail-webhook',
      eventId: `evt_${randomUUID().slice(0, 12)}`,
      processorRefundId: reId,
      chargeId: 'ch_x',
      refundStatus: 'failed',
      amountSatang: asSatang(REFUND_AMOUNT),
      processorEnv: 'test',
    });
    expect(settle.ok).toBe(true);
    if (!settle.ok) return;
    expect(settle.value.kind).toBe('reconciled_failed');

    // Refund flipped failed, NO CN, no §87 number burned, payment/invoice untouched.
    expect((await refundRow(refundId)).status).toBe('failed');
    expect(await cnCountForRefund(refundId)).toBe(0);
    expect(await readCreditNoteSeq()).toBe(seqBefore);
    expect(await paymentStatus(paymentId)).toBe('succeeded');
    expect((await invoiceState(invoiceId)).status).toBe('paid');
  }, 90_000);
});

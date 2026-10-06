/**
 * A manual record-payment cancels the invoice's still-live PaymentIntent —
 * live Neon (#452 financial-integrity review, M1).
 *
 * Proves the post-commit half the admin pay route runs —
 * `cancelPendingPaymentsAfterManualPayment` → the invoicing
 * `PendingPaymentCancellerPort` → F5 `cancelPendingPaymentsForInvoice` —
 * against the REAL schema + RLS + audit:
 *   - a fresh manual payment cancels the paid invoice's pending row with
 *     audit cause `invoice_paid_manually`, the paying admin as actor;
 *   - a pending row on ANOTHER invoice of the same member is untouched;
 *   - a replayed pay request (invoice already paid) is labelled
 *     `invoice_already_paid` and is a no-op once nothing is pending.
 *
 * Scope note: the invoice is flipped to `paid` with the same columns the real
 * `applyPayment` writes rather than by running `recordPayment` itself — a real
 * payment renders the receipt PDF (the multi-minute cost that keeps the void
 * suite out of smoke). That the route calls this AFTER the commit and after
 * the F2 finaliser, and that recordPayment reports `replayed`, is pinned by
 * `tests/contract/invoices/pay-route-pending-cancel.contract.test.ts` and
 * `tests/unit/invoicing/record-payment.test.ts`.
 *
 * Mocking policy mirrors `void-cancels-pending-payment.test.ts`: live Neon for
 * the repos + audit; the processor gateway is a counting fake (no Stripe) and
 * the tenant settings repo a fixture. Runs in the nightly payments rotation,
 * not smoke. Local: `pnpm vitest run --config vitest.integration.config.ts
 * tests/integration/payments/manual-pay-cancels-pending.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ok } from '@/lib/result';
import { db, runInTenant, type TenantTx } from '@/lib/db';
import {
  cancelPendingPaymentsForInvoice,
  makeCancelPendingPaymentsForInvoiceDeps,
  type CancelPendingPaymentsForInvoiceDeps,
} from '@/modules/payments';
import { cancelPendingPaymentsAfterManualPayment } from '@/modules/invoicing';
import type { TenantPaymentSettingsRepo } from '@/modules/payments/application/ports';
import type { TenantPaymentSettings } from '@/modules/payments/domain/tenant-payment-settings';
import {
  payments,
  tenantPaymentSettings,
  type NewTenantPaymentSettingsRow,
} from '@/modules/payments/infrastructure/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
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

function pmtId(): string {
  return `pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
}

describe('manual record-payment cancels the invoice\'s pending PaymentIntent — live Neon (#452 review M1)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  const paid = { invoiceId: randomUUID(), paymentId: pmtId(), pi: `pi_test_mp_paid_${randomUUID().slice(0, 8)}` };
  const other = { invoiceId: randomUUID(), paymentId: pmtId(), pi: `pi_test_mp_other_${randomUUID().slice(0, 8)}` };

  async function insertInvoice(tx: TenantTx, id: string, seq: number): Promise<void> {
    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId: id,
      memberId,
      planYear: 2026,
      planId: 'mp-plan',
      status: 'issued',
      pdfDocKind: 'invoice',
      draftByUserId: user.userId,
      fiscalYear: 2026,
      sequenceNumber: seq,
      documentNumber: `T6-2026-${String(seq).padStart(6, '0')}`,
      issueDate: '2026-04-01',
      dueDate: '2026-05-01',
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
        legal_name: 'MP Co',
        tax_id: '1234567890123',
        address: 'Bangkok',
        primary_contact_name: 'MP Contact',
        primary_contact_email: 'mp@example.com',
      },
      pdfBlobKey: `invoices/mp-${id}.pdf`,
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
    });
  }

  async function insertPendingPayment(
    tx: TenantTx,
    row: { invoiceId: string; paymentId: string; pi: string },
  ): Promise<void> {
    await tx.insert(payments).values({
      id: row.paymentId,
      tenantId: tenant.ctx.slug,
      invoiceId: row.invoiceId,
      memberId,
      method: 'card',
      status: 'pending',
      amountSatang: 1_070_000n,
      currency: 'THB',
      processorPaymentIntentId: row.pi,
      processorChargeId: null,
      processorEnvironment: 'test',
      attemptSeq: 1,
      initiatedAt: new Date(),
      completedAt: null,
      actorUserId: user.userId,
      correlationId: `corr-${row.paymentId}`,
    });
  }

  beforeAll(async () => {
    user = await createActiveTestUser('member');
    const pair = await createTwoTestTenants();
    tenant = pair.a;
    memberId = randomUUID();

    const settings: NewTenantPaymentSettingsRow = {
      tenantId: tenant.ctx.slug,
      processor: 'stripe',
      processorEnvironment: 'test',
      processorAccountId: `acct_test_${tenant.ctx.slug.slice(-8)}`,
      processorPublishableKey: `pk_test_${tenant.ctx.slug.slice(-8)}`,
      enabledMethods: ['card', 'promptpay'],
      onlinePaymentEnabled: true,
      autoEmailOnPayment: true,
      promptpayQrExpirySeconds: 900,
      allowAnonymousPaylink: false,
    };

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantPaymentSettings).values(settings);
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'mp-plan',
        planYear: 2026,
        planName: { en: 'MP Plan' },
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
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'MP Co',
        country: 'TH',
        planId: 'mp-plan',
        planYear: 2026,
      });
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 500000n,
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'T6',
        creditNoteNumberPrefix: 'T6C',
      });
      await tx.insert(tenantDocumentSequences).values({
        tenantId: tenant.ctx.slug,
        documentType: 'invoice',
        fiscalYear: 2026,
      });
    });

    await runInTenant(tenant.ctx, async (tx) => {
      await insertInvoice(tx, paid.invoiceId, 1);
      await insertInvoice(tx, other.invoiceId, 2);
      await insertPendingPayment(tx, paid);
      await insertPendingPayment(tx, other);
    });

    // The state a committed manual payment leaves — same columns as the real
    // applyPayment (the paid CHECKs need paid_at + payment_method + receipt_pdf_status).
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(invoices)
        .set({
          status: 'paid',
          paidAt: sql`now()`,
          paymentMethod: 'bank_transfer',
          paymentDate: '2026-04-15',
          receiptPdfStatus: 'pending',
          updatedAt: sql`now()`,
        })
        .where(eq(invoices.invoiceId, paid.invoiceId)),
    );
  }, 120_000);

  afterAll(async () => {
    if (tenant) {
      await tenant.cleanup().catch((e) => console.error('M1 tenant cleanup:', e));
    }
  });

  function makeDeps(): { deps: CancelPendingPaymentsForInvoiceDeps; cancelCalls: string[][] } {
    const cancelCalls: string[][] = [];
    const settingsFixture: TenantPaymentSettings = {
      tenantId: tenant.ctx.slug,
      processor: 'stripe',
      processorEnvironment: 'test',
      processorAccountId: `acct_test_${tenant.ctx.slug.slice(-8)}`,
      processorPublishableKey: `pk_test_${tenant.ctx.slug.slice(-8)}`,
      enabledMethods: ['card', 'promptpay'],
      onlinePaymentEnabled: true,
      autoEmailOnPayment: true,
      promptpayQrExpirySeconds: 900,
      allowAnonymousPaylink: false,
    };
    const settingsRepo: TenantPaymentSettingsRepo = {
      async getByTenantId() {
        return settingsFixture;
      },
      async findByProcessorAccountId() {
        return settingsFixture;
      },
    };
    const real = makeCancelPendingPaymentsForInvoiceDeps(tenant.ctx.slug);
    return {
      cancelCalls,
      deps: {
        ...real,
        tenantSettingsRepo: settingsRepo,
        processorGateway: {
          ...real.processorGateway,
          async cancelPaymentIntent(pi: string, acct: string) {
            cancelCalls.push([pi, acct]);
            return ok(undefined);
          },
        },
      },
    };
  }

  async function statusOf(paymentId: string): Promise<{ status: string; completedAt: Date | null }> {
    const [row] = await db
      .select({ status: payments.status, completedAt: payments.completedAt })
      .from(payments)
      .where(eq(payments.id, paymentId));
    return row!;
  }

  function canceller(deps: CancelPendingPaymentsForInvoiceDeps) {
    // The production adapter (invoicing-deps `makePendingPaymentCanceller`)
    // with the fake gateway + settings fixture swapped in.
    return {
      cancelPendingPayments: async (a: {
        tenantId: string;
        invoiceId: string;
        actorUserId: string;
        requestId: string | null;
        cause: 'invoice_voided' | 'invoice_paid_manually' | 'invoice_already_paid';
      }) => {
        await cancelPendingPaymentsForInvoice(deps, a);
      },
    };
  }

  async function auditFor(paymentId: string) {
    return db
      .select({ payload: auditLog.payload, actorUserId: auditLog.actorUserId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          sql`${auditLog.eventType} = 'payment_canceled'`,
          sql`${auditLog.payload}->>'payment_id' = ${paymentId}`,
        ),
      );
  }

  it('fresh manual payment → cancels only the paid invoice\'s pending row, audited invoice_paid_manually; replay is a labelled no-op', async () => {
    const { deps, cancelCalls } = makeDeps();
    const args = {
      tenantId: tenant.ctx.slug,
      invoiceId: paid.invoiceId,
      actorUserId: user.userId,
      requestId: 'req-m1',
    };

    await cancelPendingPaymentsAfterManualPayment(
      { pendingPaymentCanceller: canceller(deps) },
      { ...args, replayed: false },
    );
    expect(cancelCalls).toEqual([[paid.pi, `acct_test_${tenant.ctx.slug.slice(-8)}`]]);

    const p = await statusOf(paid.paymentId);
    expect(p.status).toBe('canceled');
    expect(p.completedAt).not.toBeNull();
    expect((await statusOf(other.paymentId)).status).toBe('pending');

    const rows = await auditFor(paid.paymentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe(user.userId);
    expect(rows[0]!.payload).toMatchObject({
      invoice_id: paid.invoiceId,
      actor_type: 'system',
      cause: 'invoice_paid_manually',
    });

    // Admin re-submits pay (replay): labelled invoice_already_paid; nothing
    // pending any more → no Stripe call, no new audit row.
    await cancelPendingPaymentsAfterManualPayment(
      { pendingPaymentCanceller: canceller(deps) },
      { ...args, replayed: true },
    );
    expect(cancelCalls).toHaveLength(1);
    expect(await auditFor(paid.paymentId)).toHaveLength(1);
  }, 60_000);

  it('replay on an invoice another rail already paid (pending row still live) → canceled with cause invoice_already_paid', async () => {
    const { deps, cancelCalls } = makeDeps();
    // Re-use the OTHER invoice: flip it to paid as the webhook would have.
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(invoices)
        .set({
          status: 'paid',
          paidAt: sql`now()`,
          paymentMethod: 'other',
          paymentDate: '2026-04-15',
          receiptPdfStatus: 'pending',
          updatedAt: sql`now()`,
        })
        .where(eq(invoices.invoiceId, other.invoiceId)),
    );
    await cancelPendingPaymentsAfterManualPayment(
      { pendingPaymentCanceller: canceller(deps) },
      {
        tenantId: tenant.ctx.slug,
        invoiceId: other.invoiceId,
        actorUserId: user.userId,
        requestId: null,
        replayed: true,
      },
    );
    expect(cancelCalls).toEqual([[other.pi, `acct_test_${tenant.ctx.slug.slice(-8)}`]]);
    expect((await statusOf(other.paymentId)).status).toBe('canceled');
    const rows = await auditFor(other.paymentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ cause: 'invoice_already_paid' });
  }, 60_000);
});

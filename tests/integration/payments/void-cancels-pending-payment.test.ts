/**
 * Voiding an invoice cancels its still-live PaymentIntent — live Neon
 * (follow-up to the #446 financial-integrity review, M-a).
 *
 * Proves the payments half against the REAL schema + RLS: `listPendingByInvoice`
 * finds the pending row, the per-row lock + CAS `updateStatus` flips it to
 * `canceled`, and the `payment_canceled` audit row (actor_type 'system',
 * cause 'invoice_voided') lands — while a pending payment on a DIFFERENT
 * invoice of the same member is left alone, and a re-run is a no-op.
 *
 * Scope note: the invoice is voided with the same column write the real
 * `voidInvoice` repo performs (drizzle-invoice-repo `applyVoid`) rather than
 * by running `voidInvoice` itself — a real void re-renders the PDF, which is
 * what makes `void-invoice` a ~3 min CI suite (see the integration-smoke
 * header). That `voidInvoice` calls the canceller exactly once, post-commit,
 * and never on a refused / rolled-back void is pinned by the unit suite
 * `tests/unit/invoicing/void-invoice.test.ts`.
 *
 * Mocking policy mirrors `concurrent-initiate.test.ts`: live Neon for the
 * repos + audit; the processor gateway is a counting fake (no Stripe), and
 * the tenant settings repo is a fixture (`unstable_cache` needs request
 * context).
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

describe('void cancels the invoice\'s pending PaymentIntent — live Neon (#446 review M-a)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  const voided = { invoiceId: randomUUID(), paymentId: pmtId(), pi: `pi_test_vc_void_${randomUUID().slice(0, 8)}` };
  const other = { invoiceId: randomUUID(), paymentId: pmtId(), pi: `pi_test_vc_other_${randomUUID().slice(0, 8)}` };

  async function insertInvoice(tx: TenantTx, id: string, seq: number): Promise<void> {
    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId: id,
      memberId,
      planYear: 2026,
      planId: 'vc-plan',
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
        legal_name: 'VC Co',
        tax_id: '1234567890123',
        address: 'Bangkok',
        primary_contact_name: 'VC Contact',
        primary_contact_email: 'vc@example.com',
      },
      pdfBlobKey: `invoices/vc-${id}.pdf`,
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
        planId: 'vc-plan',
        planYear: 2026,
        planName: { en: 'VC Plan' },
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
        companyName: 'VC Co',
        country: 'TH',
        planId: 'vc-plan',
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
      await insertInvoice(tx, voided.invoiceId, 1);
      await insertInvoice(tx, other.invoiceId, 2);
      await insertPendingPayment(tx, voided);
      await insertPendingPayment(tx, other);
    });

    // The state a committed void leaves — same columns as the real applyVoid.
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(invoices)
        .set({
          status: 'void',
          voidReason: 'M-a integration test',
          voidedByUserId: user.userId,
          voidedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(invoices.invoiceId, voided.invoiceId)),
    );
  }, 120_000);

  afterAll(async () => {
    if (tenant) {
      await tenant.cleanup().catch((e) => console.error('M-a tenant cleanup:', e));
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

  it('cancels only the voided invoice\'s pending payment, audits it, and a re-run is a no-op', async () => {
    const { deps, cancelCalls } = makeDeps();
    const input = {
      tenantId: tenant.ctx.slug,
      invoiceId: voided.invoiceId,
      actorUserId: user.userId,
      cause: 'invoice_voided' as const,
      requestId: 'req-m-a',
    };

    const first = await cancelPendingPaymentsForInvoice(deps, input);
    expect(first).toEqual({ canceled: 1, skipped: 0, failed: 0 });
    expect(cancelCalls).toEqual([[voided.pi, `acct_test_${tenant.ctx.slug.slice(-8)}`]]);

    const v = await statusOf(voided.paymentId);
    expect(v.status).toBe('canceled');
    expect(v.completedAt).not.toBeNull();
    // A pending attempt on ANOTHER invoice must be untouched.
    expect((await statusOf(other.paymentId)).status).toBe('pending');

    const auditRows = await db
      .select({ payload: auditLog.payload, actorUserId: auditLog.actorUserId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          sql`${auditLog.eventType} = 'payment_canceled'`,
          sql`${auditLog.payload}->>'payment_id' = ${voided.paymentId}`,
        ),
      );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.payload).toMatchObject({
      invoice_id: voided.invoiceId,
      actor_type: 'system',
      cause: 'invoice_voided',
    });

    // Idempotent: nothing pending any more → no Stripe call, no new audit.
    const second = await cancelPendingPaymentsForInvoice(deps, input);
    expect(second).toEqual({ canceled: 0, skipped: 0, failed: 0 });
    expect(cancelCalls).toHaveLength(1);
  }, 60_000);
});

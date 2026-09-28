/**
 * Financial-integrity review of #443 (M1) — `initiatePayment` must refuse an
 * invoice that is no longer `issued`, BEFORE any payments row or Stripe call.
 *
 * Scenario: a member leaves the invoice page open; staff void the invoice
 * (void-on-reissue); the member presses Pay now on the stale page. The F4
 * bridge `getInvoiceForPayment` returns `ok` for any positive-total row
 * (webhook reconciliation needs that to auto-refund), so the use-case gated
 * only on `paid` used to mint a live PaymentIntent here. Stripe then captured
 * and confirm-payment's stale-invoice guard auto-refunded days later.
 *
 * Why an integration test: the unit test pins the branch against a mocked
 * bridge; this one proves the REAL bridge + real row status reach the guard
 * (a voided row keeps its positive `total_satang`, so nothing upstream stops
 * it) and that no `payments` row is written.
 *
 * Mocking policy mirrors `concurrent-initiate.test.ts`: live Neon for
 * everything except the processor gateway (counted, must stay at zero) and
 * the tenant settings repo (`unstable_cache` needs request context).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { makeInitiatePaymentDeps } from '@/modules/payments/infrastructure/di';
import { initiatePayment } from '@/modules/payments/application/use-cases/initiate-payment';
import type {
  ProcessorGatewayPort,
  TenantPaymentSettingsRepo,
} from '@/modules/payments/application/ports';
import type { TenantPaymentSettings } from '@/modules/payments/domain/tenant-payment-settings';
import type { InitiatePaymentDeps } from '@/modules/payments/application/use-cases/initiate-payment';
import {
  payments,
  tenantPaymentSettings,
  type NewTenantPaymentSettingsRow,
} from '@/modules/payments/infrastructure/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
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

/** Any call is a failure: a non-issued invoice must never reach Stripe. */
function makeCountingGateway(): { gateway: ProcessorGatewayPort; calls: () => number } {
  let calls = 0;
  const refuse = async (): Promise<never> => {
    calls += 1;
    throw new Error('processor gateway must not be called for a non-issued invoice');
  };
  return {
    gateway: {
      createPaymentIntent: refuse,
      retrievePaymentIntent: refuse,
      cancelPaymentIntent: refuse,
      createRefund: refuse,
      retrieveRefund: refuse,
    },
    calls: () => calls,
  };
}

describe('initiatePayment refuses a voided invoice (#443 review M1)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  let invoiceId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('member');
    const pair = await createTwoTestTenants();
    tenant = pair.a;
    memberId = randomUUID();
    invoiceId = randomUUID();

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
        planId: 'm1-plan',
        planYear: 2026,
        planName: { en: 'M1 Plan' },
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
        companyName: 'M1 Co',
        country: 'TH',
        planId: 'm1-plan',
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
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: 'm1-plan',
        status: 'issued',
        pdfDocKind: 'invoice',
        draftByUserId: user.userId,
        fiscalYear: 2026,
        sequenceNumber: 1,
        documentNumber: 'T6-2026-000001',
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
          legal_name: 'M1 Co',
          tax_id: '1234567890123',
          address: 'Bangkok',
          primary_contact_name: 'M1 Contact',
          primary_contact_email: 'm1@example.com',
        },
        pdfBlobKey: 'invoices/m1-void.pdf',
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      });
    });

    // The state void-on-reissue leaves behind — same columns the real
    // `voidInvoice` repo write sets (drizzle-invoice-repo.ts). `total_satang`
    // stays positive, so the bridge's null/<=0 guard does not stop it.
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(invoices)
        .set({
          status: 'void',
          voidReason: 'M1 integration test — superseded by reissue',
          voidedByUserId: user.userId,
          voidedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(invoices.invoiceId, invoiceId)),
    );
  }, 120_000);

  afterAll(async () => {
    if (tenant) {
      await tenant.cleanup().catch((e) => console.error('M1 tenant cleanup:', e));
    }
  });

  it.each(['card', 'promptpay'] as const)(
    'method=%s → invoice_not_payable (currentStatus=void), no payments row, no Stripe call',
    async (method) => {
      const { gateway, calls } = makeCountingGateway();
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
      const settingsRepoFixture: TenantPaymentSettingsRepo = {
        async getByTenantId() {
          return settingsFixture;
        },
        async findByProcessorAccountId() {
          return settingsFixture;
        },
      };
      const deps: InitiatePaymentDeps = {
        ...makeInitiatePaymentDeps(tenant.ctx.slug),
        processorGateway: gateway,
        tenantSettingsRepo: settingsRepoFixture,
      };

      const result = await initiatePayment(deps, {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        actorMemberId: memberId,
        invoiceId,
        method,
        requestId: `req-m1-void-${method}`,
        correlationId: `corr-m1-void-${method}`,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toEqual({ code: 'invoice_not_payable', currentStatus: 'void' });
      expect(calls()).toBe(0);

      const paymentRows = await db
        .select()
        .from(payments)
        .where(eq(payments.invoiceId, invoiceId));
      expect(paymentRows).toHaveLength(0);
    },
    60_000,
  );
});

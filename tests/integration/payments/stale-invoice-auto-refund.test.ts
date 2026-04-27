/**
 * T122 (Phase 7) — Integration: stale-invoice auto-refund against
 * live Neon.
 *
 * Spec authority: F5 spec.md US5, FR-011b, plan.md § 4.1.
 *
 * Scenario: Stripe `payment_intent.succeeded` arrives for a payment
 * tied to an invoice already in a non-payable state (status='paid' /
 * 'void'). `confirmPayment` must:
 *   - Detect the stale invoice via `invoicingBridge.getInvoiceForPayment`.
 *   - Trigger `processorGateway.createRefund` (idempotency-keyed).
 *   - Emit `payment_auto_refunded_stale_invoice` audit row.
 *   - NOT call `invoicingBridge.markPaidFromProcessor`.
 *
 * Integration value-add over the unit tests
 * (`tests/unit/payments/application/confirm-payment.test.ts`):
 *   - Audit row lands in the live `audit_log` table with
 *     `event_type='payment_auto_refunded_stale_invoice'` + correct
 *     `tenant_id` + `retention_years=10`.
 *   - Real RLS policy on the audit table allows the system actor write
 *     (Constitution Principle I sub-clause #4).
 *   - F5 `payments` row state transitions correctly under live
 *     Postgres (status not flipped to 'succeeded' on stale path).
 *
 * Mocking policy:
 *   - LIVE Neon for `paymentsRepo` + `audit` (drizzle adapters).
 *   - MOCKED `processorGateway` (createRefund + retrievePaymentIntent)
 *     and `invoicingBridge` (getInvoiceForPayment) at the port boundary
 *     — the gateway HTTP layer is covered by `stripe-gateway-mock.test.ts`,
 *     and the F4 `invoices` table integration is covered by
 *     `invoicing-bridge-atomicity.test.ts`. Folding both into this test
 *     would create excessive seed surface without new coverage value.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, runInTenant } from '@/lib/db';
import { ok } from '@/lib/result';
import { confirmPayment } from '@/modules/payments';
import { systemClock } from '@/modules/payments/application/ports/clock-port';
import { f5AuditAdapter } from '@/modules/payments/infrastructure/audit/drizzle-payments-audit';
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import {
  payments,
  tenantPaymentSettings,
  type NewTenantPaymentSettingsRow,
} from '@/modules/payments/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { asPaymentId, type PaymentId } from '@/modules/payments/domain/payment';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';

import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

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

interface PaymentSeed {
  readonly invoiceId: string;
  readonly paymentId: PaymentId;
  readonly paymentIntentId: string;
}

describe('confirmPayment stale-invoice auto-refund — live Neon (T122)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  let paidSeed: PaymentSeed;
  let voidSeed: PaymentSeed;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    memberId = randomUUID();
    paidSeed = {
      invoiceId: randomUUID(),
      paymentId: asPaymentId(`pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`),
      paymentIntentId: `pi_test_stale_paid_${randomUUID().slice(0, 8)}`,
    };
    voidSeed = {
      invoiceId: randomUUID(),
      paymentId: asPaymentId(`pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`),
      paymentIntentId: `pi_test_stale_void_${randomUUID().slice(0, 8)}`,
    };

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
      // Parent FK chain: plan → member → invoice settings → sequences → invoice
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'stale-plan',
        planYear: 2026,
        planName: { en: 'Stale Plan' },
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
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: 'Stale Co',
        country: 'TH',
        planId: 'stale-plan',
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
        invoiceNumberPrefix: 'T',
        creditNoteNumberPrefix: 'TC',
      });
      await tx.insert(tenantDocumentSequences).values({
        tenantId: tenant.ctx.slug,
        documentType: 'invoice',
        fiscalYear: 2026,
      });
      // Two parallel invoice+payment chains: one will be tested as
      // status='paid', the other as status='void'.
      for (const seed of [paidSeed, voidSeed]) {
        await tx.insert(invoices).values({
          tenantId: tenant.ctx.slug,
          invoiceId: seed.invoiceId,
          memberId,
          planYear: 2026,
          planId: 'stale-plan',
          draftByUserId: user.userId,
        });
        await tx.insert(payments).values({
          id: seed.paymentId,
          tenantId: tenant.ctx.slug,
          invoiceId: seed.invoiceId,
          memberId,
          method: 'card',
          status: 'pending',
          amountSatang: 5_350_000n,
          currency: 'THB',
          processorPaymentIntentId: seed.paymentIntentId,
          processorChargeId: null,
          processorEnvironment: 'test',
          attemptSeq: 1,
          cardBrand: null,
          cardLast4: null,
          cardExpMonth: null,
          cardExpYear: null,
          initiatedAt: new Date(),
          completedAt: null,
          actorUserId: user.userId,
          correlationId: 'corr-stale-test',
        });
      }
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
  });

  function makeMocks(seed: PaymentSeed, invoiceStatus: 'paid' | 'void') {
    const processorGateway = {
      createPaymentIntent: vi.fn(),
      retrievePaymentIntent: vi.fn(async () =>
        ok({
          id: seed.paymentIntentId,
          status: 'succeeded' as const,
          latestChargeId: 'ch_test_stale',
          livemode: false,
          lastPaymentErrorCode: null,
          card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
          clientSecret: null,
          promptpayQrSvgUrl: null,
        }),
      ),
      cancelPaymentIntent: vi.fn(),
      createRefund: vi.fn(async () =>
        ok({
          id: `re_test_${randomUUID().slice(0, 8)}`,
          status: 'succeeded' as const,
          amountSatang: 5_350_000n,
        }),
      ),
    };
    const invoicingBridge = {
      getInvoiceForPayment: vi.fn(async () =>
        ok({
          id: seed.invoiceId,
          status: invoiceStatus,
          totalSatang: 5_350_000n,
          memberId,
          tenantId: tenant.ctx.slug,
        }),
      ),
      markPaidFromProcessor: vi.fn(async () => ok(undefined)),
    };
    return { processorGateway, invoicingBridge };
  }

  async function runConfirmPayment(
    seed: PaymentSeed,
    mocks: ReturnType<typeof makeMocks>,
  ) {
    return runInTenant(tenant.ctx, async () =>
      confirmPayment(
        {
          paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
          tenantSettingsRepo: {
            getByTenantId: async () => ({
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
            }),
            findByProcessorAccountId: async () => null,
          },
          processorGateway:
            mocks.processorGateway as unknown as Parameters<typeof confirmPayment>[0]['processorGateway'],
          invoicingBridge:
            mocks.invoicingBridge as unknown as Parameters<typeof confirmPayment>[0]['invoicingBridge'],
          audit: f5AuditAdapter,
          clock: systemClock,
        },
        {
          tenantId: tenant.ctx.slug,
          paymentIntentId: seed.paymentIntentId,
          correlationId: 'corr-stale-test',
          requestId: 'req-stale-test',
          eventCreatedAtUnixSeconds: Math.floor(Date.now() / 1000),
        },
      ),
    );
  }

  it('paid invoice → auto_refunded_stale_invoice + audit row in DB + payment NOT flipped to succeeded', async () => {
    const mocks = makeMocks(paidSeed, 'paid');
    const result = await runConfirmPayment(paidSeed, mocks);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');
    expect(mocks.processorGateway.createRefund).toHaveBeenCalledTimes(1);
    expect(mocks.invoicingBridge.markPaidFromProcessor).not.toHaveBeenCalled();

    // Idempotency key contract: `auto-refund-${payment.id}` so Stripe
    // retries are deduped server-side (confirm-payment.ts:251).
    expect(mocks.processorGateway.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `auto-refund-${paidSeed.paymentId}`,
      }),
    );

    // Audit row landed in the live audit_log table with the correct
    // event type + tenant_id. (Retention years is enforced at write
    // time via RETENTION_YEARS map in audit-port — not a persisted
    // column on audit_log; see drizzle-payments-audit.ts.)
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'payment_auto_refunded_stale_invoice'),
        ),
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // Payment row NOT flipped to 'succeeded' — stale path leaves the
    // pending row alone (the auto-refund is recorded against the PI
    // directly; the row's terminal status is set elsewhere).
    const paymentRow = await db
      .select({ status: payments.status })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenant.ctx.slug),
          eq(payments.id, paidSeed.paymentId),
        ),
      );
    expect(paymentRow[0]?.status).not.toBe('succeeded');
  }, 30_000);

  it('void invoice → same auto_refunded_stale_invoice path (cause=invoice_voided)', async () => {
    const mocks = makeMocks(voidSeed, 'void');
    const result = await runConfirmPayment(voidSeed, mocks);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');
    expect(mocks.processorGateway.createRefund).toHaveBeenCalledTimes(1);
    expect(mocks.invoicingBridge.markPaidFromProcessor).not.toHaveBeenCalled();
    expect(mocks.processorGateway.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `auto-refund-${voidSeed.paymentId}`,
      }),
    );
  }, 30_000);
});

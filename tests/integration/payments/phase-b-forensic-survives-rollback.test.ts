/**
 * F-2 (money-remediation Task 3) — live Neon: the Phase-B forensic row
 * actually reaches `audit_log`, and the transaction it reports on actually
 * rolled back.
 *
 * ## Why a unit test cannot cover this
 *
 * `confirm-payment-phase-b-forensic.test.ts` stubs the audit port, so it
 * proves the use-case CALLS `emit(null, …)` and nothing more. Two things it
 * cannot see:
 *
 *   1. **Whether the row lands.** The adapter's `null`-tx branch writes
 *      through the pool-global `db` — a connection with no
 *      `SET LOCAL app.current_tenant` — and `audit_log` carries RLS + FORCE
 *      with a `WITH CHECK (tenant_id IS NULL OR tenant_id =
 *      current_setting('app.current_tenant', TRUE))` policy. If that check
 *      rejects a tenant-scoped forensic, the adapter **log-and-swallows the
 *      failure by design**, so the fix would look correct at every level
 *      above the database and write nothing. No existing test covers this:
 *      the other integration suites assert `out_of_band_refund_detected` is
 *      ABSENT, and `out-of-band-refund.test.ts` seeds its rows with an
 *      explicit `tenant_id`-free INSERT that the policy's `IS NULL` arm
 *      admits.
 *
 *   2. **That the in-tx row is really gone.** A spy records the in-tx emit
 *      before the transaction rejects. Only a real Postgres rollback can
 *      show the difference, and it is the whole point of the fix — if the
 *      in-tx money trail survived, the forensic would be a duplicate rather
 *      than the sole record.
 *
 * ## The fault injected
 *
 * The audit adapter is wrapped so an in-transaction emit performs the real
 * INSERT and *then* throws — modelling a Neon drop mid-write. That is
 * stronger than failing before the INSERT: the money-trail row genuinely
 * existed inside the transaction, so its absence afterwards is evidence of
 * the rollback rather than of a write that never happened.
 *
 * `null`-tx emits are passed through untouched to the REAL adapter, which is
 * the code under test.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { runInTenant } from '@/lib/db';
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
import { asPaymentId, type PaymentId } from '@/modules/payments/domain/payment';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
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

const AMOUNT_SATANG = 5_350_000n;
const FORENSIC_EVENT = 'payment_auto_refunded_concurrent_manual_mark';

interface AuditRow extends Record<string, unknown> {
  readonly retention_years: number;
  readonly payload: Record<string, unknown>;
}

interface PaymentRow extends Record<string, unknown> {
  readonly status: string;
  readonly auto_refund_processor_refund_id: string | null;
}

describe('F-2 — Phase-B forensic survives the rollback (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  let invoiceId: string;
  let paymentId: PaymentId;
  let paymentIntentId: string;
  /**
   * Unique per run. A stub returning a constant `re_…` would let a
   * unique index or a stale row mask the assertion; real Stripe mints a
   * fresh id per refund, so the fixture does too.
   */
  let processorRefundId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    memberId = randomUUID();
    invoiceId = randomUUID();
    paymentId = asPaymentId(`pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`);
    paymentIntentId = `pi_test_f2_${randomUUID().slice(0, 8)}`;
    processorRefundId = `re_test_f2_${randomUUID().slice(0, 12)}`;

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
        planId: 'f2-plan',
        planYear: 2026,
        planName: { en: 'F2 Plan' },
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
        companyName: 'F2 Co',
        country: 'TH',
        planId: 'f2-plan',
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
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: 'f2-plan',
        draftByUserId: user.userId,
      });
      await tx.insert(payments).values({
        id: paymentId,
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        method: 'card',
        status: 'pending',
        amountSatang: AMOUNT_SATANG,
        currency: 'THB',
        processorPaymentIntentId: paymentIntentId,
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
        correlationId: 'corr-f2-test',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
  });

  it('tx dies after the money moved → the null-tx forensic is the SOLE surviving record, at 10y retention', async () => {
    // The invoice is already `paid` (an admin marked it manually while the
    // member's online payment was in flight) → Phase A decides stale →
    // Stripe refunds → Phase B must record it.
    const processorGateway = {
      createPaymentIntent: vi.fn(),
      retrievePaymentIntent: vi.fn(async () =>
        ok({
          id: paymentIntentId,
          status: 'succeeded' as const,
          latestChargeId: 'ch_test_f2',
          livemode: false,
          lastPaymentErrorCode: null,
          card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
          clientSecret: null,
          promptpayQrSvgUrl: null,
        }),
      ),
      cancelPaymentIntent: vi.fn(),
      createRefund: vi.fn(async () =>
        ok({ id: processorRefundId, status: 'succeeded' as const, amountSatang: AMOUNT_SATANG }),
      ),
    };
    const invoicingBridge = {
      getInvoiceForPayment: vi.fn(async () =>
        ok({
          id: invoiceId,
          status: 'paid' as const,
          totalSatang: AMOUNT_SATANG,
          memberId,
          tenantId: tenant.ctx.slug,
        }),
      ),
      markPaidFromProcessor: vi.fn(async () => ok(undefined)),
    };

    // Real INSERT, then throw — see the file header.
    let inTxEmits = 0;
    const faultyAudit: typeof f5AuditAdapter = {
      async emit(tx, event) {
        await f5AuditAdapter.emit(tx, event);
        if (tx !== null) {
          inTxEmits += 1;
          throw new Error('neon: connection terminated unexpectedly');
        }
      },
    };

    const result = await runInTenant(tenant.ctx, async () =>
      confirmPayment(
        {
          paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
          tenantSettingsRepo: {
            getByTenantId: async () => ({
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
            }),
            findByProcessorAccountId: async () => null,
          } as unknown as Parameters<typeof confirmPayment>[0]['tenantSettingsRepo'],
          processorGateway:
            processorGateway as unknown as Parameters<typeof confirmPayment>[0]['processorGateway'],
          invoicingBridge:
            invoicingBridge as unknown as Parameters<typeof confirmPayment>[0]['invoicingBridge'],
          audit: faultyAudit,
          clock: systemClock,
          taxAtPayment: 'off',
        },
        {
          tenantId: tenant.ctx.slug,
          paymentIntentId,
          correlationId: 'corr-f2-test',
          requestId: 'req-f2-test',
          eventCreatedAtUnixSeconds: Math.floor(Date.now() / 1000),
        },
      ),
    );

    // Sanity: the fault fired, and the money genuinely moved.
    expect(inTxEmits, 'the in-tx money-trail emit must have executed').toBe(1);
    expect(processorGateway.createRefund).toHaveBeenCalledTimes(1);

    // ── the money assertion, first ─────────────────────────────────────
    // EXACTLY ONE row for this refund. Two would mean the in-tx money
    // trail survived the rollback; zero means the forensic never reached
    // Postgres (the adapter's null-tx branch swallows its own failures,
    // so a silent RLS rejection looks identical to success from above).
    const auditRows = await runInTenant(tenant.ctx, async (tx) => {
      const res = await tx.execute<AuditRow>(sql`
        SELECT retention_years, payload
        FROM audit_log
        WHERE tenant_id = ${tenant.ctx.slug}
          AND event_type = ${FORENSIC_EVENT}::audit_event_type
          AND payload->>'processor_refund_id' = ${processorRefundId}
      `);
      return Array.from(res);
    });
    expect(auditRows).toHaveLength(1);

    const row = auditRows[0]!;
    // It is the FORENSIC copy, not the in-tx one: only the forensic
    // carries `recovery`.
    expect(row.payload['recovery']).toBe('manual_reconcile_via_runbook');
    expect(row.payload['runbook_url']).toBe('docs/runbooks/out-of-band-refund.md');
    expect(row.payload['payment_id']).toBe(paymentId);
    expect(row.payload['invoice_id']).toBe(invoiceId);
    expect(row.payload['refunded_amount_satang']).toBe(AMOUNT_SATANG.toString());
    expect(row.payload['cause']).toBe('invoice_already_paid');
    // RD §87/3 — ten years.
    expect(row.retention_years).toBe(10);

    // ── the transaction really did unwind ──────────────────────────────
    // `markAutoRefunded` issued a real UPDATE inside that tx. If Postgres
    // had committed it the row would read `auto_refunded` with the marker
    // stamped.
    const paymentRows = await runInTenant(tenant.ctx, async (tx) => {
      const res = await tx.execute<PaymentRow>(sql`
        SELECT status::text AS status, auto_refund_processor_refund_id
        FROM payments
        WHERE id = ${paymentId} AND tenant_id = ${tenant.ctx.slug}
      `);
      return Array.from(res);
    });
    expect(paymentRows).toHaveLength(1);
    expect(paymentRows[0]!.status).toBe('pending');
    expect(paymentRows[0]!.auto_refund_processor_refund_id).toBeNull();

    // The webhook is still 200-acked (F-2 part 3 is deferred to Task 5).
    expect(result.ok).toBe(true);
  }, 60_000);
});

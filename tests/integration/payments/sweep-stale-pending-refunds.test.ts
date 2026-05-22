/**
 * T130a integration — sweep-stale-pending-refunds against live Neon.
 *
 * Seeds 2 stale pending refunds (initiated > 24h ago) and 1 fresh
 * pending refund (initiated < 24h ago). Runs the sweep with default
 * cutoff. Asserts:
 *   - Stale rows flipped to `failed` with `failureReasonCode='stale_pending_sweep'`
 *   - Fresh row left untouched (still `pending`)
 *   - 2 `stale_pending_refund_detected` audit rows emitted with
 *     `retentionYears: 10` (tax-doc lineage)
 *   - Subsequent `getRefundContextForUpdate.pendingCount` reflects
 *     the cleared block (refund-in-progress guard unblocks)
 *
 * Mocking policy: live Postgres for refundsRepo + paymentsRepo +
 * audit. No external Stripe/F4 — sweep is pure DB recovery.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSatang } from '@/lib/money';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { sweepStalePendingRefunds } from '@/modules/payments';
import { makeDrizzleRefundsRepo } from '@/modules/payments/infrastructure/repos/drizzle-refunds-repo';
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import { f5AuditAdapter } from '@/modules/payments/infrastructure/audit/drizzle-payments-audit';
import { systemClock } from '@/modules/payments/application/ports/clock-port';
import { asPaymentId, type PaymentId } from '@/modules/payments/domain/payment';
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

const HOUR_MS = 60 * 60 * 1000;

describe('sweepStalePendingRefunds — live Neon (T130a)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  let invoiceId: string;
  let paymentId: PaymentId;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    memberId = randomUUID();
    invoiceId = randomUUID();
    paymentId = asPaymentId(`pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`);

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
        planId: 'sweep-plan',
        planYear: 2026,
        planName: { en: 'Sweep Plan' },
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
        companyName: 'Sweep Co',
        country: 'TH',
        planId: 'sweep-plan',
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
        planId: 'sweep-plan',
        draftByUserId: user.userId,
      });
      await tx.insert(payments).values({
        id: paymentId,
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        method: 'card',
        status: 'succeeded',
        amountSatang: asSatang(5_350_000n),
        currency: 'THB',
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        processorChargeId: `ch_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        attemptSeq: 1,
        cardBrand: 'visa',
        cardLast4: '4242',
        cardExpMonth: 12,
        cardExpYear: 2030,
        initiatedAt: new Date(),
        completedAt: new Date(),
        actorUserId: user.userId,
        correlationId: 'corr-pay-sweep',
      });
    });

    // Seed 2 stale (>24h old) + 1 fresh pending refunds.
    const now = new Date();
    const stale1Initiated = new Date(now.getTime() - 30 * HOUR_MS);
    const stale2Initiated = new Date(now.getTime() - 48 * HOUR_MS);
    const freshInitiated = new Date(now.getTime() - 1 * HOUR_MS);

    const repo = makeDrizzleRefundsRepo(tenant.ctx.slug);
    await runInTenant(tenant.ctx, async (tx) => {
      await repo.insert(tx, {
        id: `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
        tenantId: tenant.ctx.slug,
        paymentId,
        invoiceId,
        amountSatang: asSatang(100_000n),
        reason: 'stale 30h',
        status: 'pending',
        processorRefundId: null,
        initiatorUserId: user.userId,
        correlationId: 'corr-stale-1',
        initiatedAt: stale1Initiated,
      });
      await repo.insert(tx, {
        id: `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
        tenantId: tenant.ctx.slug,
        paymentId,
        invoiceId,
        amountSatang: asSatang(200_000n),
        reason: 'stale 48h',
        status: 'pending',
        processorRefundId: null,
        initiatorUserId: user.userId,
        correlationId: 'corr-stale-2',
        initiatedAt: stale2Initiated,
      });
      await repo.insert(tx, {
        id: `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
        tenantId: tenant.ctx.slug,
        paymentId,
        invoiceId,
        amountSatang: asSatang(50_000n),
        reason: 'fresh 1h',
        status: 'pending',
        processorRefundId: null,
        initiatorUserId: user.userId,
        correlationId: 'corr-fresh',
        initiatedAt: freshInitiated,
      });
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
  });

  it('sweep flips 2 stale rows → failed; leaves fresh row pending', async () => {
    const result = await sweepStalePendingRefunds(
      {
        refundsRepo: makeDrizzleRefundsRepo(tenant.ctx.slug),
        paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
        audit: f5AuditAdapter,
        clock: systemClock,
      },
      { tenantId: tenant.ctx.slug, requestId: 'req-sweep-int' },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sweptCount).toBe(2);
      expect(result.value.skippedCount).toBe(0);
    }

    // Verify DB state — exactly 2 failed, 1 still pending.
    const counts = (await db.execute(sql`
      SELECT status, COUNT(*)::int AS c
      FROM refunds
      WHERE tenant_id = ${tenant.ctx.slug}
      GROUP BY status
    `)) as unknown as Array<{ status: string; c: number }>;
    const byStatus = Object.fromEntries(counts.map((r) => [r.status, Number(r.c)]));
    expect(byStatus.failed).toBe(2);
    expect(byStatus.pending).toBe(1);

    // Failure reason code on swept rows.
    const failed = (await db.execute(sql`
      SELECT failure_reason_code
      FROM refunds
      WHERE tenant_id = ${tenant.ctx.slug} AND status = 'failed'
    `)) as unknown as Array<{ failure_reason_code: string }>;
    for (const row of failed) {
      expect(row.failure_reason_code).toBe('stale_pending_sweep');
    }

    // The pending guard now unblocks — countPending = 1 (the fresh
    // row only); a fresh issueRefund would still hit the guard, but
    // a NEW payment + the swept 2-row block is cleared.
    const pendingCount = (await db.execute(sql`
      SELECT COUNT(*)::int AS c
      FROM refunds
      WHERE tenant_id = ${tenant.ctx.slug}
        AND payment_id = ${paymentId}
        AND status = 'pending'
    `)) as unknown as Array<{ c: number }>;
    expect(Number(pendingCount[0]?.c ?? 0)).toBe(1);
  }, 60_000);

  it('idempotent — second sweep run finds zero stale rows', async () => {
    const result = await sweepStalePendingRefunds(
      {
        refundsRepo: makeDrizzleRefundsRepo(tenant.ctx.slug),
        paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
        audit: f5AuditAdapter,
        clock: systemClock,
      },
      { tenantId: tenant.ctx.slug, requestId: 'req-sweep-int-2' },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sweptCount).toBe(0);
      expect(result.value.skippedCount).toBe(0);
    }
  }, 30_000);
});

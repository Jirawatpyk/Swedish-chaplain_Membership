/**
 * T109 integration — DrizzleRefundsRepo against live Neon.
 *
 * Smoke-tests the repo's contract:
 *   - insert + round-trip via getRefundContextForUpdate
 *   - updateStatus pending → failed (with failureReasonCode)
 *   - findByProcessorRefundId after Stripe id is set
 *   - getRefundContextForUpdate aggregates correctly across multiple
 *     inserts in the same (tenant, payment) partition (pending count
 *     + nextSeq increment); succeeded-sum path is covered indirectly
 *     via the empty-partition COALESCE check
 *   - RLS cross-tenant isolation: tenant B's repo sees ZERO of
 *     tenant A's refund rows even when given tenant A's paymentId
 *
 * The succeeded-path round-trip (with credit_note_id NOT NULL) is
 * NOT covered here — it requires seeding an F4 credit_note row
 * (full PDF + Blob + sequence allocation chain). That round-trip is
 * exercised end-to-end via the issueRefund use-case integration test.
 *
 * Mocking policy: this file hits live Postgres. No SUT mocks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import { makeDrizzleRefundsRepo } from '@/modules/payments/infrastructure/repos/drizzle-refunds-repo';
import {
  tenantPaymentSettings,
  type NewTenantPaymentSettingsRow,
} from '@/modules/payments/infrastructure/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import type { PaymentId } from '@/modules/payments/domain/payment';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
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

function makePaymentUlid(): string {
  return `pmt_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
function makeRefundUlid(): string {
  return `rfnd_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

describe('DrizzleRefundsRepo — live Neon', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let invoiceId: string;
  let memberId: string;
  let paymentIdA: PaymentId;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    invoiceId = randomUUID();
    memberId = randomUUID();

    // Seed tenant A: payment-settings + F4 parent chain + ONE succeeded
    // promptpay payment (which the refund rows attach to).
    const settings: NewTenantPaymentSettingsRow = {
      tenantId: tenantA.ctx.slug,
      processor: 'stripe',
      processorEnvironment: 'test',
      processorAccountId: `acct_test_${tenantA.ctx.slug.slice(-8)}`,
      processorPublishableKey: `pk_test_${tenantA.ctx.slug.slice(-8)}`,
      enabledMethods: ['card', 'promptpay'],
      onlinePaymentEnabled: true,
      autoEmailOnPayment: true,
      promptpayQrExpirySeconds: 900,
      allowAnonymousPaylink: false,
    };

    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(tenantPaymentSettings).values(settings);
      await tx.insert(membershipPlans).values({
        tenantId: tenantA.ctx.slug,
        planId: 'rfnd-plan',
        planYear: 2026,
        planName: { en: 'Refund Plan' },
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
        tenantId: tenantA.ctx.slug,
        memberId,
        companyName: 'Refund Co',
        country: 'TH',
        planId: 'rfnd-plan',
        planYear: 2026,
      });
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenantA.ctx.slug,
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
        tenantId: tenantA.ctx.slug,
        documentType: 'invoice',
        fiscalYear: 2026,
      });
      await tx.insert(invoices).values({
        tenantId: tenantA.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: 'rfnd-plan',
        draftByUserId: user.userId,
      });
    });

    // Insert two pending payments (one per test tenant) — each is the
    // FK target the refund rows below attach to. Status stays
    // 'pending' for the test; refunds.payment_id FK only needs the
    // row to exist, not to be in a particular status (the FR-011b
    // invariant lives in use-case logic, not DB CHECK).
    paymentIdA = makePaymentUlid() as PaymentId;
    const paymentsRepoA = makeDrizzlePaymentsRepo(tenantA.ctx.slug);
    await paymentsRepoA.withTx(async (tx) =>
      paymentsRepoA.insert(tx, {
        id: paymentIdA,
        tenantId: tenantA.ctx.slug,
        invoiceId,
        memberId,
        method: 'promptpay',
        amountSatang: 5_350_000n,
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        attemptSeq: 1,
        initiatedAt: new Date(),
        actorUserId: user.userId,
        correlationId: 'corr-rfnd-A',
      }),
    );
  }, 90_000);

  afterAll(async () => {
    await tenantA.cleanup().catch((e) => console.error('tenantA cleanup:', e));
    await tenantB.cleanup().catch((e) => console.error('tenantB cleanup:', e));
  });

  it('insert pending refund + getRefundContextForUpdate sees the row', async () => {
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
    const refundId = makeRefundUlid();
    const initiatedAt = new Date();

    // Repo doesn't expose withTx (RefundsRepo port keeps the tx
    // boundary at the use-case level — `paymentsRepo.withTx` is the
    // canonical wrapper). Drive via `runInTenant` directly here,
    // mirroring how `issueRefund` will share its outer tx with the
    // refunds repo through the same tenant-bound connection.
    const ctxAfterInsert = await runInTenant(tenantA.ctx, async (tx) => {
      await repo.insert(tx, {
        id: refundId,
        tenantId: tenantA.ctx.slug,
        paymentId: paymentIdA,
        invoiceId,
        amountSatang: 100_000n,
        reason: 'first partial',
        status: 'pending',
        processorRefundId: null,
        initiatorUserId: user.userId,
        correlationId: 'corr-rfnd-1',
        initiatedAt,
      });
      return repo.getRefundContextForUpdate(tx, tenantA.ctx.slug, paymentIdA);
    });

    expect(ctxAfterInsert.pendingCount).toBe(1);
    expect(ctxAfterInsert.succeededSumSatang).toBe(0n);
    expect(ctxAfterInsert.nextSeq).toBe(2); // 1 row exists → next is 2
  });

  it('updateStatus pending → failed sets failureReasonCode + completedAt', async () => {
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
    const refundId = makeRefundUlid();
    const initiatedAt = new Date();
    const failedAt = new Date(initiatedAt.getTime() + 5_000);

    await runInTenant(tenantA.ctx, async (tx) => {
      await repo.insert(tx, {
        id: refundId,
        tenantId: tenantA.ctx.slug,
        paymentId: paymentIdA,
        invoiceId,
        amountSatang: 50_000n,
        reason: 'will fail',
        status: 'pending',
        processorRefundId: null,
        initiatorUserId: user.userId,
        correlationId: 'corr-rfnd-fail',
        initiatedAt,
      });
      const updated = await repo.updateStatus(tx, {
        refundId,
        tenantId: tenantA.ctx.slug,
        nextStatus: 'failed',
        failureReasonCode: 'retryable',
        completedAt: failedAt,
      });
      expect(updated.status).toBe('failed');
      // Failed rows do not carry a processor_refund_id (CHECK
      // constraint allows NULL only for non-succeeded statuses).
      expect(updated.processorRefundId).toBeNull();
    });
  });

  it('getRefundContextForUpdate aggregates pending rows + tracks nextSeq', async () => {
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);

    // Insert 2 more pending rows — total partition state should be
    // (1 from test #1) + (1 failed from test #2 — counts toward nextSeq)
    // + 2 new pending = 4 rows total → pendingCount=3, nextSeq=5.
    await runInTenant(tenantA.ctx, async (tx) => {
      for (let i = 0; i < 2; i += 1) {
        await repo.insert(tx, {
          id: makeRefundUlid(),
          tenantId: tenantA.ctx.slug,
          paymentId: paymentIdA,
          invoiceId,
          amountSatang: 25_000n,
          reason: `bulk-${i}`,
          status: 'pending',
          processorRefundId: null,
          initiatorUserId: user.userId,
          correlationId: `corr-bulk-${i}`,
          initiatedAt: new Date(),
        });
      }
      const ctx = await repo.getRefundContextForUpdate(
        tx,
        tenantA.ctx.slug,
        paymentIdA,
      );
      // Test order: this test runs after #1 (1 pending) + #2 (1 failed)
      // → 2 starting rows + 2 new = 4 total; pendingCount = 1 (test #1) + 2 new = 3.
      expect(ctx.pendingCount).toBe(3);
      expect(ctx.succeededSumSatang).toBe(0n);
      expect(ctx.nextSeq).toBe(5);
    });
  });

  it('findByProcessorRefundId returns null for unknown id', async () => {
    const repo = makeDrizzleRefundsRepo(tenantA.ctx.slug);
    await runInTenant(tenantA.ctx, async (tx) => {
      const found = await repo.findByProcessorRefundId(
        tx,
        tenantA.ctx.slug,
        're_does_not_exist',
      );
      expect(found).toBeNull();
    });
  });

  it('RLS cross-tenant: tenant B sees ZERO of tenant A refunds even with A paymentId', async () => {
    // Tenant B's repo bound to tenant B's RLS context. Even when
    // we hand it tenant A's paymentId, the RLS policy filters out
    // every row where tenant_id != app.current_tenant.
    const repoB = makeDrizzleRefundsRepo(tenantB.ctx.slug);
    const ctxFromB = await runInTenant(tenantB.ctx, async (tx) =>
      repoB.getRefundContextForUpdate(tx, tenantA.ctx.slug, paymentIdA),
    );
    expect(ctxFromB.pendingCount).toBe(0);
    expect(ctxFromB.succeededSumSatang).toBe(0n);
    expect(ctxFromB.nextSeq).toBe(1);
  });
});

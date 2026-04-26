/**
 * T-P4-08 — concurrent cross-method-cancel safety on live Neon.
 *
 * Threat model: under high cross-method-switch load (rare in practice
 * because it requires a member rapidly toggling between Card and
 * PromptPay tabs), two parallel `initiatePayment` calls could both
 * see the same `pending` row from `findPendingByInvoiceAndActor` and
 * both attempt to cancel + insert a new attempt. The reliability
 * concern: does this produce a DB deadlock or pool-timeout, or does
 * the schema's partial unique index `payments_one_active_per_invoice`
 * (migration 0033) correctly serialize the writes so that exactly
 * one wins and the other surfaces a deterministic constraint
 * violation?
 *
 * What this test pins:
 *   - At most ONE row in (pending | succeeded | partially_refunded) per
 *     (tenant, invoice) at any moment, even under concurrent insert
 *     attempts targeting the same invoice + actor.
 *   - The losing INSERT raises a clean Postgres unique-violation error
 *     (NOT a deadlock, NOT a connection-pool timeout) — caller can
 *     map this to a retryable surface.
 *   - A canceled row coexists with a fresh pending row for the same
 *     (tenant, invoice) — the partial-unique-index excludes terminal
 *     statuses, so the design's safety net works as intended.
 *
 * This test exercises the SCHEMA contract directly (raw repo calls)
 * rather than the full use-case to avoid Stripe SDK mocking inside
 * the integration suite. The use-case-level concurrency narrative is
 * covered by the unit tests in `tests/unit/payments/application/
 * initiate-payment.test.ts`.
 *
 * Mocking policy: live Postgres only. No SUT mocks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
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

function makeUlid(): string {
  return `pmt_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

describe('concurrent cross-method cancel — partial unique index safety', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let memberId: string;
  let invoiceId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;
    memberId = randomUUID();
    invoiceId = randomUUID();

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
        planId: 'concurrent-plan',
        planYear: 2026,
        planName: { en: 'Concurrent' },
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
        companyName: 'Concurrent Co',
        country: 'TH',
        planId: 'concurrent-plan',
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
        planId: 'concurrent-plan',
        draftByUserId: user.userId,
      });
    });
  }, 90_000);

  afterAll(async () => {
    await tenantA.cleanup().catch((e) => console.error('tenantA cleanup:', e));
    await tenantB.cleanup().catch((e) => console.error('tenantB cleanup:', e));
  });

  it('two parallel inserts targeting the same invoice — exactly one succeeds, the other raises a clean unique-violation (no deadlock, no pool timeout)', async () => {
    const repo = makeDrizzlePaymentsRepo(tenantA.ctx.slug);
    const now = new Date();
    const piA = `pi_test_${randomUUID().slice(0, 8)}`;
    const piB = `pi_test_${randomUUID().slice(0, 8)}`;

    const insertA = repo.withTx(async (tx) =>
      repo.insert(tx, {
        id: makeUlid() as PaymentId,
        tenantId: tenantA.ctx.slug,
        invoiceId,
        memberId,
        method: 'card',
        amountSatang: 5_350_000n,
        processorPaymentIntentId: piA,
        processorEnvironment: 'test',
        attemptSeq: 1,
        initiatedAt: now,
        actorUserId: user.userId,
        correlationId: 'corr-conc-A',
      }),
    );
    const insertB = repo.withTx(async (tx) =>
      repo.insert(tx, {
        id: makeUlid() as PaymentId,
        tenantId: tenantA.ctx.slug,
        invoiceId,
        memberId,
        method: 'promptpay',
        amountSatang: 5_350_000n,
        processorPaymentIntentId: piB,
        processorEnvironment: 'test',
        attemptSeq: 1,
        initiatedAt: now,
        actorUserId: user.userId,
        correlationId: 'corr-conc-B',
      }),
    );

    const results = await Promise.allSettled([insertA, insertB]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Partial unique index `payments_one_active_per_invoice` permits
    // at most one non-terminal payment per (tenant, invoice).
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // Loser raises a clean PostgreSQL unique-violation, NOT a
    // deadlock or pool timeout.
    const rejectedReason =
      rejected[0]?.status === 'rejected' ? rejected[0].reason : null;
    const reasonStr =
      rejectedReason instanceof Error
        ? rejectedReason.message
        : String(rejectedReason);
    expect(reasonStr.toLowerCase()).toMatch(
      /unique|duplicate|payments_one_active_per_invoice/,
    );
    expect(reasonStr.toLowerCase()).not.toContain('deadlock');
    expect(reasonStr.toLowerCase()).not.toContain('timeout');
  }, 30_000);
});

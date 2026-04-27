/**
 * T136 — Concurrent `initiatePayment` race-safety (post-critique R2-E2).
 *
 * Spec authority: spec.md FR-008 idempotency + plan.md § Reliability D-01.
 *
 * Member double-clicks "Pay" or refreshes the page mid-request. Two
 * `initiatePayment` calls fire simultaneously for the SAME (tenant, invoice,
 * actor). Required invariants:
 *
 *   (a) Exactly ONE row in `payments` for that invoice (the partial unique
 *       constraint `payments_one_active_per_invoice` rejects the second
 *       insert, and the use-case's resume-check converts it into a "return
 *       the existing pending row" path).
 *
 *   (b) Both responses succeed with the SAME `clientSecret` (one issued
 *       a fresh PaymentIntent; the other resumed the same row).
 *
 *   (c) Both responses report the SAME `paymentIntentId`.
 *
 *   (d) Exactly ONE `payment_initiated` audit row fires (the resume path
 *       skips the audit emit per use-case docblock).
 *
 *   (e) Exactly ONE Stripe `createPaymentIntent` call to the gateway (the
 *       resume path uses `retrievePaymentIntent` to fetch the existing
 *       clientSecret instead of double-charging the user).
 *
 * Mocking policy: live Neon for everything except (a) processor gateway
 * (mocked to avoid Stripe RTT and to count invocations) and (b) tenant
 * settings repo (fixture per F5 codebase convention because Next.js
 * `unstable_cache` requires request context unavailable in Vitest —
 * documented limitation, see `f4-markpaid-integration.test.ts:403-417`).
 *
 * Why an integration test (not unit): the partial unique index is the
 * authority on (a); Drizzle Postgres semantics are the authority on which
 * concurrent insert wins; only a real DB exposes the race. Unit tests with
 * mocked repos cannot reproduce the constraint behaviour.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ok } from '@/lib/result';
import { db, runInTenant } from '@/lib/db';
import { makeInitiatePaymentDeps } from '@/modules/payments/infrastructure/di';
import { initiatePayment } from '@/modules/payments/application/use-cases/initiate-payment';
import type {
  ProcessorGatewayPort,
  CreatedPaymentIntent,
  RetrievedPaymentIntent,
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
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
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

interface CallCounts {
  createPaymentIntent: number;
  retrievePaymentIntent: number;
}

/**
 * Deterministic mock gateway: createPaymentIntent returns ONE fixed PI;
 * retrievePaymentIntent returns the same PI's clientSecret. A small artificial
 * delay is added so the two Promise.all callers actually overlap inside
 * the use-case's withTx — without the delay the second call could complete
 * before the first inserts, eliminating the race we want to exercise.
 */
function makeRaceGateway(piId: string): {
  gateway: ProcessorGatewayPort;
  counts: CallCounts;
} {
  const counts: CallCounts = { createPaymentIntent: 0, retrievePaymentIntent: 0 };
  const fixedClientSecret = `${piId}_secret_fixed_for_t136`;
  const created: CreatedPaymentIntent = {
    id: piId,
    clientSecret: fixedClientSecret,
    status: 'requires_payment_method',
    livemode: false,
    promptpayQrSvgUrl: null,
  };
  const retrieved: RetrievedPaymentIntent = {
    id: piId,
    status: 'requires_payment_method',
    promptpayQrSvgUrl: null,
    clientSecret: fixedClientSecret,
    latestChargeId: null,
    livemode: false,
    lastPaymentErrorCode: null,
    card: null,
  };
  return {
    gateway: {
      async createPaymentIntent() {
        counts.createPaymentIntent += 1;
        // L-4 (review 2026-04-27): bumped from 50ms to 250ms to absorb
        // CI cold-start latency on GitHub Actions. The original 50ms
        // sometimes did not produce overlap on slow runners (Neon
        // Singapore RTT + Vitest worker boot). 250ms keeps the test
        // fast (median <500ms wall-clock) while leaving ample margin
        // for the second caller to arrive at the use-case's withTx
        // before the first releases. A proper barrier-promise pattern
        // would be cleaner but requires use-case-level instrumentation
        // hooks (one caller takes the createIntent path, the other
        // takes the retrieve path under the resume guard) — deferred.
        await new Promise((resolve) => setTimeout(resolve, 250));
        return ok(created);
      },
      async retrievePaymentIntent() {
        counts.retrievePaymentIntent += 1;
        return ok(retrieved);
      },
      async cancelPaymentIntent() {
        throw new Error('not used in T136');
      },
      async createRefund() {
        throw new Error('not used in T136');
      },
    },
    counts,
  };
}

describe('T136 concurrent initiatePayment for same invoice (R2-E2)', () => {
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
        planId: 't136-plan',
        planYear: 2026,
        planName: { en: 'T136 Plan' },
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
        companyName: 'T136 Co',
        country: 'TH',
        planId: 't136-plan',
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
        planId: 't136-plan',
        status: 'issued',
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
          legal_name: 'T136 Co',
          tax_id: '1234567890123',
          address: 'Bangkok',
          primary_contact_name: 'T136 Contact',
          primary_contact_email: 't136@example.com',
        },
        pdfBlobKey: 'invoices/t136.pdf',
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      });
    });
  }, 120_000);

  afterAll(async () => {
    if (tenant) {
      await tenant.cleanup().catch((e) =>
        console.error('T136 tenant cleanup:', e),
      );
    }
  });

  it('two concurrent initiatePayment calls → exactly one row + identical clientSecret', async () => {
    const piId = `pi_t136_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const { gateway, counts } = makeRaceGateway(piId);
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

    const inputBase = {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      actorMemberId: memberId,
      actorEmail: user.email,
      invoiceId,
      method: 'card' as const,
      requestId: 'req-t136-race',
    };

    const [a, b] = await Promise.all([
      initiatePayment(deps, { ...inputBase, correlationId: 'corr-t136-A' }),
      initiatePayment(deps, { ...inputBase, correlationId: 'corr-t136-B' }),
    ]);

    // Both must succeed.
    expect(a.ok, `call A failed: ${JSON.stringify(!a.ok && a.error)}`).toBe(true);
    expect(b.ok, `call B failed: ${JSON.stringify(!b.ok && b.error)}`).toBe(true);
    if (!a.ok || !b.ok) return;

    // (b) Same clientSecret.
    expect(a.value.clientSecret).toBe(b.value.clientSecret);
    // (c) Same paymentIntentId.
    expect(a.value.paymentIntentId).toBe(b.value.paymentIntentId);
    expect(a.value.paymentIntentId).toBe(piId);

    // (a) Exactly ONE Payment row.
    const paymentRows = await db
      .select()
      .from(payments)
      .where(eq(payments.invoiceId, invoiceId));
    expect(paymentRows.length, 'exactly one Payment row for the invoice').toBe(1);

    // (e) Exactly ONE Stripe createPaymentIntent call. The other call
    // either (i) found the pending row via resume-check and used
    // retrievePaymentIntent OR (ii) lost the constraint race and the
    // use-case's retry-after-conflict path returned the existing row.
    expect(
      counts.createPaymentIntent,
      `expected exactly 1 createPaymentIntent call, got ${counts.createPaymentIntent}`,
    ).toBe(1);

    // (d) Exactly ONE payment_initiated audit row.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        sql`${auditLog.eventType} = 'payment_initiated'
            AND ${auditLog.tenantId} = ${tenant.ctx.slug}
            AND ${auditLog.payload}->>'invoice_id' = ${invoiceId}`,
      );
    expect(
      auditRows.length,
      `expected exactly 1 payment_initiated audit row, got ${auditRows.length}`,
    ).toBe(1);

    // The single payment row must reference the SAME PI as both responses.
    expect(paymentRows[0]!.processorPaymentIntentId).toBe(piId);
    expect(paymentRows[0]!.status).toBe('pending');
  }, 60_000);
});

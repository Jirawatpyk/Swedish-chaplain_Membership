/**
 * T148 — Payment-initiate latency benchmark (live Neon, mocked Stripe).
 *
 * Spec authority: `specs/009-online-payment/plan.md` § Performance Goals —
 *   p95 `/api/payments/initiate` < 1.2 s (Stripe RTT included)
 *   p99 < 3 s
 *
 * This benchmark measures the **app-layer** path of `initiatePayment`
 * use-case with a 0ms mocked Stripe gateway, so the measurement reflects
 * OUR code path: tenant resolution, settings read, F4 `getInvoiceForPayment`
 * bridge, resume-check, DB insert + audit emit. Production p95 adds
 * Stripe RTT (~200-500ms typical) on top.
 *
 * App-layer p95 budget = total budget − Stripe RTT headroom = 700ms.
 *
 * Gated by `RUN_PERF=1` so regular CI ticks don't burn 60+ seconds. Skip
 * is observable in the report.
 *
 * Run locally:
 *   RUN_PERF=1 pnpm test:integration tests/integration/payments/payments-initiate-benchmark.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ok } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { makeInitiatePaymentDeps } from '@/modules/payments/infrastructure/di';
import { initiatePayment } from '@/modules/payments/application/use-cases/initiate-payment';
import type {
  ProcessorGatewayPort,
  CreatedPaymentIntent,
  TenantPaymentSettingsRepo,
} from '@/modules/payments/application/ports';
import type { TenantPaymentSettings } from '@/modules/payments/domain/tenant-payment-settings';
import type { InitiatePaymentDeps } from '@/modules/payments/application/use-cases/initiate-payment';
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
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

const RUN_PERF = process.env.RUN_PERF === '1';

const APP_LAYER_P95_BUDGET_MS = 700;
const APP_LAYER_P99_BUDGET_MS = 1500;
const SAMPLE_COUNT = 100;
const WARMUP_COUNT = 5;

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

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[idx]!;
}

/**
 * 0ms mock gateway — returns a fixed CreatedPaymentIntent immediately.
 * Each call gets a fresh `pi_…` id so the unique-constraint
 * `payments_processor_payment_intent_id_unique` doesn't reject inserts.
 */
function makeFastGateway(): ProcessorGatewayPort {
  return {
    async createPaymentIntent() {
      const pi: CreatedPaymentIntent = {
        id: `pi_perf_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        clientSecret: `pi_perf_${randomUUID().slice(0, 8)}_secret_${randomUUID().slice(0, 8)}`,
        status: 'requires_payment_method',
        livemode: false,
        promptpayQrSvgUrl: null,
      };
      return ok(pi);
    },
    async retrievePaymentIntent() {
      throw new Error('not used in T148 benchmark');
    },
    async cancelPaymentIntent() {
      throw new Error('not used in T148 benchmark');
    },
    async createRefund() {
      throw new Error('not used in T148 benchmark');
    },
  };
}

describe('T148 payments-initiate latency benchmark (live Neon, mocked Stripe)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  let invoiceIds: string[] = [];
  let deps: InitiatePaymentDeps;

  beforeAll(async () => {
    if (!RUN_PERF) return;

    user = await createActiveTestUser('member');
    const pair = await createTwoTestTenants();
    tenant = pair.a;
    memberId = randomUUID();

    // Need (warmup + sample) fresh invoices because of the
    // `payments_one_active_per_invoice` partial unique constraint.
    const total = WARMUP_COUNT + SAMPLE_COUNT;
    invoiceIds = Array.from({ length: total }, () => randomUUID());

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
        planId: 'perf-plan',
        planYear: 2026,
        planName: { en: 'Perf Plan' },
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
        companyName: 'Perf Co',
        country: 'TH',
        planId: 'perf-plan',
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
        invoiceNumberPrefix: 'P',
        creditNoteNumberPrefix: 'PC',
      });
      await tx.insert(tenantDocumentSequences).values({
        tenantId: tenant.ctx.slug,
        documentType: 'invoice',
        fiscalYear: 2026,
      });
      // Invoices in `issued` status with totalSatang set so the F4
      // bridge `getInvoiceForPayment` returns ok and `assertPayable`
      // accepts them. Issue/due dates use today + 30d so the row is
      // not artificially overdue when the benchmark runs.
      const today = new Date();
      const issueDate = today.toISOString().slice(0, 10);
      const dueDate = new Date(today.getTime() + 30 * 86400_000)
        .toISOString()
        .slice(0, 10);
      for (let i = 0; i < invoiceIds.length; i += 1) {
        await tx.insert(invoices).values({
          tenantId: tenant.ctx.slug,
          invoiceId: invoiceIds[i]!,
          memberId,
          planYear: 2026,
          planId: 'perf-plan',
          status: 'issued',
          draftByUserId: user.userId,
          fiscalYear: 2026,
          sequenceNumber: i + 1,
          documentNumber: `P-2026-${String(i + 1).padStart(6, '0')}`,
          issueDate,
          dueDate,
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
            legal_name: 'Perf Co',
            tax_id: '1234567890123',
            address: 'Bangkok',
            primary_contact_name: 'Perf Contact',
            primary_contact_email: 'perf@example.com',
          },
          pdfBlobKey: 'invoices/perf.pdf',
          pdfSha256: 'a'.repeat(64),
          pdfTemplateVersion: 1,
        });
      }
    });

    // Wire deps with the fast mock gateway + a non-cached settings repo
    // (the real impl wraps reads in `unstable_cache` which throws
    // "Invariant: incrementalCache missing" outside Next.js request
    // context — a documented limitation of the F5 test infra; see
    // `tests/integration/payments/payment-method-switched-audit.test.ts`
    // and `f4-markpaid-integration.test.ts:403-417` for prior precedents).
    // The wrapper layer is pure memoisation with no business logic, so
    // exercising it is not material to this perf measurement.
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
    deps = {
      ...makeInitiatePaymentDeps(tenant.ctx.slug),
      processorGateway: makeFastGateway(),
      tenantSettingsRepo: settingsRepoFixture,
    };
  }, 120_000);

  afterAll(async () => {
    if (tenant) {
      await tenant.cleanup().catch((e) =>
        console.error('T148 tenant cleanup:', e),
      );
    }
  });

  it.skipIf(!RUN_PERF)(
    `app-layer use-case: p95 < ${APP_LAYER_P95_BUDGET_MS}ms over ${SAMPLE_COUNT} invocations`,
    async () => {
      let cursor = 0;
      const callOnce = async (): Promise<number> => {
        const invoiceId = invoiceIds[cursor];
        cursor += 1;
        if (!invoiceId) throw new Error('T148: ran out of seeded invoices');
        const t0 = performance.now();
        const result = await initiatePayment(deps, {
          tenantId: tenant.ctx.slug,
          actorUserId: user.userId,
          actorMemberId: memberId,
          actorEmail: user.email,
          invoiceId,
          method: 'card',
          correlationId: `corr-perf-${cursor}`,
          requestId: `req-perf-${cursor}`,
        });
        const ms = performance.now() - t0;
        if (!result.ok) {
          throw new Error(
            `initiatePayment failed at sample ${cursor}: ${JSON.stringify(result.error)}`,
          );
        }
        return ms;
      };

      // Warmup — primes the connection pool, plan cache, OTel meter.
      for (let i = 0; i < WARMUP_COUNT; i += 1) {
        await callOnce();
      }

      const samples: number[] = [];
      for (let i = 0; i < SAMPLE_COUNT; i += 1) {
        samples.push(await callOnce());
      }
      samples.sort((a, b) => a - b);

      const p50 = percentile(samples, 0.5);
      const p95 = percentile(samples, 0.95);
      const p99 = percentile(samples, 0.99);
       
      console.log(
        `[T148] payments-initiate-benchmark: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms (n=${samples.length}, app-layer only — production adds Stripe RTT)`,
      );

      expect(
        p95,
        `app-layer p95 ${p95.toFixed(1)}ms exceeded ${APP_LAYER_P95_BUDGET_MS}ms budget`,
      ).toBeLessThan(APP_LAYER_P95_BUDGET_MS);
      expect(p99).toBeLessThan(APP_LAYER_P99_BUDGET_MS);
    },
    300_000,
  );

  it('smoke: percentile helper composes correctly', () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(samples, 0.5)).toBe(50);
    expect(percentile(samples, 0.95)).toBe(100);
    expect(percentile([], 0.5)).toBe(0);
  });
});

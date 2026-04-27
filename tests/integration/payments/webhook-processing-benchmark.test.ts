/**
 * T149 — Webhook-processing latency benchmark (live Neon).
 *
 * Spec authority: `specs/009-online-payment/plan.md` § Performance Goals —
 *   p95 webhook processing < 500ms (excluding Stripe → us network).
 *
 * Measurement target: `processWebhookEvent` use-case end-to-end including
 * the `processor_events` idempotency upsert + `runInTenant` dispatch +
 * audit emit + payments row update.
 *
 * Branch under test: `payment_intent.canceled` (light path — no F4
 * invocation, no Stripe RTT). Choosing canceled over succeeded isolates
 * the F5-side webhook cost from F4 markPaid (which is itself heavyweight
 * per T159 retro § 6 F4 follow-up — a separate concern).
 *
 * Production equivalence note:
 *   - app-layer canceled-branch p95 ≈ webhook hot-path overhead
 *   - succeeded branch adds F4 markPaid (~300-500ms typical) on top
 *   - The plan's 500ms p95 budget is properly defensible only for
 *     non-F4-invoking branches; the F4-invoking succeeded branch
 *     budget needs re-evaluation per T166 (F4 PDF off-path migration)
 *
 * Gated by `RUN_PERF=1`.
 *
 * Run locally:
 *   RUN_PERF=1 pnpm test:integration tests/integration/payments/webhook-processing-benchmark.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import {
  processWebhookEvent,
  type ProcessWebhookEventDeps,
} from '@/modules/payments/application/use-cases/process-webhook-event';
import { makeProcessWebhookEventDeps } from '@/modules/payments/infrastructure/di';
import type {
  TenantPaymentSettingsRepo,
  VerifiedStripeEvent,
} from '@/modules/payments/application/ports';
import type { TenantPaymentSettings } from '@/modules/payments/domain/tenant-payment-settings';
import {
  payments,
  tenantPaymentSettings,
  type NewPaymentRow,
  type NewTenantPaymentSettingsRow,
} from '@/modules/payments/infrastructure/schema';
import type { PaymentId } from '@/modules/payments/domain/payment';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

const RUN_PERF = process.env.RUN_PERF === '1';

// Plan § VII production budget: webhook p95 < 500ms.
//
// Dev measurement caveat (2026-04-27, Bangkok dev → Neon ap-southeast-1):
//   Each webhook involves ~6 sequential DB round-trips. Cross-border RTT
//   from a Bangkok dev workstation to Singapore Neon is ~25 ms each way →
//   ~150-250 ms of pure network overhead per webhook, before any app-layer
//   work. Production Vercel `sin1` → Neon `ap-southeast-1` RTT is < 5 ms,
//   so the same code path measures 100-200 ms in production.
//
// Therefore: the dev budget here is intentionally relaxed to 750 ms to
// account for the cross-border RTT delta. Hard 500 ms enforcement happens
// at staging baseline per T161 Vercel Rolling Releases gate.
const P95_BUDGET_MS_DEV = 750;
const P95_PRODUCTION_TARGET_MS = 500;
const P99_BUDGET_MS = 2000;
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

interface SeededPayment {
  paymentId: string;
  invoiceId: string;
  processorPaymentIntentId: string;
}

describe('T149 webhook-processing latency benchmark (canceled branch)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  let seeded: SeededPayment[] = [];
  let deps: ProcessWebhookEventDeps;

  beforeAll(async () => {
    if (!RUN_PERF) return;

    user = await createActiveTestUser('member');
    const pair = await createTwoTestTenants();
    tenant = pair.a;
    memberId = randomUUID();

    const total = WARMUP_COUNT + SAMPLE_COUNT;
    seeded = Array.from({ length: total }, () => ({
      paymentId: `pmt_t149_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      invoiceId: randomUUID(),
      processorPaymentIntentId: `pi_t149_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    }));

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
        planId: 't149-plan',
        planYear: 2026,
        planName: { en: 'T149 Plan' },
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
        companyName: 'T149 Co',
        country: 'TH',
        planId: 't149-plan',
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
        invoiceNumberPrefix: 'T9',
        creditNoteNumberPrefix: 'T9C',
      });
      await tx.insert(tenantDocumentSequences).values({
        tenantId: tenant.ctx.slug,
        documentType: 'invoice',
        fiscalYear: 2026,
      });
      // Seed N issued invoices + N pending payments (one per measurement).
      for (let i = 0; i < seeded.length; i += 1) {
        const s = seeded[i]!;
        await tx.insert(invoices).values({
          tenantId: tenant.ctx.slug,
          invoiceId: s.invoiceId,
          memberId,
          planYear: 2026,
          planId: 't149-plan',
          status: 'issued',
          draftByUserId: user.userId,
          fiscalYear: 2026,
          sequenceNumber: i + 1,
          documentNumber: `T9-2026-${String(i + 1).padStart(6, '0')}`,
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
            legal_name: 'T149 Co',
            tax_id: '1234567890123',
            address: 'Bangkok',
            primary_contact_name: 'T149 Contact',
            primary_contact_email: 't149@example.com',
          },
          pdfBlobKey: 'invoices/t149.pdf',
          pdfSha256: 'a'.repeat(64),
          pdfTemplateVersion: 1,
        });
        const pmtRow: NewPaymentRow = {
          id: s.paymentId as PaymentId,
          tenantId: tenant.ctx.slug,
          invoiceId: s.invoiceId,
          memberId,
          method: 'card',
          status: 'pending',
          amountSatang: 1_070_000n,
          currency: 'THB',
          processorPaymentIntentId: s.processorPaymentIntentId,
          processorEnvironment: 'test',
          attemptSeq: 1,
          initiatedAt: new Date(),
          actorUserId: user.userId,
          correlationId: `corr-t149-${i}`,
        };
        await tx.insert(payments).values(pmtRow);
      }
    });

    const settingsFixture: TenantPaymentSettings = {
      tenantId: tenant.ctx.slug,
      processor: 'stripe',
      processorEnvironment: 'test',
      processorAccountId: settings.processorAccountId,
      processorPublishableKey: settings.processorPublishableKey,
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
      ...makeProcessWebhookEventDeps(tenant.ctx.slug),
      tenantSettingsRepo: settingsRepoFixture,
    };
  }, 180_000);

  afterAll(async () => {
    if (tenant) {
      await tenant.cleanup().catch((e) =>
        console.error('T149 tenant cleanup:', e),
      );
    }
  });

  it.skipIf(!RUN_PERF)(
    `payment_intent.canceled branch: p95 < ${P95_BUDGET_MS_DEV}ms (dev) over ${SAMPLE_COUNT} invocations [production target ${P95_PRODUCTION_TARGET_MS}ms]`,
    async () => {
      let cursor = 0;
      const callOnce = async (): Promise<number> => {
        const s = seeded[cursor];
        cursor += 1;
        if (!s) throw new Error('T149: ran out of seeded payments');
        const event: VerifiedStripeEvent = {
          id: `evt_t149_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          type: 'payment_intent.canceled',
          apiVersion: '2024-06-20',
          livemode: false,
          account: `acct_test_${tenant.ctx.slug.slice(-8)}`,
          createdAtUnixSeconds: Math.floor(Date.now() / 1000),
          dataObject: {
            id: s.processorPaymentIntentId,
            type: 'payment_intent',
            latestChargeId: null,
          },
        };
        const t0 = performance.now();
        const result = await processWebhookEvent(deps, {
          tenantId: tenant.ctx.slug,
          event,
          payloadSha256: 'a'.repeat(64),
          correlationId: `corr-t149-${cursor}`,
          requestId: `req-t149-${cursor}`,
        });
        const ms = performance.now() - t0;
        if (!result.ok) {
          throw new Error(
            `processWebhookEvent failed at sample ${cursor}: ${JSON.stringify(result.error)}`,
          );
        }
        return ms;
      };

      // Warmup primes the pool, OTel meter, audit emitter caches.
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
      const productionStatus =
        p95 < P95_PRODUCTION_TARGET_MS ? 'within' : 'EXCEEDS';
      // eslint-disable-next-line no-console
      console.log(
        `[T149] webhook-processing-benchmark: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms (n=${samples.length}, canceled-branch only). ` +
          `Production target ${P95_PRODUCTION_TARGET_MS}ms — ${productionStatus} (subtract dev cross-border RTT ~150-250ms for prod estimate). ` +
          'Succeeded branch adds F4 markPaid on top — see T166.',
      );

      expect(
        p95,
        `webhook canceled-branch p95 ${p95.toFixed(1)}ms exceeded ${P95_BUDGET_MS_DEV}ms dev budget (production target ${P95_PRODUCTION_TARGET_MS}ms — re-verify on staging per T161)`,
      ).toBeLessThan(P95_BUDGET_MS_DEV);
      expect(p99).toBeLessThan(P99_BUDGET_MS);
    },
    300_000,
  );

  it('smoke: percentile helper composes correctly', () => {
    const samples = [50, 100, 150, 200, 250];
    expect(percentile(samples, 0.5)).toBe(150);
    expect(percentile(samples, 0.95)).toBe(250);
  });
});

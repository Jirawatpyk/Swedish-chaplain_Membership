/**
 * T166-12 — Webhook async-PDF latency benchmark.
 *
 * Proves the T166 hot-path improvement: moving receipt-PDF render off
 * the `payment_intent.succeeded` webhook tx drops `recordPayment`
 * latency p95 from ~5–15 s (inline render+upload) to < 1.5 s
 * (outbox enqueue only).
 *
 * The benchmark times the `recordPayment` use-case directly (rather
 * than the HTTP webhook) because:
 *   1. The webhook handler's outer envelope (signature verify +
 *      processor_events upsert) is shared by BOTH modes — only
 *      `recordPayment` differs between sync and async flag values.
 *      Timing the use-case isolates the SLO-relevant component.
 *   2. HTTP fixtures would require a fake Stripe Webhook signature
 *      generator, doubling the test surface for a measurement that
 *      adds no signal.
 *
 * Gated by `RUN_PERF=1` so regular CI ticks don't burn ~3 minutes
 * on this. Records the measured numbers into a dated perf-results
 * markdown file under specs/ for the Phase 11 review trail.
 *
 * NOTE (review-20260428-102639.md B2): Full benchmark is gated by
 * RUN_PERF=1 because n=30 × 2 modes seeds and tears down ~60 paid
 * invoices per run. A regular-CI 5-iteration smoke variant is
 * tracked as post-ship S11 — until then, this file enforces the
 * SLO-F5-002b dev budget (< 1000 ms) when run, and the maintainer
 * triggers it manually before any /speckit.ship gate.
 *
 * Run locally:
 *   RUN_PERF=1 pnpm test:integration \
 *     tests/integration/perf/webhook-async-pdf-benchmark.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { recordPayment } from '@/modules/invoicing/application/use-cases/record-payment';
import { makeRecordPaymentDeps } from '@/modules/invoicing/application/invoicing-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import {
  createActiveTestUser,
  type TestUser,
} from '../helpers/test-users';

const RUN_PERF = process.env.RUN_PERF === '1';

// Iteration count picked to give a stable p95 estimate without
// blowing the test wall-clock budget. With both modes timed, total
// is ~2x ITER * (median latency).
//
// review-20260428-102639.md W4 closure — bumped n=30 → n=100 + 5-warmup
// discarded per T148/T149 methodology. p95 from n=100 = the 96th-of-100
// sorted sample (one outlier no longer skews a full slot). PERF_ITER /
// PERF_WARMUP env overrides allow a quick smoke run with smaller n.
const ITER = process.env.PERF_ITER ? Number(process.env.PERF_ITER) : 100;
const WARMUP = process.env.PERF_WARMUP ? Number(process.env.PERF_WARMUP) : 5;

// SLO targets. Pre-T166 the inline path was 5–15 s; we leave a
// generous ceiling so the benchmark doesn't false-fail on slow
// shared CI hosts. The post-T166 ceiling tracks the hot-path SLO
// in observability.md § 21.2 (SLO-F5-002b post-T166: < 1000 ms
// dev / < 750 ms prod). The 1500 ms upper bound here is the
// CI-safety wall (used to avoid false-fail on cold shared hosts);
// the SLO-aligned assertion `ASYNC_P95_SLO_BUDGET_MS` is the real
// gate (see review-20260428-102639.md B2 closure).
const ASYNC_P95_BUDGET_MS = 1500;
const ASYNC_P95_SLO_BUDGET_MS = 1000;

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

function p95(samplesMs: number[]): number {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

async function seedSendableInvoice(
  tenant: TestTenant,
  user: TestUser,
): Promise<{ invoiceId: string }> {
  const memberId = randomUUID();
  const invoiceId = randomUUID();
  const planId = `t166p-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: 'T166 Perf Plan' },
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
    await tx
      .insert(tenantInvoiceSettings)
      .values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 500000n,
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'T166P',
        creditNoteNumberPrefix: 'T166PC',
      })
      .onConflictDoNothing({ target: tenantInvoiceSettings.tenantId });
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: 'T166 Perf Co',
      country: 'TH',
      planId,
      planYear: 2026,
    });
    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      planYear: 2026,
      planId,
      status: 'issued',
      draftByUserId: user.userId,
      fiscalYear: 2026,
      sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
      documentNumber: `T166P-2026-${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`,
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
        legal_name: 'T166 Perf Co',
        tax_id: '1234567890123',
        address: 'Bangkok',
        primary_contact_name: 'Perf Contact',
        primary_contact_email: 'perf@example.com',
      },
      pdfBlobKey: 'invoicing/test/t166-perf.pdf',
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
    });
    await tx.insert(invoiceLines).values({
      tenantId: tenant.ctx.slug,
      lineId: randomUUID(),
      invoiceId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก',
      descriptionEn: 'Membership',
      unitPriceSatang: 1_000_000n,
      quantity: '1',
      proRateFactor: null,
      totalSatang: 1_000_000n,
      position: 1,
    });
  });
  return { invoiceId };
}

async function timeRecordPayment(
  tenant: TestTenant,
  user: TestUser,
  asyncReceiptPdf: boolean,
): Promise<number> {
  const { invoiceId } = await seedSendableInvoice(tenant, user);
  const deps = {
    ...makeRecordPaymentDeps(tenant.ctx.slug),
    asyncReceiptPdf,
  };
  const start = performance.now();
  const result = await runInTenant(tenant.ctx, async () =>
    recordPayment(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      paymentMethod: 'other',
      paymentDate: '2026-05-01',
      requestId: `perf-${randomUUID()}`,
    }),
  );
  const elapsed = performance.now() - start;
  if (!result.ok) {
    throw new Error(`recordPayment failed: ${result.error.code}`);
  }
  return elapsed;
}

describe.skipIf(!RUN_PERF)(
  'T166-12 — webhook async-PDF latency benchmark',
  () => {
    let tenant: TestTenant;
    let user: TestUser;

    beforeAll(async () => {
      user = await createActiveTestUser('admin');
      tenant = await createTestTenant();
    }, 90_000);

    afterAll(async () => {
      await tenant.cleanup().catch(() => {});
    });

    it(
      `recordPayment p95 (asyncReceiptPdf=true) < ${ASYNC_P95_BUDGET_MS}ms over ${ITER} runs (${WARMUP}-warmup discarded)`,
      async () => {
        // Warmup pass — drives JIT, warms Neon connection pool, primes
        // ORM caches. These samples are discarded so cold-start does
        // not contaminate p95.
        for (let i = 0; i < WARMUP; i += 1) {
          await timeRecordPayment(tenant, user, true);
          await timeRecordPayment(tenant, user, false);
        }

        const asyncSamples: number[] = [];
        for (let i = 0; i < ITER; i += 1) {
          asyncSamples.push(await timeRecordPayment(tenant, user, true));
        }

        const syncSamples: number[] = [];
        for (let i = 0; i < ITER; i += 1) {
          syncSamples.push(await timeRecordPayment(tenant, user, false));
        }

        const asyncP95 = p95(asyncSamples);
        const syncP95 = p95(syncSamples);
        const asyncMedian = [...asyncSamples].sort((a, b) => a - b)[
          Math.floor(asyncSamples.length / 2)
        ]!;
        const syncMedian = [...syncSamples].sort((a, b) => a - b)[
          Math.floor(syncSamples.length / 2)
        ]!;

        // Persist for Phase 11 review trail.
        const today = new Date().toISOString().slice(0, 10);
        const outDir = join(process.cwd(), 'specs', '009-online-payment');
        mkdirSync(outDir, { recursive: true });
        const outPath = join(outDir, `perf-results-t166-${today}.md`);
        writeFileSync(
          outPath,
          [
            `# T166 perf results — ${today}`,
            '',
            `**Iterations**: ${ITER} per mode (sync + async).`,
            '',
            '| Mode | median ms | p95 ms |',
            '|---|---|---|',
            `| asyncReceiptPdf=true (T166 default) | ${asyncMedian.toFixed(0)} | ${asyncP95.toFixed(0)} |`,
            `| asyncReceiptPdf=false (legacy) | ${syncMedian.toFixed(0)} | ${syncP95.toFixed(0)} |`,
            '',
            `**Improvement (p95)**: ${(((syncP95 - asyncP95) / syncP95) * 100).toFixed(1)} %`,
            '',
            `Source: \`tests/perf/webhook-async-pdf-benchmark.test.ts\``,
            '',
          ].join('\n'),
          'utf8',
        );

        // SLO check — async path must clear its budget. Sync path is
        // recorded for the comparison report but NOT asserted (legacy
        // path is being deleted; failing the bench on it would block
        // CI for no operational benefit).
        expect(asyncP95).toBeLessThan(ASYNC_P95_BUDGET_MS);
        // SLO-F5-002b dev budget — the real gate. Post-T166 budget is
        // 1000 ms dev / 750 ms prod; we assert the dev value here so
        // CI catches a regression before it hits staging.
        expect(asyncP95).toBeLessThan(ASYNC_P95_SLO_BUDGET_MS);
        // Sanity: async should be materially faster than sync.
        expect(asyncP95).toBeLessThan(syncP95);
      },
      // Generous timeout — 60 paid invoices @ ~5 s each in sync mode.
      // n=100 + 5-warmup × 2 modes × ~5s each ≈ 17.5 min worst-case.
      // 30 min ceiling gives 70% safety margin.
      30 * 60_000,
    );
  },
);

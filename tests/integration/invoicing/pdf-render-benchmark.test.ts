/**
 * T110 — PDF render benchmark (post-critique E6).
 *
 * Proves the `reactPdfRenderAdapter` meets the "issuance budget"
 * contract: p95 render latency < 800ms over 100 renders, so the
 * overall `issueInvoice` transaction stays under its 1.5s p95 SLA
 * (plan § Perf & Observability).
 *
 * Gated by `RUN_PERF=1` so regular CI ticks don't burn 30+ seconds
 * on deterministic PDF output. Skip is observable in the report.
 *
 * Run locally:
 *   RUN_PERF=1 pnpm test:integration tests/perf/pdf-render-benchmark.test.ts
 *
 * The adapter is invoked with a realistic invoice (5 line items,
 * bilingual TH+EN descriptions, full tenant+member snapshots, 7% VAT)
 * so the measurement reflects production-shaped input rather than a
 * minimal fixture that might optimise past the real per-render cost.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { asInvoiceLineId } from '@/modules/invoicing/domain/invoice-line';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';

const RUN_PERF = process.env.RUN_PERF === '1';

// Budget per post-critique E6. Measured end-to-end on Neon SG x86 /
// Windows 11 / Node 22 LTS (dev). Production Vercel `sin1` is usually
// within ±10%; the 800ms ceiling leaves headroom for the Resend +
// Blob + audit emit tail of `issueInvoice` before busting 1.5s p95.
const P95_BUDGET_MS = 800;

function buildRealisticInput(): PdfRenderInput {
  const docNum = DocumentNumber.of('SC', 2026, 42);
  if (!docNum.ok) throw new Error('fixture: DocumentNumber.of failed');
  return {
    kind: 'invoice',
    templateVersion: 1,
    documentNumber: docNum.value,
    issueDate: '2026-04-18',
    dueDate: '2026-05-18',
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thailand-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: '140/1 เมืองไทย-ภัทร คอมเพล็กซ์, ถ.รัชดาภิเษก, ดินแดง, กรุงเทพฯ 10400',
      address_en: '140/1 Muang Thai-Phatra Complex, Ratchadaphisek Rd, Din Daeng, Bangkok 10400',
      logo_blob_key: null,
    },
    member: {
      legal_name: 'Acme Global Solutions Co., Ltd.',
      tax_id: '1234567890123',
      address: '99/1 สุขุมวิท 21 (อโศก), คลองเตยเหนือ, วัฒนา, กรุงเทพฯ 10110',
      primary_contact_name: 'คุณสมชาย ใจดี / John Doe',
      primary_contact_email: 'billing@acme-global.example',
      // 055-member-number — additive field on the snapshot (null → no line).
      member_number: null,
    },
    lines: [
      {
        lineId: asInvoiceLineId('11111111-1111-4111-8111-111111111111'),
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิกรายปี 2026 — แพ็กเกจ Corporate Gold',
        descriptionEn: 'Annual Membership Fee 2026 — Corporate Gold Package',
        unitPrice: Money.fromSatangUnsafe(50_000_00n),
        quantity: '1.0000',
        proRateFactor: '1.0000',
        total: Money.fromSatangUnsafe(50_000_00n),
        position: 1,
      },
      {
        lineId: asInvoiceLineId('22222222-2222-4222-8222-222222222222'),
        kind: 'registration_fee',
        descriptionTh: 'ค่าลงทะเบียนแรกเข้า (ครั้งเดียว)',
        descriptionEn: 'Initial Registration Fee (one-time)',
        unitPrice: Money.fromSatangUnsafe(5_000_00n),
        quantity: '1.0000',
        proRateFactor: '1.0000',
        total: Money.fromSatangUnsafe(5_000_00n),
        position: 2,
      },
      {
        lineId: asInvoiceLineId('33333333-3333-4333-8333-333333333333'),
        kind: 'membership_fee',
        descriptionTh: 'สิทธิ์ Premium E-Blast เพิ่มเติม (12 ครั้ง/ปี)',
        descriptionEn: 'Premium E-Blast Add-on (12 sends/year)',
        unitPrice: Money.fromSatangUnsafe(1_500_00n),
        quantity: '1.0000',
        proRateFactor: '1.0000',
        total: Money.fromSatangUnsafe(1_500_00n),
        position: 3,
      },
      {
        lineId: asInvoiceLineId('44444444-4444-4444-8444-444444444444'),
        kind: 'membership_fee',
        descriptionTh: 'โฆษณาบนหน้าหลักเว็บไซต์ — โลโก้ใหญ่ (รายปี)',
        descriptionEn: 'Homepage Logo Placement — Large Tier (annual)',
        unitPrice: Money.fromSatangUnsafe(2_000_00n),
        quantity: '1.0000',
        proRateFactor: '1.0000',
        total: Money.fromSatangUnsafe(2_000_00n),
        position: 4,
      },
      {
        lineId: asInvoiceLineId('55555555-5555-4555-8555-555555555555'),
        kind: 'membership_fee',
        descriptionTh: 'ตั๋วกิจกรรมเชิงวัฒนธรรมสวีเดน 4 ใบ',
        descriptionEn: 'Swedish Cultural Event Tickets × 4',
        unitPrice: Money.fromSatangUnsafe(1_500_00n),
        quantity: '1.0000',
        proRateFactor: '1.0000',
        total: Money.fromSatangUnsafe(1_500_00n),
        position: 5,
      },
    ],
    subtotal: Money.fromSatangUnsafe(60_000_00n),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(4_200_00n),
    total: Money.fromSatangUnsafe(64_200_00n),
  };
}

function percentile(sortedMs: number[], p: number): number {
  const idx = Math.ceil(p * sortedMs.length) - 1;
  return sortedMs[Math.max(0, idx)]!;
}

describe('T110 — PDF render benchmark (post-critique E6)', () => {
  // Adapter may start a worker / warm up font cache on first call;
  // we do not dispose anything here because the adapter is a module-
  // level singleton shared with production.

  afterAll(() => {});

  it.skipIf(!RUN_PERF)(
    'invoice kind: p95 < 800ms over 100 renders',
    async () => {
      const input = buildRealisticInput();

      // Warmup — font registration + react-pdf runtime init is a
      // one-off cost that would skew the first sample by 5-10×.
      for (let i = 0; i < 5; i += 1) {
        await reactPdfRenderAdapter.render(input);
      }

      const samples: number[] = [];
      for (let i = 0; i < 100; i += 1) {
        const t0 = performance.now();
        await reactPdfRenderAdapter.render(input);
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);

      const p50 = percentile(samples, 0.5);
      const p95 = percentile(samples, 0.95);
      const p99 = percentile(samples, 0.99);
      console.log(
        `[T110] pdf-render-benchmark: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms (n=${samples.length})`,
      );

      expect(
        p95,
        `p95 render latency ${p95.toFixed(1)}ms exceeded ${P95_BUDGET_MS}ms budget`,
      ).toBeLessThan(P95_BUDGET_MS);
    },
    300_000,
  );

  // Smoke assertion so the file is not dead weight when RUN_PERF is
  // unset — proves the adapter + fixture still compose correctly.
  it('smoke: realistic input renders a valid PDF', async () => {
    const input = buildRealisticInput();
    const result = await reactPdfRenderAdapter.render(input);
    expect(result.bytes.byteLength).toBeGreaterThan(1000);
    const head = Buffer.from(result.bytes.slice(0, 5)).toString('latin1');
    expect(head).toBe('%PDF-');
  }, 30_000);
});

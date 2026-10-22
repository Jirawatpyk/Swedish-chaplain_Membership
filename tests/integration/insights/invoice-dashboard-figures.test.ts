/**
 * 124 slice 2 — the invoice dashboard's figures against live Postgres (Neon
 * dev), one case per line of spec 124 § Figure definitions.
 *
 * The scenario (`invoice-dashboard-seed.ts`) is seeded with `tx` inside
 * `runInTenant` on a disposable tenant; every expected number there is
 * hand-computed from the rows. `today` is a parameter (2026-06-15), never
 * the database's clock, so the figures are deterministic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fiscalYearDateRange,
  loadInvoiceDashboardAging,
  loadInvoiceDashboardAttention,
  loadInvoiceDashboardMethods,
  loadInvoiceDashboardOldestOverdue,
  loadInvoiceDashboardTiles,
  loadInvoiceDashboardTrend,
  makeLoadInvoiceDashboardDeps,
  type InvoiceDashboardFilters,
  type InvoiceDashboardLoadInput,
} from '@/modules/insights';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import {
  EXPECTED,
  TODAY,
  seedInvoiceDashboardScenario,
  type SeededScenario,
} from './invoice-dashboard-seed';

function input(filters: Partial<InvoiceDashboardFilters> = {}): InvoiceDashboardLoadInput {
  return {
    filters: { type: 'all', fiscalYear: 2026, planId: null, origin: 'all', ...filters },
    today: TODAY,
    fiscalYearRange: fiscalYearDateRange(2026, 1),
    canWrite: true,
  };
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`loader failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('invoice dashboard figures (spec 124 § Figure definitions)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let seeded: SeededScenario;
  const deps = makeLoadInvoiceDashboardDeps();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    seeded = await seedInvoiceDashboardScenario(tenant, user, 1n);
  });

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
    await deleteTestUser(user).catch((e) => console.error('user cleanup:', e));
  });

  describe('Outstanding, Overdue and aging (as of today, all years)', () => {
    it('Outstanding = Σ total and count of issued; the aging buckets come from the same query and add up to it', async () => {
      const tiles = unwrap(await loadInvoiceDashboardTiles(tenant.ctx, input(), deps));
      const aging = unwrap(await loadInvoiceDashboardAging(tenant.ctx, input(), deps));
      expect(tiles.outstanding).toEqual(EXPECTED.outstanding);
      expect(aging.totalSatang).toBe(EXPECTED.outstanding.amountSatang);
      expect(aging.count).toBe(EXPECTED.outstanding.count);
      for (const row of aging.buckets) {
        expect({ bucket: row.bucket, amountSatang: row.amountSatang, count: row.count }).toEqual({
          bucket: row.bucket,
          ...EXPECTED.aging[row.bucket],
        });
      }
      expect(aging.buckets.reduce((s, b) => s + b.sharePercent, 0)).toBe(100);
    });

    it('Overdue is due_date < today: an invoice due today is not overdue; edges 30/31, 60/61, 90/91 land as agingBucketOf says', async () => {
      const tiles = unwrap(await loadInvoiceDashboardTiles(tenant.ctx, input(), deps));
      expect(tiles.overdue).toEqual(EXPECTED.overdue);
      const rows = unwrap(await loadInvoiceDashboardOldestOverdue(tenant.ctx, input(), deps, 50)).rows;
      expect(rows.map((r) => r.invoiceId)).not.toContain(seeded.ids.iDueToday);
    });
  });

  describe('Collected (document basis, D-d)', () => {
    it('this month = the Bangkok month of today; a NULL payment_date falls back to paid_at as a Bangkok date', async () => {
      const tiles = unwrap(await loadInvoiceDashboardTiles(tenant.ctx, input(), deps));
      // 2026-05-31T17:30Z is 2026-06-01 in Bangkok: it lands in June.
      expect(tiles.collectedThisMonth).toEqual({
        ...EXPECTED.collectedThisMonth,
        range: { from: '2026-06-01', to: '2026-06-30' },
      });
    });

    it('this month ignores the FY filter', async () => {
      const tiles = unwrap(
        await loadInvoiceDashboardTiles(
          tenant.ctx,
          { ...input({ fiscalYear: 2025 }), fiscalYearRange: fiscalYearDateRange(2025, 1) },
          deps,
        ),
      );
      expect(tiles.collectedThisMonth.amountSatang).toBe(EXPECTED.collectedThisMonth.amountSatang);
      // FY 2025 holds only the four attention invoices (4 × 100,000), and the
      // waived refund on aW (10,000, completed 2025-08-06) nets out.
      expect(tiles.collectedInFiscalYear).toEqual({
        amountSatang: 390_000n,
        invoiceCount: 4,
        range: { from: '2025-01-01', to: '2025-12-31' },
        toDate: false,
      });
    });

    it('in FY to date: paid family by tax point − credit notes by issue date − waived refunds by Bangkok completed date', async () => {
      const tiles = unwrap(await loadInvoiceDashboardTiles(tenant.ctx, input(), deps));
      expect(tiles.collectedInFiscalYear).toEqual({
        ...EXPECTED.collectedInFiscalYear,
        range: { from: '2026-01-01', to: '2026-06-15' },
        toDate: true,
      });
    });

    it('a credit note lands in its own month; a refund with its credit note nets once; a waived refund at 23:30 UTC on 30 Apr nets in May', async () => {
      const trend = unwrap(await loadInvoiceDashboardTrend(tenant.ctx, input(), deps));
      const april = trend.slots.find((s) => s.monthKey === '2026-04');
      const may = trend.slots.find((s) => s.monthKey === '2026-05');
      // April: 214,000 + 642,000 − the 107,000 credit note (its refund is NOT
      // subtracted again).
      expect(april?.collectedSatang).toBe(749_000n);
      // May: 856,000 (pF4 — its f4_bridge refund is not netted) + 963,000
      // − 42,800 (manual credit note) − 64,200 (waived, Bangkok 1 May).
      expect(may?.collectedSatang).toBe(1_712_000n);
    });

    it('a refund with an invoice_voided waiver on a void invoice nets 0, never negative', async () => {
      const trend = unwrap(await loadInvoiceDashboardTrend(tenant.ctx, input(), deps));
      // February: pManualCN 428,000 only — not 428,000 − 30,000.
      expect(trend.slots.find((s) => s.monthKey === '2026-02')?.collectedSatang).toBe(428_000n);
    });
  });

  describe('Billed and Collected by month (trend)', () => {
    it('all 12 FY slots; Billed by issue_date excludes draft and void and nets credit notes by their issue_date; future months empty', async () => {
      const trend = unwrap(await loadInvoiceDashboardTrend(tenant.ctx, input(), deps));
      expect(trend.slots).toHaveLength(12);
      for (const slot of trend.slots) {
        const want = EXPECTED.trend[slot.monthKey as keyof typeof EXPECTED.trend];
        if (slot.state === 'future') {
          expect(slot).toMatchObject({ billedSatang: null, collectedSatang: null });
        } else {
          expect({ month: slot.monthKey, billed: slot.billedSatang, collected: slot.collectedSatang }).toEqual({
            month: slot.monthKey,
            billed: want.billed,
            collected: want.collected,
          });
        }
      }
      // The months' Collected add up to the FY tile.
      const tiles = unwrap(await loadInvoiceDashboardTiles(tenant.ctx, input(), deps));
      const sum = trend.slots.reduce((s, m) => s + (m.collectedSatang ?? 0n), 0n);
      expect(sum).toBe(tiles.collectedInFiscalYear.amountSatang);
    });
  });

  describe('By payment method', () => {
    it('a Stripe-paid invoice is card or PromptPay, never other, and counted once; the rows add up to Collected in FY', async () => {
      const methods = unwrap(await loadInvoiceDashboardMethods(tenant.ctx, input(), deps));
      expect(Object.fromEntries(methods.rows.map((r) => [r.method, r.amountSatang]))).toEqual(
        EXPECTED.methods,
      );
      const tiles = unwrap(await loadInvoiceDashboardTiles(tenant.ctx, input(), deps));
      expect(methods.totalSatang).toBe(tiles.collectedInFiscalYear.amountSatang);
      expect(methods.rows.reduce((s, r) => s + r.amountSatang, 0n)).toBe(methods.totalSatang);
    });
  });

  describe('Needs attention', () => {
    it('five counts; refunds failed at Stripe by the latest attempt per payment; settled-but-unbooked = failed f4_bridge_%', async () => {
      const attention = unwrap(await loadInvoiceDashboardAttention(tenant.ctx, input(), deps));
      expect(attention).toEqual({
        receiptPdfFailed: EXPECTED.attention.receiptPdfFailed,
        refundsFailedAtStripe: EXPECTED.attention.refundsFailedAtStripe,
        refundsSettledUnbooked: EXPECTED.attention.refundsSettledUnbooked,
        drafts: {
          manual: EXPECTED.attention.manualDrafts,
          autoRenewal: EXPECTED.attention.autoRenewalDrafts,
        },
      });
    });

    it('a manager gets no draft rows', async () => {
      const attention = unwrap(
        await loadInvoiceDashboardAttention(tenant.ctx, { ...input(), canWrite: false }, deps),
      );
      expect('drafts' in attention).toBe(false);
    });
  });

  describe('Oldest overdue', () => {
    it('longest past due first, then amount desc, then document number; buyer name, number, days past due, amount', async () => {
      const result = unwrap(await loadInvoiceDashboardOldestOverdue(tenant.ctx, input(), deps, 50));
      expect(result.rows.map((r) => r.invoiceId)).toEqual(
        EXPECTED.oldestOverdueOrder.map((k) => seeded.ids[k]),
      );
      expect(result.rows[0]).toEqual({
        invoiceId: seeded.ids.iD91,
        documentNumber: 'DB-2026-000009',
        buyerName: 'Buyer iD91',
        dueDate: '2026-03-16',
        daysPastDue: 91,
        amountSatang: 160_000n,
      });
    });

    it('honours the limit', async () => {
      const result = unwrap(await loadInvoiceDashboardOldestOverdue(tenant.ctx, input(), deps, 3));
      expect(result.rows.map((r) => r.invoiceId)).toEqual(
        EXPECTED.oldestOverdueOrder.slice(0, 3).map((k) => seeded.ids[k]),
      );
    });
  });

  describe('filters narrow every query, subtractions included', () => {
    it('type = event', async () => {
      const i = input({ type: 'event' });
      const tiles = unwrap(await loadInvoiceDashboardTiles(tenant.ctx, i, deps));
      expect(tiles.outstanding).toEqual({ amountSatang: 160_000n, count: 1 });
      expect(tiles.overdue).toEqual({ amountSatang: 160_000n, count: 1 });
      expect(tiles.collectedThisMonth.amountSatang).toBe(0n);
      expect(tiles.collectedInFiscalYear).toMatchObject({ amountSatang: 963_000n, invoiceCount: 1 });
      const methods = unwrap(await loadInvoiceDashboardMethods(tenant.ctx, i, deps));
      expect(methods.rows.filter((r) => r.amountSatang !== 0n)).toEqual([
        { method: 'bank_transfer', amountSatang: 963_000n },
      ]);
      const trend = unwrap(await loadInvoiceDashboardTrend(tenant.ctx, i, deps));
      expect(trend.slots.filter((s) => (s.billedSatang ?? 0n) !== 0n || (s.collectedSatang ?? 0n) !== 0n)).toEqual([
        expect.objectContaining({ monthKey: '2026-05', billedSatang: 963_000n, collectedSatang: 963_000n }),
      ]);
      expect(unwrap(await loadInvoiceDashboardAttention(tenant.ctx, i, deps))).toEqual({
        receiptPdfFailed: 0,
        refundsFailedAtStripe: 0,
        refundsSettledUnbooked: 0,
        drafts: { manual: 0, autoRenewal: 0 },
      });
      const oldest = unwrap(await loadInvoiceDashboardOldestOverdue(tenant.ctx, i, deps));
      expect(oldest.rows.map((r) => r.invoiceId)).toEqual([seeded.ids.iD91]);
    });

    it('type = membership drops the event invoices', async () => {
      const tiles = unwrap(await loadInvoiceDashboardTiles(tenant.ctx, input({ type: 'membership' }), deps));
      expect(tiles.outstanding).toEqual({ amountSatang: 540_000n, count: 8 });
      expect(tiles.collectedInFiscalYear.amountSatang).toBe(5_029_000n);
    });

    it('plan = gold matches every plan year (the 2025 row too) and nets only gold subtractions', async () => {
      const i = input({ type: 'membership', planId: 'gold' });
      const tiles = unwrap(await loadInvoiceDashboardTiles(tenant.ctx, i, deps));
      // iDueToday + iD1 + iD31 + iD31b + iD61 (plan year 2025).
      expect(tiles.outstanding).toEqual({ amountSatang: 280_000n, count: 5 });
      expect(tiles.overdue).toEqual({ amountSatang: 180_000n, count: 4 });
      // 1,070,000 + 214,000 + 321,000 + 642,000 + 1,177,000 (2025 row)
      // − 107,000 − 64,200; the silver manual credit note is not subtracted.
      expect(tiles.collectedInFiscalYear).toMatchObject({ amountSatang: 3_252_800n, invoiceCount: 5 });
      expect(tiles.collectedThisMonth.amountSatang).toBe(0n);
      const methods = unwrap(await loadInvoiceDashboardMethods(tenant.ctx, i, deps));
      expect(Object.fromEntries(methods.rows.map((r) => [r.method, r.amountSatang]))).toEqual({
        bank_transfer: 1_070_000n,
        promptpay: 214_000n,
        card: 791_800n,
        cheque: 1_177_000n,
        cash: 0n,
        other: 0n,
      });
      expect(unwrap(await loadInvoiceDashboardAttention(tenant.ctx, i, deps))).toEqual({
        receiptPdfFailed: 1,
        refundsFailedAtStripe: 1,
        refundsSettledUnbooked: 0,
        drafts: { manual: 1, autoRenewal: 1 },
      });
    });

    it('plan = silver nets only silver subtractions (the gold waived refund and credit note stay out)', async () => {
      const i = input({ type: 'membership', planId: 'silver' });
      const tiles = unwrap(await loadInvoiceDashboardTiles(tenant.ctx, i, deps));
      expect(tiles.outstanding).toEqual({ amountSatang: 260_000n, count: 3 });
      expect(tiles.collectedInFiscalYear).toMatchObject({ amountSatang: 1_776_200n, invoiceCount: 3 });
      const trend = unwrap(await loadInvoiceDashboardTrend(tenant.ctx, i, deps));
      // April: no silver document at all; the gold credit note is not netted here.
      expect(trend.slots.find((s) => s.monthKey === '2026-04')).toMatchObject({
        billedSatang: 20_000n + 40_000n,
        collectedSatang: 0n,
      });
      expect(unwrap(await loadInvoiceDashboardAttention(tenant.ctx, i, deps))).toEqual({
        receiptPdfFailed: 0,
        refundsFailedAtStripe: 0,
        refundsSettledUnbooked: 1,
        drafts: { manual: 1, autoRenewal: 0 },
      });
    });

    it('origin = auto_renewal', async () => {
      const i = input({ origin: 'auto_renewal' });
      const tiles = unwrap(await loadInvoiceDashboardTiles(tenant.ctx, i, deps));
      expect(tiles.outstanding).toEqual({ amountSatang: 80_000n, count: 1 });
      expect(tiles.collectedInFiscalYear).toMatchObject({ amountSatang: 1_177_000n, invoiceCount: 1 });
      expect(unwrap(await loadInvoiceDashboardAttention(tenant.ctx, i, deps))).toMatchObject({
        drafts: { manual: 0, autoRenewal: 1 },
      });
      const oldest = unwrap(await loadInvoiceDashboardOldestOverdue(tenant.ctx, i, deps));
      expect(oldest.rows.map((r) => r.invoiceId)).toEqual([seeded.ids.iD61]);
    });
  });
});

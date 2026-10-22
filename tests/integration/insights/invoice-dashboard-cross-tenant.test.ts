/**
 * 124 slice 2 — Principle I (NON-NEGOTIABLE): tenant B's invoices, credit
 * notes, payments and refunds never appear in tenant A's invoice-dashboard
 * figures, for every loader.
 *
 * The same scenario is seeded in both tenants, A at scale 1 and B at scale 10
 * (amounts × 10, counts equal). Any leak in either direction — an invoice, a
 * subtraction, a method row, a refund attempt — moves a figure off its
 * hand-computed value for that tenant's scale (or doubles a count).
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
  type InvoiceDashboardLoadInput,
} from '@/modules/insights';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import {
  EXPECTED,
  NOW,
  TODAY,
  seedInvoiceDashboardScenario,
  type SeededScenario,
} from './invoice-dashboard-seed';

const INPUT: InvoiceDashboardLoadInput = {
  filters: { type: 'all', fiscalYear: 2026, planId: null, origin: 'all' },
  today: TODAY,
  now: NOW,
  fiscalYearRange: fiscalYearDateRange(2026, 1),
  canWrite: true,
};

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`loader failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('invoice dashboard — cross-tenant isolation (Principle I)', () => {
  let user: TestUser;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let seededA: SeededScenario;
  let seededB: SeededScenario;
  const deps = makeLoadInvoiceDashboardDeps();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant();
    tenantB = await createTestTenant();
    seededA = await seedInvoiceDashboardScenario(tenantA, user, 1n);
    seededB = await seedInvoiceDashboardScenario(tenantB, user, 10n);
  });

  afterAll(async () => {
    await tenantA.cleanup().catch((e) => console.error('tenantA cleanup:', e));
    await tenantB.cleanup().catch((e) => console.error('tenantB cleanup:', e));
    await deleteTestUser(user).catch((e) => console.error('user cleanup:', e));
  });

  const cases = [
    ['A', 1n],
    ['B', 10n],
  ] as const;

  for (const [name, scale] of cases) {
    const tenant = () => (name === 'A' ? tenantA : tenantB);

    it(`tenant ${name}: tiles and aging hold only its own invoices, credit notes and refunds`, async () => {
      const tiles = unwrap(await loadInvoiceDashboardTiles(tenant().ctx, INPUT, deps));
      expect(tiles.outstanding).toEqual({
        amountSatang: EXPECTED.outstanding.amountSatang * scale,
        count: EXPECTED.outstanding.count,
      });
      expect(tiles.overdue).toEqual({
        amountSatang: EXPECTED.overdue.amountSatang * scale,
        count: EXPECTED.overdue.count,
      });
      expect(tiles.collectedThisMonth.amountSatang).toBe(
        EXPECTED.collectedThisMonth.amountSatang * scale,
      );
      expect(tiles.collectedInFiscalYear).toMatchObject({
        amountSatang: EXPECTED.collectedInFiscalYear.amountSatang * scale,
        invoiceCount: EXPECTED.collectedInFiscalYear.invoiceCount,
      });
      const aging = unwrap(await loadInvoiceDashboardAging(tenant().ctx, INPUT, deps));
      for (const row of aging.buckets) {
        expect([row.bucket, row.amountSatang, row.count]).toEqual([
          row.bucket,
          EXPECTED.aging[row.bucket].amountSatang * scale,
          EXPECTED.aging[row.bucket].count,
        ]);
      }
    });

    it(`tenant ${name}: method rows and the trend hold only its own documents`, async () => {
      const methods = unwrap(await loadInvoiceDashboardMethods(tenant().ctx, INPUT, deps));
      for (const row of methods.rows) {
        expect([row.method, row.amountSatang]).toEqual([row.method, EXPECTED.methods[row.method] * scale]);
      }
      const trend = unwrap(await loadInvoiceDashboardTrend(tenant().ctx, INPUT, deps));
      for (const slot of trend.slots.filter((s) => s.state !== 'future')) {
        const want = EXPECTED.trend[slot.monthKey as keyof typeof EXPECTED.trend];
        expect([slot.monthKey, slot.billedSatang, slot.collectedSatang]).toEqual([
          slot.monthKey,
          want.billed * scale,
          want.collected * scale,
        ]);
      }
    });

    it(`tenant ${name}: attention counts and oldest overdue rows are its own`, async () => {
      const attention = unwrap(await loadInvoiceDashboardAttention(tenant().ctx, INPUT, deps));
      expect(attention).toEqual({
        receiptPdfFailed: EXPECTED.attention.receiptPdfFailed,
        refundsFailedAtStripe: EXPECTED.attention.refundsFailedAtStripe,
        refundsPendingOverThreshold: EXPECTED.attention.refundsPendingOverThreshold,
        drafts: {
          manual: EXPECTED.attention.manualDrafts,
          autoRenewal: EXPECTED.attention.autoRenewalDrafts,
        },
      });
      const own = name === 'A' ? seededA : seededB;
      const other = name === 'A' ? seededB : seededA;
      const rows = unwrap(await loadInvoiceDashboardOldestOverdue(tenant().ctx, INPUT, deps, 50)).rows;
      expect(rows).toHaveLength(EXPECTED.oldestOverdueOrder.length);
      for (const row of rows) {
        expect(own.allInvoiceIds.has(row.invoiceId)).toBe(true);
        expect(other.allInvoiceIds.has(row.invoiceId)).toBe(false);
      }
    });
  }
});

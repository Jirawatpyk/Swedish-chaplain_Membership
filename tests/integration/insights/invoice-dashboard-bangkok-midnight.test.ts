/**
 * 124 slice 2 — a waived refund nets Collected on its BANGKOK `completed_at`
 * date (spec D-d). Two waived (§105) refunds on either side of Bangkok
 * midnight between 31 May and 1 June:
 *   - 2026-05-31T16:59:59Z = 23:59:59 on 31 May in Bangkok → May;
 *   - 2026-05-31T17:00:00Z = 00:00:00 on 1 June in Bangkok → June.
 * Both the this-month tile (an instant range) and the trend month (a date
 * bucket) must put each refund in the same month. The invoices' tax points
 * are in April, so the refunds are the only May / June terms.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fiscalYearDateRange,
  loadInvoiceDashboardTiles,
  loadInvoiceDashboardTrend,
  makeLoadInvoiceDashboardDeps,
  type InvoiceDashboardLoadInput,
} from '@/modules/insights';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedMiniScenario } from './invoice-dashboard-mini-seed';

function input(today: string): InvoiceDashboardLoadInput {
  return {
    filters: { type: 'all', fiscalYear: 2026, planId: null, origin: 'all' },
    today,
    now: new Date(`${today}T05:00:00Z`),
    fiscalYearRange: fiscalYearDateRange(2026, 1),
    canWrite: true,
  };
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`loader failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('a waived refund nets in its Bangkok month, at the midnight edge', () => {
  let user: TestUser;
  let tenant: TestTenant;
  const deps = makeLoadInvoiceDashboardDeps();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    const one = (key: string) => ({
      invoice: { key: `inv${key}`, total: 500_000, method: 'other', paymentDate: '2026-04-10' },
      payment: {
        key: `pay${key}`,
        invoiceKey: `inv${key}`,
        method: 'card' as const,
        amount: 500_000,
        completedAt: '2026-04-10T03:00:00Z',
      },
    });
    const pair = ['May', 'June'].map(one);
    await seedMiniScenario(tenant, user, {
      invoices: pair.map((x) => x.invoice),
      payments: pair.map((x) => x.payment),
      refunds: [
        {
          paymentKey: 'payMay', invoiceKey: 'invMay', status: 'succeeded', amount: 10_000,
          initiatedAt: new Date('2026-05-31T10:00:00Z'), completedAt: new Date('2026-05-31T16:59:59Z'),
        },
        {
          paymentKey: 'payJune', invoiceKey: 'invJune', status: 'succeeded', amount: 20_000,
          initiatedAt: new Date('2026-05-31T10:00:00Z'), completedAt: new Date('2026-05-31T17:00:00Z'),
        },
      ],
    });
  });

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
    await deleteTestUser(user).catch((e) => console.error('user cleanup:', e));
  });

  it('Collected for May (today 31 May) nets only the 23:59:59 refund, tile and trend month', async () => {
    const tiles = unwrap(await loadInvoiceDashboardTiles(tenant.ctx, input('2026-05-31'), deps));
    expect(tiles.collectedThisMonth.range).toEqual({ from: '2026-05-01', to: '2026-05-31' });
    expect(tiles.collectedThisMonth.amountSatang).toBe(-10_000n);
    const trend = unwrap(await loadInvoiceDashboardTrend(tenant.ctx, input('2026-05-31'), deps));
    expect(trend.slots.find((s) => s.monthKey === '2026-05')?.collectedSatang).toBe(-10_000n);
  });

  it('Collected for June (today 15 June) nets only the 00:00 refund, tile and trend month', async () => {
    const tiles = unwrap(await loadInvoiceDashboardTiles(tenant.ctx, input('2026-06-15'), deps));
    expect(tiles.collectedThisMonth.range).toEqual({ from: '2026-06-01', to: '2026-06-15' });
    expect(tiles.collectedThisMonth.amountSatang).toBe(-20_000n);
    const trend = unwrap(await loadInvoiceDashboardTrend(tenant.ctx, input('2026-06-15'), deps));
    expect(trend.slots.find((s) => s.monthKey === '2026-05')?.collectedSatang).toBe(-10_000n);
    expect(trend.slots.find((s) => s.monthKey === '2026-06')?.collectedSatang).toBe(-20_000n);
  });
});

/**
 * 124 slice 2 — the trend's Collected reads the same range as Collected in
 * FY: the selected FY clamped to `today`. A paid invoice whose tax point is
 * later this month (after `today`) is outside the tile, so it must not
 * appear in the current month's slot either; Σ slots = the tile. Billed
 * keeps the whole FY by issue date (future months are already empty).
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

const INPUT: InvoiceDashboardLoadInput = {
  filters: { type: 'all', fiscalYear: 2026, planId: null, origin: 'all' },
  today: '2026-06-15',
  now: new Date('2026-06-15T05:00:00Z'),
  fiscalYearRange: fiscalYearDateRange(2026, 1),
  canWrite: true,
};

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`loader failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('trend Collected over the FY clamped to today', () => {
  let user: TestUser;
  let tenant: TestTenant;
  const deps = makeLoadInvoiceDashboardDeps();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    await seedMiniScenario(tenant, user, {
      invoices: [
        { key: 'before', total: 107_000, method: 'bank_transfer', paymentDate: '2026-06-10' },
        // Tax point after today, still in the current month.
        { key: 'after', total: 214_000, method: 'bank_transfer', paymentDate: '2026-06-20' },
      ],
    });
  });

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
    await deleteTestUser(user).catch((e) => console.error('user cleanup:', e));
  });

  it('Σ trend Collected over all slots equals Collected in FY', async () => {
    const tiles = unwrap(await loadInvoiceDashboardTiles(tenant.ctx, INPUT, deps));
    const trend = unwrap(await loadInvoiceDashboardTrend(tenant.ctx, INPUT, deps));
    expect(tiles.collectedInFiscalYear.amountSatang).toBe(107_000n);
    const sum = trend.slots.reduce((s, m) => s + (m.collectedSatang ?? 0n), 0n);
    expect(sum).toBe(tiles.collectedInFiscalYear.amountSatang);
  });
});

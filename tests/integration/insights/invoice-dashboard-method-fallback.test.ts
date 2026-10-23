/**
 * 124 slice 2 — "Collected by payment method" when no `payments` row stands
 * for the invoice: the method is `invoices.payment_method`, and a stored
 * `'card'` or `'promptpay'` (the dev branch holds `'card'` rows) lands on the
 * card / PromptPay row, never "other". A characterisation test: the
 * adapter's `COALESCE(latest payment method, invoices.payment_method)` and
 * the loader's normalisation already behave so.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fiscalYearDateRange,
  loadInvoiceDashboardMethods,
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

describe('Collected by payment method — invoices.payment_method fallback', () => {
  let user: TestUser;
  let tenant: TestTenant;
  const deps = makeLoadInvoiceDashboardDeps();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    await seedMiniScenario(tenant, user, {
      invoices: [
        { key: 'card', total: 107_000, method: 'card', paymentDate: '2026-05-04' },
        { key: 'promptpay', total: 214_000, method: 'promptpay', paymentDate: '2026-05-05' },
        { key: 'other', total: 321_000, method: 'other', paymentDate: '2026-05-06' },
      ],
    });
  });

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
    await deleteTestUser(user).catch((e) => console.error('user cleanup:', e));
  });

  it("a stored 'card' or 'promptpay' with no payments row is card / PromptPay, not other", async () => {
    const result = await loadInvoiceDashboardMethods(tenant.ctx, INPUT, deps);
    if (!result.ok) throw new Error(`loader failed: ${JSON.stringify(result.error)}`);
    expect(Object.fromEntries(result.value.rows.map((r) => [r.method, r.amountSatang]))).toEqual({
      bank_transfer: 0n,
      promptpay: 214_000n,
      card: 107_000n,
      cheque: 0n,
      cash: 0n,
      other: 321_000n,
    });
  });
});

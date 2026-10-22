/**
 * 124 slice 2 — Needs attention edge cases (spec US1, D-k):
 *   - Receipt PDF failed counts `status = 'paid'` only: the receipt worker
 *     (`render-receipt-pdf.ts`) re-renders nothing else, so a credited
 *     invoice's stale failure would sit in the card forever.
 *
 * One disposable tenant; every invoice is `gold`, `manual`, membership.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fiscalYearDateRange,
  loadInvoiceDashboardAttention,
  makeLoadInvoiceDashboardDeps,
  type InvoiceDashboardLoadInput,
} from '@/modules/insights';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedMiniScenario } from './invoice-dashboard-mini-seed';

const NOW = new Date('2026-06-15T05:00:00Z');

const INPUT: InvoiceDashboardLoadInput = {
  filters: { type: 'all', fiscalYear: 2026, planId: null, origin: 'all' },
  today: '2026-06-15',
  now: NOW,
  fiscalYearRange: fiscalYearDateRange(2026, 1),
  canWrite: true,
};

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`loader failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('Needs attention — edge cases', () => {
  let user: TestUser;
  let tenant: TestTenant;
  const deps = makeLoadInvoiceDashboardDeps();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    await seedMiniScenario(tenant, user, {
      invoices: [
        // Counted: a paid invoice whose receipt failed to render.
        { key: 'paidFailed', total: 100_000, method: 'bank_transfer', paymentDate: '2026-06-01', receiptPdfStatus: 'failed' },
        // Not counted: the worker refuses anything but `paid`.
        {
          key: 'partFailed', total: 100_000, method: 'bank_transfer', paymentDate: '2026-06-01',
          status: 'partially_credited', credited: 10_000, receiptPdfStatus: 'failed',
        },
        {
          key: 'credFailed', total: 100_000, method: 'bank_transfer', paymentDate: '2026-06-01',
          status: 'credited', credited: 100_000, receiptPdfStatus: 'failed',
        },
      ],
    });
  });

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
    await deleteTestUser(user).catch((e) => console.error('user cleanup:', e));
  });

  it('Receipt PDF failed counts a paid invoice only, never a partially credited or credited one', async () => {
    const attention = unwrap(await loadInvoiceDashboardAttention(tenant.ctx, INPUT, deps));
    expect(attention.receiptPdfFailed).toBe(1);
  });
});

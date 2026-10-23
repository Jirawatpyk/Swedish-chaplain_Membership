/**
 * 124 slice 3 — the "No invoices yet" signal (US5.2): the tiles loader's
 * `anyNonDraftInvoice` is true once the tenant has issued anything (a voided
 * bill was issued, so it counts) and false while it holds only drafts. It
 * ignores the filters and is tenant-scoped: another tenant's invoices never
 * turn it on (Principle I).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fiscalYearDateRange,
  loadInvoiceDashboardTiles,
  makeLoadInvoiceDashboardDeps,
  type InvoiceDashboardLoadInput,
} from '@/modules/insights';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedMiniScenario } from './invoice-dashboard-mini-seed';

const INPUT: InvoiceDashboardLoadInput = {
  // A filter that matches nothing: the signal must not follow it.
  filters: { type: 'event', fiscalYear: 2026, planId: null, origin: 'all' },
  today: '2026-06-15',
  now: new Date('2026-06-15T05:00:00Z'),
  fiscalYearRange: fiscalYearDateRange(2026, 1),
  canWrite: true,
};

describe('invoice dashboard — any non-draft invoice (US5.2)', () => {
  let user: TestUser;
  let draftsOnly: TestTenant;
  let voidOnly: TestTenant;
  let paid: TestTenant;
  const deps = makeLoadInvoiceDashboardDeps();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    draftsOnly = await createTestTenant();
    voidOnly = await createTestTenant();
    paid = await createTestTenant();
    await seedMiniScenario(draftsOnly, user, { invoices: [], drafts: [{ key: 'd1' }, { key: 'd2' }] });
    await seedMiniScenario(voidOnly, user, { invoices: [], voids: [{ key: 'v1', total: 107_000, issueDate: '2026-05-04' }] });
    await seedMiniScenario(paid, user, {
      invoices: [{ key: 'p1', total: 214_000, method: 'bank_transfer', paymentDate: '2026-05-05' }],
    });
  });

  afterAll(async () => {
    for (const t of [draftsOnly, voidOnly, paid]) {
      await t?.cleanup().catch((e) => console.error('tenant cleanup:', e));
    }
    await deleteTestUser(user).catch((e) => console.error('user cleanup:', e));
  });

  async function anyInvoice(tenant: TestTenant): Promise<boolean> {
    const result = await loadInvoiceDashboardTiles(tenant.ctx, INPUT, deps);
    if (!result.ok) throw new Error(`loader failed: ${JSON.stringify(result.error)}`);
    return result.value.anyNonDraftInvoice;
  }

  it('a tenant with only drafts has none, though other tenants have invoices', async () => {
    expect(await anyInvoice(draftsOnly)).toBe(false);
  });

  it('a voided bill was issued, so it counts', async () => {
    expect(await anyInvoice(voidOnly)).toBe(true);
  });

  it('a paid invoice counts, whatever the filters say', async () => {
    expect(await anyInvoice(paid)).toBe(true);
  });
});

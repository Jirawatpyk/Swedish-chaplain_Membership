/**
 * 124 slice 2 — Needs attention row 5 (spec D-k): refunds `pending` for longer
 * than the stale-refund sweep's escalation age (3 days, measured on
 * `refunds.initiated_at`, strictly older — the sweep escalates only when
 * `age > ESCALATION_AGE_MS`). `now` is the caller's instant, never the
 * database's clock.
 *
 * Two disposable tenants: A holds one refund of each shape; B holds two
 * refunds pending 4 days, so a leak in either direction moves a count.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fiscalYearDateRange,
  loadInvoiceDashboardAttention,
  makeLoadInvoiceDashboardDeps,
  type InvoiceDashboardFilters,
  type InvoiceDashboardLoadInput,
} from '@/modules/insights';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedMiniScenario } from './invoice-dashboard-mini-seed';

const NOW = new Date('2026-06-15T05:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

function input(filters: Partial<InvoiceDashboardFilters> = {}): InvoiceDashboardLoadInput {
  return {
    filters: { type: 'all', fiscalYear: 2026, planId: null, origin: 'all', ...filters },
    today: '2026-06-15',
    now: NOW,
    fiscalYearRange: fiscalYearDateRange(2026, 1),
    canWrite: true,
  };
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`loader failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('Needs attention — refunds pending longer than the sweep escalation age (D-k)', () => {
  let user: TestUser;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  const deps = makeLoadInvoiceDashboardDeps();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant();
    tenantB = await createTestTenant();
    // One invoice per refund: a payment is the one active row of its invoice.
    const one = (key: string) => ({
      invoice: { key: `inv${key}`, total: 500_000, method: 'other', paymentDate: '2026-06-01' },
      payment: {
        key: `pay${key}`,
        invoiceKey: `inv${key}`,
        method: 'card' as const,
        amount: 500_000,
        completedAt: '2026-06-01T03:00:00Z',
      },
    });
    const a = ['4d', '1d', '3d', 'Ok'].map(one);
    await seedMiniScenario(tenantA, user, {
      invoices: a.map((x) => x.invoice),
      payments: a.map((x) => x.payment),
      refunds: [
        // Pending 4 days → counted.
        { paymentKey: 'pay4d', invoiceKey: 'inv4d', status: 'pending', amount: 10_000, initiatedAt: ago(4 * DAY_MS) },
        // Pending 1 day → not yet.
        { paymentKey: 'pay1d', invoiceKey: 'inv1d', status: 'pending', amount: 10_000, initiatedAt: ago(DAY_MS) },
        // Exactly 3 days → not counted (the sweep escalates only when strictly older).
        { paymentKey: 'pay3d', invoiceKey: 'inv3d', status: 'pending', amount: 10_000, initiatedAt: ago(3 * DAY_MS) },
        // Succeeded, initiated 10 days ago → never counted.
        { paymentKey: 'payOk', invoiceKey: 'invOk', status: 'succeeded', amount: 10_000, initiatedAt: ago(10 * DAY_MS) },
      ],
    });
    const b = ['A', 'B'].map(one);
    await seedMiniScenario(tenantB, user, {
      invoices: b.map((x) => x.invoice),
      payments: b.map((x) => x.payment),
      refunds: [
        { paymentKey: 'payA', invoiceKey: 'invA', status: 'pending', amount: 10_000, initiatedAt: ago(4 * DAY_MS) },
        { paymentKey: 'payB', invoiceKey: 'invB', status: 'pending', amount: 10_000, initiatedAt: ago(5 * DAY_MS) },
      ],
    });
  });

  afterAll(async () => {
    await tenantA.cleanup().catch((e) => console.error('tenant A cleanup:', e));
    await tenantB.cleanup().catch((e) => console.error('tenant B cleanup:', e));
    await deleteTestUser(user).catch((e) => console.error('user cleanup:', e));
  });

  it('counts a refund pending 4 days; not one pending 1 day, exactly 3 days, or succeeded', async () => {
    const attention = unwrap(await loadInvoiceDashboardAttention(tenantA.ctx, input(), deps));
    expect(attention.refundsPendingOverThreshold).toBe(1);
  });

  it('applies the filters through the refund invoice', async () => {
    const silver = unwrap(
      await loadInvoiceDashboardAttention(tenantA.ctx, input({ type: 'membership', planId: 'silver' }), deps),
    );
    expect(silver.refundsPendingOverThreshold).toBe(0);
    const event = unwrap(await loadInvoiceDashboardAttention(tenantA.ctx, input({ type: 'event' }), deps));
    expect(event.refundsPendingOverThreshold).toBe(0);
    const autoRenewal = unwrap(
      await loadInvoiceDashboardAttention(tenantA.ctx, input({ origin: 'auto_renewal' }), deps),
    );
    expect(autoRenewal.refundsPendingOverThreshold).toBe(0);
    const gold = unwrap(
      await loadInvoiceDashboardAttention(tenantA.ctx, input({ type: 'membership', planId: 'gold' }), deps),
    );
    expect(gold.refundsPendingOverThreshold).toBe(1);
  });

  it('ages against the caller now: the 1-day refund counts once now is 3 days later', async () => {
    const later = { ...input(), now: new Date(NOW.getTime() + 3 * DAY_MS) };
    const attention = unwrap(await loadInvoiceDashboardAttention(tenantA.ctx, later, deps));
    // 4d → 7d, 1d → 4d, 3d → 6d: three pending refunds now past the age.
    expect(attention.refundsPendingOverThreshold).toBe(3);
  });

  it('tenant isolation: each tenant counts only its own refunds', async () => {
    const a = unwrap(await loadInvoiceDashboardAttention(tenantA.ctx, input(), deps));
    const b = unwrap(await loadInvoiceDashboardAttention(tenantB.ctx, input(), deps));
    expect(a.refundsPendingOverThreshold).toBe(1);
    expect(b.refundsPendingOverThreshold).toBe(2);
  });
});

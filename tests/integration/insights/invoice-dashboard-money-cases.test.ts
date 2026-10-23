/**
 * 124 slice 2 — money edge cases of the invoice dashboard (spec 124 § Figure
 * definitions, D-k), on live Neon with one disposable tenant. Every figure
 * below is hand-computed from the rows; none is derived from the code.
 *
 * Fixed today = 2026-06-15 (Bangkok). Rows (satang):
 *   cred  credited invoice, paid 2026-03-10, 107,000; credit note 2026-03-20 for all of it.
 *   prior partially credited invoice paid 2025-12-10, 200,000; credit note 2026-02-05, 50,000.
 *   jan   paid 2026-01-15, 40,000.
 *   two   paid 2026-04-03, 300,000, stored method 'other'; payments: an older PromptPay
 *         (refunded, 04-01) and the latest card (succeeded, 04-03); a waived §105 refund of
 *         30,000 through the OLDER PromptPay payment, completed 2026-04-10.
 *   rt1–rt4  paid 2024-08-01 (outside every range read here): refund-attempt orderings.
 *   vv    a void invoice whose refunded card payment has a refund pending 5 days.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  fiscalYearDateRange,
  loadInvoiceDashboardAttention,
  loadInvoiceDashboardMethods,
  loadInvoiceDashboardTiles,
  loadInvoiceDashboardTrend,
  makeLoadInvoiceDashboardDeps,
  type InvoiceDashboardLoadInput,
} from '@/modules/insights';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedMiniScenario, type MiniPayment, type MiniRefund } from './invoice-dashboard-mini-seed';

const NOW = new Date('2026-06-15T05:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function input(fiscalYear: number, startMonth: 1 | 4): InvoiceDashboardLoadInput {
  return {
    filters: { type: 'all', fiscalYear, planId: null, origin: 'all' },
    today: '2026-06-15',
    now: NOW,
    fiscalYearRange: fiscalYearDateRange(fiscalYear, startMonth),
    canWrite: true,
  };
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`loader failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('invoice dashboard — money edge cases', () => {
  let user: TestUser;
  let tenant: TestTenant;
  const deps = makeLoadInvoiceDashboardDeps();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    const u = randomUUID().replace(/-/g, '').slice(0, 12);
    const T = new Date('2024-08-02T03:00:00Z');
    const C = new Date('2024-08-02T03:00:05Z');
    const later = (d: Date, ms: number) => new Date(d.getTime() + ms);
    const attempt = (n: number): { invoice: { key: string; total: number; method: string; paymentDate: string }; payment: MiniPayment } => ({
      invoice: { key: `rt${n}`, total: 100_000, method: 'other', paymentDate: '2024-08-01' },
      payment: { key: `payRt${n}`, invoiceKey: `rt${n}`, method: 'card', amount: 100_000, completedAt: '2024-08-01T03:00:00Z' },
    });
    const attempts = [1, 2, 3, 4].map(attempt);
    const failed = (n: number, o: Partial<MiniRefund> = {}): MiniRefund => ({
      paymentKey: `payRt${n}`, invoiceKey: `rt${n}`, status: 'failed', amount: 10_000, initiatedAt: T, ...o,
    });
    const waived = (n: number, o: Partial<MiniRefund> = {}): MiniRefund => ({
      paymentKey: `payRt${n}`, invoiceKey: `rt${n}`, status: 'succeeded', amount: 10_000, initiatedAt: T, ...o,
    });

    await seedMiniScenario(tenant, user, {
      invoices: [
        { key: 'cred', total: 107_000, method: 'bank_transfer', paymentDate: '2026-03-10', status: 'credited', credited: 107_000 },
        { key: 'prior', total: 200_000, method: 'bank_transfer', paymentDate: '2025-12-10', status: 'partially_credited', credited: 50_000 },
        { key: 'jan', total: 40_000, method: 'bank_transfer', paymentDate: '2026-01-15' },
        { key: 'two', total: 300_000, method: 'other', paymentDate: '2026-04-03' },
        ...attempts.map((a) => a.invoice),
      ],
      voids: [{ key: 'vv', total: 70_000, issueDate: '2026-05-01' }],
      creditNotes: [
        { key: 'cnCred', invoiceKey: 'cred', issueDate: '2026-03-20', total: 107_000 },
        { key: 'cnPrior', invoiceKey: 'prior', issueDate: '2026-02-05', total: 50_000 },
      ],
      payments: [
        { key: 'payOld', invoiceKey: 'two', method: 'promptpay', status: 'refunded', amount: 300_000, completedAt: '2026-04-01T03:00:00Z' },
        { key: 'payNew', invoiceKey: 'two', method: 'card', amount: 300_000, completedAt: '2026-04-03T03:00:00Z' },
        { key: 'payV', invoiceKey: 'vv', method: 'card', status: 'refunded', amount: 70_000, completedAt: '2026-05-01T03:00:00Z' },
        ...attempts.map((a) => a.payment),
      ],
      refunds: [
        // Waived through the OLDER (non-latest) payment: lands on PromptPay.
        { paymentKey: 'payOld', invoiceKey: 'two', status: 'succeeded', amount: 30_000, initiatedAt: new Date('2026-04-10T02:00:00Z') },
        // rt1: same initiated_at; the failure was created later → it is the latest → counts.
        waived(1, { createdAt: C }),
        failed(1, { createdAt: later(C, 60_000) }),
        // rt2: same initiated_at; the success was created later → not counted.
        failed(2, { createdAt: C }),
        waived(2, { createdAt: later(C, 60_000) }),
        // rt3: succeeded first, failed at Stripe a day later → still counts.
        waived(3, { createdAt: C }),
        failed(3, { initiatedAt: later(T, DAY_MS), createdAt: later(C, DAY_MS) }),
        // rt4: same initiated_at and created_at; the id decides (the success's id is greater) → not counted.
        failed(4, { createdAt: C, id: `rf_${u}_a` }),
        waived(4, { createdAt: C, id: `rf_${u}_b` }),
        // A refund pending 5 days on a VOID invoice still needs a look (row 5, D-k).
        { paymentKey: 'payV', invoiceKey: 'vv', status: 'pending', amount: 70_000, initiatedAt: new Date(NOW.getTime() - 5 * DAY_MS) },
      ],
    });
  });

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
    await deleteTestUser(user).catch((e) => console.error('user cleanup:', e));
  });

  it('a fully credited invoice nets to 0 in Collected and Billed; a credit note on a prior-FY invoice makes its month negative', async () => {
    const i = input(2026, 1);
    const tiles = unwrap(await loadInvoiceDashboardTiles(tenant.ctx, i, deps));
    // cred 107,000 − 107,000; jan 40,000; two 300,000 − 30,000; prior's credit note − 50,000.
    expect(tiles.collectedInFiscalYear).toMatchObject({ amountSatang: 260_000n, invoiceCount: 3 });
    const trend = unwrap(await loadInvoiceDashboardTrend(tenant.ctx, i, deps));
    const month = (key: string) => trend.slots.find((s) => s.monthKey === key);
    expect(month('2026-01')).toMatchObject({ billedSatang: 40_000n, collectedSatang: 40_000n });
    // Only prior's credit note: prior itself was issued and paid in 2025.
    expect(month('2026-02')).toMatchObject({ billedSatang: -50_000n, collectedSatang: -50_000n });
    // cred and its full credit note, same month.
    expect(month('2026-03')).toMatchObject({ billedSatang: 0n, collectedSatang: 0n });
    expect(month('2026-04')).toMatchObject({ billedSatang: 300_000n, collectedSatang: 270_000n });
    const sum = trend.slots.reduce((s, m) => s + (m.collectedSatang ?? 0n), 0n);
    expect(sum).toBe(tiles.collectedInFiscalYear.amountSatang);
  });

  it('a waived refund through an older, non-latest payment lands on that payment method; rows add up to the tile', async () => {
    const i = input(2026, 1);
    const tiles = unwrap(await loadInvoiceDashboardTiles(tenant.ctx, i, deps));
    const methods = unwrap(await loadInvoiceDashboardMethods(tenant.ctx, i, deps));
    expect(Object.fromEntries(methods.rows.map((r) => [r.method, r.amountSatang]))).toEqual({
      // jan 40,000 − prior's credit note 50,000; cred nets to 0.
      bank_transfer: -10_000n,
      // The waiver returned money through the older PromptPay payment.
      promptpay: -30_000n,
      // two's latest payment.
      card: 300_000n,
      cheque: 0n,
      cash: 0n,
      other: 0n,
    });
    expect(methods.totalSatang).toBe(tiles.collectedInFiscalYear.amountSatang);
  });

  it('a fiscal year starting in April maps months across the calendar year', async () => {
    // FY 2025 = 2025-04-01 … 2026-03-31, wholly past on 2026-06-15.
    const i = input(2025, 4);
    const trend = unwrap(await loadInvoiceDashboardTrend(tenant.ctx, i, deps));
    expect(trend.range).toEqual({ from: '2025-04-01', to: '2026-03-31' });
    expect(trend.collectedRange).toEqual({ from: '2025-04-01', to: '2026-03-31' });
    expect(trend.toDate).toBe(false);
    expect(trend.slots.map((s) => s.monthKey)).toEqual([
      '2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09',
      '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03',
    ]);
    expect(trend.slots.every((s) => s.state === 'past')).toBe(true);
    expect(trend.slots[8]).toMatchObject({ monthKey: '2025-12', billedSatang: 200_000n, collectedSatang: 200_000n });
    expect(trend.slots[9]).toMatchObject({ monthKey: '2026-01', billedSatang: 40_000n, collectedSatang: 40_000n });
    expect(trend.slots[10]).toMatchObject({ monthKey: '2026-02', billedSatang: -50_000n, collectedSatang: -50_000n });
    expect(trend.slots[11]).toMatchObject({ monthKey: '2026-03', billedSatang: 0n, collectedSatang: 0n });
    const tiles = unwrap(await loadInvoiceDashboardTiles(tenant.ctx, i, deps));
    // prior 200,000 + jan 40,000 + cred 0 − prior's credit note 50,000.
    expect(tiles.collectedInFiscalYear).toMatchObject({ amountSatang: 190_000n, toDate: false });
  });

  it('refunds failed at Stripe: ties on initiated_at resolve by created_at, then id; succeeded-then-failed counts', async () => {
    const attention = unwrap(await loadInvoiceDashboardAttention(tenant.ctx, input(2026, 1), deps));
    // rt1 (failure created later) and rt3 (failure a day after the success).
    expect(attention.refundsFailedAtStripe).toBe(2);
  });

  it('a refund pending past 3 days on a void invoice counts in row 5', async () => {
    const attention = unwrap(await loadInvoiceDashboardAttention(tenant.ctx, input(2026, 1), deps));
    expect(attention.refundsPendingOverThreshold).toBe(1);
  });
});

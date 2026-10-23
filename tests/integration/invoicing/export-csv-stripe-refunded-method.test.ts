/**
 * Spec 124 follow-up — the CSV export's Payment Method for a Stripe invoice
 * whose payment was later refunded. The export looked methods up through
 * `listSucceededPaymentMethods` (succeeded only), so a card or PromptPay
 * payment that became `refunded` / `partially_refunded` dropped out and the
 * row fell back to `manual`. Decision (maintainer, 23 Oct): only Stripe rows
 * change — every invoice with no Stripe payment keeps `manual`.
 *
 * Runs the real `makeExportPaidInvoicesCsvDeps` wiring; the older export
 * suites stub the lookup, which is why this was never caught.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { exportPaidInvoicesCsv, makeExportPaidInvoicesCsvDeps } from '@/modules/invoicing';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedMiniScenario } from '../insights/invoice-dashboard-mini-seed';

const HEADER_NAME = 'Customer Legal Name';
const HEADER_METHOD = 'Payment Method';

describe('CSV export — Payment Method of a refunded Stripe invoice', () => {
  let user: TestUser;
  let tenant: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    other = await createTestTenant();
    // Stored `payment_method` is what a Stripe settlement writes ('other');
    // the CSV must name the processor method instead.
    await seedMiniScenario(tenant, user, {
      invoices: [
        { key: 'cardRefunded', total: 107_000, method: 'other', paymentDate: '2026-05-04' },
        { key: 'ppPartial', total: 214_000, method: 'other', paymentDate: '2026-05-05' },
        { key: 'cardPaid', total: 321_000, method: 'other', paymentDate: '2026-05-06' },
        { key: 'transfer', total: 428_000, method: 'bank_transfer', paymentDate: '2026-05-07' },
        { key: 'retried', total: 535_000, method: 'other', paymentDate: '2026-05-08' },
        { key: 'cashAfterAttempts', total: 642_000, method: 'cash', paymentDate: '2026-05-09' },
        { key: 'tie', total: 749_000, method: 'other', paymentDate: '2026-05-10' },
      ],
      payments: [
        { key: 'p1', invoiceKey: 'cardRefunded', method: 'card', amount: 107_000, completedAt: '2026-05-04T05:00:00Z', status: 'refunded' },
        { key: 'p2', invoiceKey: 'ppPartial', method: 'promptpay', amount: 214_000, completedAt: '2026-05-05T05:00:00Z', status: 'partially_refunded' },
        { key: 'p3', invoiceKey: 'cardPaid', method: 'card', amount: 321_000, completedAt: '2026-05-06T05:00:00Z' },
        // Paid by card, refunded, then paid again by PromptPay: the latest wins.
        { key: 'p4', invoiceKey: 'retried', method: 'card', amount: 535_000, completedAt: '2026-05-08T01:00:00Z', status: 'refunded' },
        { key: 'p5', invoiceKey: 'retried', method: 'promptpay', amount: 535_000, completedAt: '2026-05-08T05:00:00Z' },
        // Settled in cash after Stripe attempts that never collected it: none
        // of these may lend a method (financial-integrity review M-1).
        { key: 'a1', invoiceKey: 'cashAfterAttempts', method: 'card', amount: 642_000, completedAt: '2026-05-09T01:00:00Z', status: 'failed' },
        { key: 'a2', invoiceKey: 'cashAfterAttempts', method: 'card', amount: 642_000, completedAt: '2026-05-09T02:00:00Z', status: 'canceled' },
        { key: 'a3', invoiceKey: 'cashAfterAttempts', method: 'promptpay', amount: 642_000, completedAt: '2026-05-09T03:00:00Z', status: 'pending' },
        { key: 'a4', invoiceKey: 'cashAfterAttempts', method: 'promptpay', amount: 642_000, completedAt: '2026-05-09T04:00:00Z', status: 'auto_refunded' },
        // Same completed_at: the higher id wins (`id DESC`). Ids carry a random
        // suffix so reruns never collide; the prefixes fix the order.
        { key: 't1', id: `pay_tie_a_${randomUUID()}`, invoiceKey: 'tie', method: 'card', amount: 749_000, completedAt: '2026-05-10T05:00:00Z', status: 'refunded' },
        { key: 't2', id: `pay_tie_b_${randomUUID()}`, invoiceKey: 'tie', method: 'promptpay', amount: 749_000, completedAt: '2026-05-10T05:00:00Z' },
      ],
    });
    // Another tenant's PromptPay payment never lends its method.
    await seedMiniScenario(other, user, {
      invoices: [{ key: 'otherTenant', total: 107_000, method: 'other', paymentDate: '2026-05-04' }],
      payments: [
        { key: 'q1', invoiceKey: 'otherTenant', method: 'promptpay', amount: 107_000, completedAt: '2026-05-04T05:00:00Z' },
      ],
    });
  });

  afterAll(async () => {
    for (const t of [tenant, other]) await t?.cleanup().catch((e) => console.error('tenant cleanup:', e));
    await deleteTestUser(user).catch((e) => console.error('user cleanup:', e));
  });

  async function methodsByBuyer(t: TestTenant): Promise<Record<string, string>> {
    const result = await exportPaidInvoicesCsv(makeExportPaidInvoicesCsvDeps(t.ctx.slug), {
      tenantId: t.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-csv-method-${randomUUID()}`,
      from: '2026-05-01',
      to: '2026-05-31',
    });
    if (!result.ok) throw new Error(`export failed: ${result.error.code}`);
    const [header, ...rows] = result.value.csv.trim().split(/\r?\n/).map((line) => line.split(','));
    const name = header!.indexOf(HEADER_NAME);
    const method = header!.indexOf(HEADER_METHOD);
    return Object.fromEntries(rows.map((r) => [r[name]!.replace(/"/g, ''), r[method]!.replace(/"/g, '')]));
  }

  it('a refunded card or partially refunded PromptPay payment keeps its method; no Stripe payment stays manual', async () => {
    expect(await methodsByBuyer(tenant)).toEqual({
      'Buyer cardRefunded': 'card',
      'Buyer ppPartial': 'promptpay',
      'Buyer cardPaid': 'card',
      'Buyer transfer': 'manual',
      'Buyer retried': 'promptpay',
      'Buyer cashAfterAttempts': 'manual',
      'Buyer tie': 'promptpay',
    });
  });

  it('is tenant-scoped', async () => {
    expect(await methodsByBuyer(other)).toEqual({ 'Buyer otherTenant': 'promptpay' });
  });
});

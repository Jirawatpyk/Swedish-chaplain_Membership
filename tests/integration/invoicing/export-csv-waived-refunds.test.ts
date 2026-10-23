/**
 * Spec 124 follow-up (D-p) — a refund settled with NO §86/10 credit note (the
 * §105 waiver: `refunds.credit_note_waived_at` set) leaves the receipt `paid`
 * at full value, so the CSV used to overstate the money kept by the refunded
 * amount with no trace of the refund. Each such refund is now a NEGATIVE row
 * in the month the refund completed (Bangkok date), like a credit-note row:
 * Status `Refund (no credit note)`, Total −amount, no VAT and no tax point
 * (a refund has none under §78/1 — thai-tax-compliance-auditor), the original
 * receipt in Reference Document No., the refunded payment's method.
 *
 * Runs the real `makeExportPaidInvoicesCsvDeps` wiring.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { exportPaidInvoicesCsv, makeExportPaidInvoicesCsvDeps } from '@/modules/invoicing';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedMiniScenario } from '../insights/invoice-dashboard-mini-seed';
import { invoiceDashboardSourceAdapter } from '@/modules/insights/infrastructure/sources/invoice-dashboard-source-adapter';

const REFUND_STATUS = 'Refund (no credit note)';

type Row = Record<string, string>;

describe('CSV export — refunds with no credit note', () => {
  let user: TestUser;
  let tenant: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    other = await createTestTenant();
    await seedMiniScenario(tenant, user, {
      invoices: [
        // RE-2026-000001 … in this order.
        { key: 'reMay', total: 535_000, method: 'other', paymentDate: '2026-05-04' },
        { key: 'pend', total: 214_000, method: 'other', paymentDate: '2026-05-05' },
        { key: 'cnInv', total: 321_000, method: 'other', paymentDate: '2026-05-06', status: 'partially_credited', credited: 107_000 },
        { key: 'edgeIn', total: 107_000, method: 'other', paymentDate: '2026-05-07' },
        { key: 'edgeOut', total: 107_000, method: 'other', paymentDate: '2026-05-08' },
      ],
      voids: [{ key: 'voided', total: 107_000, issueDate: '2026-05-09' }],
      creditNotes: [{ key: 'cn1', invoiceKey: 'cnInv', issueDate: '2026-06-12', total: 107_000 }],
      payments: [
        { key: 'p1', invoiceKey: 'reMay', method: 'card', amount: 535_000, completedAt: '2026-05-04T05:00:00Z', status: 'partially_refunded' },
        { key: 'p2', invoiceKey: 'pend', method: 'promptpay', amount: 214_000, completedAt: '2026-05-05T05:00:00Z' },
        { key: 'p3', invoiceKey: 'cnInv', method: 'card', amount: 321_000, completedAt: '2026-05-06T05:00:00Z', status: 'partially_refunded' },
        { key: 'p4', invoiceKey: 'edgeIn', method: 'promptpay', amount: 107_000, completedAt: '2026-05-07T05:00:00Z', status: 'refunded' },
        { key: 'p5', invoiceKey: 'edgeOut', method: 'card', amount: 107_000, completedAt: '2026-05-08T05:00:00Z', status: 'refunded' },
        { key: 'p6', invoiceKey: 'voided', method: 'card', amount: 107_000, completedAt: '2026-05-09T05:00:00Z', status: 'refunded' },
      ],
      refunds: [
        // The waived refund: completed 10 June, Bangkok noon.
        { paymentKey: 'p1', invoiceKey: 'reMay', status: 'succeeded', amount: 107_000, initiatedAt: new Date('2026-06-10T04:00:00Z'), completedAt: new Date('2026-06-10T05:00:00Z') },
        // Never moved money / not yet: no row.
        { paymentKey: 'p2', invoiceKey: 'pend', status: 'pending', amount: 50_000, initiatedAt: new Date('2026-06-11T04:00:00Z') },
        { paymentKey: 'p2', invoiceKey: 'pend', status: 'failed', amount: 60_000, initiatedAt: new Date('2026-06-11T05:00:00Z') },
        // Settled by a credit note: the credit-note row already carries it.
        { paymentKey: 'p3', invoiceKey: 'cnInv', status: 'succeeded', amount: 107_000, initiatedAt: new Date('2026-06-12T04:00:00Z'), completedAt: new Date('2026-06-12T05:00:00Z'), creditNoteKey: 'cn1' },
        // 30 June 23:59:59 Bangkok → June; 1 July 00:00 Bangkok → July.
        { paymentKey: 'p4', invoiceKey: 'edgeIn', status: 'succeeded', amount: 107_000, initiatedAt: new Date('2026-06-30T10:00:00Z'), completedAt: new Date('2026-06-30T16:59:59Z') },
        { paymentKey: 'p5', invoiceKey: 'edgeOut', status: 'succeeded', amount: 107_000, initiatedAt: new Date('2026-06-30T10:00:00Z'), completedAt: new Date('2026-06-30T17:00:00Z') },
        // A voided invoice's receipt is never in the file, so neither is its refund.
        { paymentKey: 'p6', invoiceKey: 'voided', status: 'succeeded', amount: 107_000, initiatedAt: new Date('2026-06-15T04:00:00Z'), completedAt: new Date('2026-06-15T05:00:00Z') },
      ],
    });
    // Another tenant's waived refund in the same month never appears.
    await seedMiniScenario(other, user, {
      invoices: [{ key: 'otherTenant', total: 107_000, method: 'other', paymentDate: '2026-05-04' }],
      payments: [
        { key: 'q1', invoiceKey: 'otherTenant', method: 'promptpay', amount: 107_000, completedAt: '2026-05-04T05:00:00Z', status: 'refunded' },
      ],
      refunds: [
        { paymentKey: 'q1', invoiceKey: 'otherTenant', status: 'succeeded', amount: 107_000, initiatedAt: new Date('2026-06-10T04:00:00Z'), completedAt: new Date('2026-06-10T05:00:00Z') },
      ],
    });
  });

  afterAll(async () => {
    for (const t of [tenant, other]) await t?.cleanup().catch((e) => console.error('tenant cleanup:', e));
    await deleteTestUser(user).catch((e) => console.error('user cleanup:', e));
  });

  async function rows(from: string, to: string): Promise<Row[]> {
    const result = await exportPaidInvoicesCsv(makeExportPaidInvoicesCsvDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-csv-waived-${randomUUID()}`,
      from,
      to,
    });
    if (!result.ok) throw new Error(`export failed: ${result.error.code}`);
    const [header, ...body] = result.value.csv
      .replace(/^﻿/, '')
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split(','));
    return body.map((cells) => Object.fromEntries(header!.map((h, i) => [h, cells[i] ?? ''])));
  }

  const refundRows = (all: Row[]) => all.filter((r) => r['Status'] === REFUND_STATUS);

  it('puts a waived refund in the month it completed, as a negative row with no VAT', async () => {
    const june = refundRows(await rows('2026-06-01', '2026-06-30'));
    expect(june).toEqual([
      {
        'Issue Date': '2026-06-10',
        'Invoice No.': '',
        'Receipt No.': '',
        'Customer Legal Name': 'Buyer reMay',
        'Customer Tax ID': '1234567890123',
        Subtotal: '',
        'VAT %': '',
        VAT: '',
        Total: '-1070.00',
        Currency: 'THB',
        'Paid At': '',
        'Payment Method': 'card',
        'Tax Point Date': '',
        Status: REFUND_STATUS,
        'Reference Document No.': 'RE-2026-000001',
      },
      expect.objectContaining({
        'Issue Date': '2026-06-30',
        'Customer Legal Name': 'Buyer edgeIn',
        Total: '-1070.00',
        'Payment Method': 'promptpay',
        'Reference Document No.': 'RE-2026-000004',
      }),
    ]);
  });

  it('leaves the receipt month alone and carries a 17:00Z refund into the next month', async () => {
    expect(refundRows(await rows('2026-05-01', '2026-05-31'))).toEqual([]);
    const july = refundRows(await rows('2026-07-01', '2026-07-31'));
    expect(july.map((r) => [r['Issue Date'], r['Customer Legal Name']])).toEqual([
      ['2026-07-01', 'Buyer edgeOut'],
    ]);
  });

  it('each month nets to the dashboard Collected for the same month (no filters)', async () => {
    const satang = (total: string) => BigInt(Math.round(Number(total) * 100));
    for (const [from, to] of [
      ['2026-05-01', '2026-05-31'],
      ['2026-06-01', '2026-06-30'],
      ['2026-07-01', '2026-07-31'],
    ] as const) {
      const fileNet = (await rows(from, to)).reduce((sum, r) => sum + satang(r['Total']!), 0n);
      const collected = await invoiceDashboardSourceAdapter.collectedInRange(
        tenant.ctx,
        { type: 'all', fiscalYear: 2026, planId: null, origin: 'all' },
        { from, to },
      );
      expect({ from, fileNet }).toEqual({ from, fileNet: collected.amountSatang });
    }
  });

  it('a credit-note refund keeps only its credit-note row', async () => {
    const june = await rows('2026-06-01', '2026-06-30');
    expect(june.filter((r) => r['Status'] === 'Credit note')).toHaveLength(1);
    expect(refundRows(june).map((r) => r['Customer Legal Name'])).not.toContain('Buyer cnInv');
  });
});

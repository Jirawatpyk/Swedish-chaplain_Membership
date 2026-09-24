/**
 * Unit tests for `listTaxDocumentRegister` (088 T065b, ภ.พ.30 support).
 *
 * The live-Neon behaviour (bucketing, void listing, §86/10 netting) is pinned by
 * `tests/integration/invoicing/tax-document-register.test.ts`; this file pins
 * the pure use-case logic on top of the repo:
 *   - the summary counts cancelled rows separately (they are listed, never summed)
 *   - the period status says whether the range is a closed calendar month
 *     (only then is the net figure "the figure to report on ภ.พ.30")
 *   - impossible calendar dates are refused as `invalid_range` before any query
 */
import { describe, expect, it, vi } from 'vitest';
import {
  listTaxDocumentRegister,
  type ListTaxDocumentRegisterDeps,
} from '@/modules/invoicing/application/use-cases/list-tax-document-register';
import { asInvoiceId, type Invoice } from '@/modules/invoicing/domain/invoice';
import { Money } from '@/modules/invoicing/domain/value-objects/money';

function row(id: string, status: Invoice['status'], subtotalSatang: bigint): Invoice {
  const vat = (subtotalSatang * 7n) / 100n;
  return {
    invoiceId: asInvoiceId(id),
    status,
    subtotal: Money.fromSatangUnsafe(subtotalSatang),
    vat: Money.fromSatangUnsafe(vat),
    total: Money.fromSatangUnsafe(subtotalSatang + vat),
  } as unknown as Invoice;
}

function makeDeps(
  rows: readonly Invoice[],
  nowIso = '2026-09-24T05:00:00Z',
): ListTaxDocumentRegisterDeps & {
  registerRepo: {
    listForPeriod: ReturnType<typeof vi.fn>;
    sumPeriodOutputVat: ReturnType<typeof vi.fn>;
  };
} {
  return {
    registerRepo: {
      listForPeriod: vi.fn(async () => rows),
      sumPeriodOutputVat: vi.fn(async () => ({
        rcVatSatang: '0',
        reVatSatang: '0',
        creditNoteVatSatang: '0',
      })),
    },
    clock: { nowIso: () => nowIso },
  };
}

const INPUT = { tenantId: 't', kind: 'rc_register' as const };

describe('listTaxDocumentRegister — summary counts', () => {
  it('reports cancelled rows separately and keeps them out of the totals', async () => {
    const deps = makeDeps([
      row('a', 'paid', 100_000n),
      row('b', 'void', 50_000n),
      row('c', 'partially_credited', 200_000n),
    ]);
    const result = await listTaxDocumentRegister(deps, {
      ...INPUT,
      from: '2026-08-01',
      to: '2026-08-31',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.summary.rowCount).toBe(3);
    expect(result.value.summary.cancelledCount).toBe(1);
    expect(result.value.summary.totalSubtotalSatang).toBe('300000');
    expect(result.value.summary.totalVatSatang).toBe('21000');
    expect(result.value.summary.totalSatang).toBe('321000');
  });

  it('reports zero cancelled when no row is void', async () => {
    const deps = makeDeps([row('a', 'paid', 100_000n)]);
    const result = await listTaxDocumentRegister(deps, {
      ...INPUT,
      from: '2026-08-01',
      to: '2026-08-31',
    });
    expect(result.ok && result.value.summary.cancelledCount).toBe(0);
  });
});

describe('listTaxDocumentRegister — period status', () => {
  async function statusFor(from: string, to: string, nowIso?: string) {
    const result = await listTaxDocumentRegister(makeDeps([], nowIso), { ...INPUT, from, to });
    if (!result.ok) throw new Error(`unexpected error ${result.error.code}`);
    return result.value.periodStatus;
  }

  it('a full calendar month that has ended is closed', async () => {
    expect(await statusFor('2026-08-01', '2026-08-31')).toBe('closed_month');
    // Leap-year February.
    expect(await statusFor('2028-02-01', '2028-02-29', '2028-03-05T05:00:00Z')).toBe(
      'closed_month',
    );
  });

  it('the current month is month-to-date, even when To is the last day of the month', async () => {
    expect(await statusFor('2026-09-01', '2026-09-24')).toBe('month_to_date');
    expect(await statusFor('2026-09-01', '2026-09-30')).toBe('month_to_date');
  });

  it('a month is still open on its last day, and closes at Bangkok midnight', async () => {
    // 2026-08-31 16:59 UTC = 23:59 Bangkok on the 31st.
    expect(await statusFor('2026-08-01', '2026-08-31', '2026-08-31T16:59:00Z')).toBe(
      'month_to_date',
    );
    // 2026-08-31 17:00 UTC = 00:00 Bangkok on 1 September.
    expect(await statusFor('2026-08-01', '2026-08-31', '2026-08-31T17:00:00Z')).toBe(
      'closed_month',
    );
  });

  it('a range that is not one calendar month is never "the figure to report"', async () => {
    expect(await statusFor('2026-07-01', '2026-08-31')).toBe('not_a_month');
    expect(await statusFor('2026-08-02', '2026-08-31')).toBe('not_a_month');
    expect(await statusFor('2026-08-01', '2026-08-30')).toBe('not_a_month');
  });
});

describe('listTaxDocumentRegister — calendar-date validation', () => {
  it.each([
    ['2026-02-30', '2026-03-31'],
    ['2026-02-01', '2026-02-29'],
    ['2026-13-01', '2026-12-31'],
    ['2026-09-00', '2026-09-24'],
  ])('refuses %s → %s as invalid_range without querying', async (from, to) => {
    const deps = makeDeps([]);
    const result = await listTaxDocumentRegister(deps, { ...INPUT, from, to });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ code: 'invalid_range', reason: 'not_a_date' });
    expect(deps.registerRepo.listForPeriod).not.toHaveBeenCalled();
    expect(deps.registerRepo.sumPeriodOutputVat).not.toHaveBeenCalled();
  });
});

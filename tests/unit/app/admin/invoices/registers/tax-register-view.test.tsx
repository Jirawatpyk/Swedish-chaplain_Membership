/**
 * Spec 122 US8c (T846) — the tax-document registers on AURA, boards
 * `Admin-invoice-registers` (+ mobile) and `Admin-registers-*`, in one view
 * the page and the no-DB preview both render.
 *
 * User story 8 asks that the register's row count and totals equal `main`
 * exactly: every figure here is the use case's output put through the same
 * formatter the page used (`formatSatangThb`), and the summary line keeps its
 * words and order. The register form still pushes the same URL.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { formatSatangThb } from '@/lib/format-thb';
import { bangkokLocalDate } from '@/lib/fiscal-year';
import type { Invoice, ListTaxDocumentRegisterOutput } from '@/modules/invoicing';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as never }),
  getLocale: async () => 'en',
}));
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/invoices/registers',
  useSearchParams: () => new URLSearchParams(),
}));

const { renderTaxRegisterView } = await import(
  '@/app/(staff)/admin/invoices/registers/_components/tax-register-view'
);
type ViewProps = Parameters<typeof renderTaxRegisterView>[0];

const r = en.admin.invoices.registers;
const thb = (s: string | bigint) => formatSatangThb(BigInt(s), 'en');

function inv(over: Record<string, unknown>): Invoice {
  return {
    invoiceId: 'inv-x',
    status: 'paid',
    receiptDocumentNumberRaw: 'RC-2026-000038',
    paymentDate: '2026-09-12',
    paidAt: null,
    memberIdentitySnapshot: { legal_name: 'Siam Nordic Trading Co., Ltd.', tax_id: '0105557004563' },
    subtotal: { satang: 3_600_000n },
    vat: { satang: 252_000n },
    total: { satang: 3_852_000n },
    vatTreatment: 'standard',
    zeroRateCertNo: null,
    ...over,
  } as unknown as Invoice;
}

const output: ListTaxDocumentRegisterOutput = {
  rows: [
    inv({ invoiceId: 'a' }),
    inv({
      invoiceId: 'b',
      status: 'void',
      receiptDocumentNumberRaw: 'RC-2026-000040',
      paymentDate: null,
      paidAt: '2026-09-15T20:30:00.000Z',
      memberIdentitySnapshot: { legal_name: 'Chiang Mai Nordic Crafts Co., Ltd.', tax_id: '0105549087650' },
      subtotal: { satang: 350_000n },
      vat: { satang: 24_500n },
      total: { satang: 374_500n },
    }),
    inv({
      invoiceId: 'c',
      receiptDocumentNumberRaw: 'RC-2026-000041',
      vatTreatment: 'zero_rated_80_1_5',
      zeroRateCertNo: 'MFA-0042',
      vat: { satang: 0n },
      total: { satang: 3_600_000n },
    }),
  ],
  summary: {
    rowCount: 3,
    cancelledCount: 1,
    totalSubtotalSatang: '7200000',
    totalVatSatang: '252000',
    totalSatang: '7452000',
  },
  periodOutputVat: {
    rcVatSatang: '2254000',
    reVatSatang: '308000',
    creditNoteVatSatang: '112000',
    combinedVatSatang: '2450000',
  },
  periodStatus: 'month_to_date',
  legacyCombinedCount: 0,
};

function props(over: Partial<ViewProps> = {}): ViewProps {
  return {
    kind: 'rc_register',
    from: '2026-09-01',
    to: '2026-09-24',
    result: { ok: true, value: output },
    ...over,
  } as ViewProps;
}

async function renderView(over: Partial<ViewProps> = {}) {
  const el = (await renderTaxRegisterView(props(over))) as ReactElement;
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Bangkok">
      {el}
    </NextIntlClientProvider>,
  );
}

describe('renderTaxRegisterView — the figures equal the use case output', () => {
  it('shows the period output VAT, its two streams and the gross less credit notes', async () => {
    await renderView();
    const box = screen.getByTestId('period-output-vat');
    expect(within(box).getByText(thb('2450000'))).toBeInTheDocument();
    expect(box).toHaveTextContent(`${r.outputVat.rc} ${thb('2254000')}`);
    expect(box).toHaveTextContent(`${r.outputVat.re} ${thb('308000')}`);
    expect(box).toHaveTextContent(`${r.outputVat.gross} ${thb(2254000n + 308000n)}`);
    expect(box).toHaveTextContent(`${r.outputVat.creditNote} ${thb('112000')}`);
  });

  it('keeps the summary line word for word: count, cancelled, subtotal, VAT, total', async () => {
    await renderView();
    expect(screen.getByTestId('register-summary').textContent).toBe(
      `3 receipts (1 cancelled — not in totals) · ${r.summary.subtotal} ${thb('7200000')} · ${r.summary.vat} ${thb(
        '252000',
      )} · ${r.summary.total} ${thb('7452000')}`,
    );
  });

  it('lists every row, cancelled ones marked, with each row figure formatted as on main', async () => {
    await renderView();
    const grid = screen.getByRole('grid');
    expect(within(grid).getAllByRole('row')).toHaveLength(output.rows.length + 1);
    const voidRow = screen.getByTestId('register-row-void');
    expect(within(voidRow).getByText(r.cancelled)).toBeInTheDocument();
    // A legacy receipt with no payment date shows its Bangkok-local paid date.
    expect(within(voidRow).getByText(bangkokLocalDate('2026-09-15T20:30:00.000Z'))).toBeInTheDocument();
    expect(within(grid).getAllByText(thb(3_852_000n)).length).toBeGreaterThan(0);
    expect(within(grid).getByText('MFA-0042')).toBeInTheDocument();
    expect(within(grid).getByText(r.vatTreatment.zeroRated)).toBeInTheDocument();
  });

  it('says a month to date is not the figure to report, as a warning', async () => {
    await renderView();
    const status = screen.getByTestId('period-output-vat-status');
    expect(status).toHaveTextContent(r.outputVat.status.monthToDate);
    expect(status.closest('[role="alert"], .aura-alert')).not.toBeNull();
  });

  it('confirms a closed month plainly', async () => {
    await renderView({ result: { ok: true, value: { ...output, periodStatus: 'closed_month' } } } as Partial<ViewProps>);
    expect(screen.getByTestId('period-output-vat-status')).toHaveTextContent(r.outputVat.status.closedMonth);
  });

  it('shows the empty state when the period has no documents', async () => {
    await renderView({
      result: { ok: true, value: { ...output, rows: [], summary: { ...output.summary, rowCount: 0, cancelledCount: 0 } } },
    } as Partial<ViewProps>);
    expect(screen.getByText(r.empty)).toBeInTheDocument();
    expect(screen.queryByTestId('register-summary')).toBeNull();
  });

  it.each([
    [{ code: 'invalid_range', reason: 'not_a_date' }, r.errors.invalidDate],
    [{ code: 'invalid_range', reason: 'inverted' }, r.errors.invalidRange],
    [{ code: 'list_failed' }, r.errors.loadFailed],
  ])('routes %o to its message as an alert', async (error, message) => {
    await renderView({ result: { ok: false, error } } as Partial<ViewProps>);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByTestId('period-output-vat')).toBeNull();
  });
});

describe('the register form', () => {
  it('pushes the same URL as before, keeping the scroll', async () => {
    await renderView({ kind: 're_register', from: '2026-08-01', to: '2026-08-31' });
    fireEvent.click(screen.getByRole('button', { name: r.actions.view }));
    expect(push).toHaveBeenLastCalledWith('/admin/invoices/registers?kind=re_register&from=2026-08-01&to=2026-08-31', {
      scroll: false,
    });
  });
});

/**
 * Spec 122 US8c (T844) — the credit-notes list on AURA, board
 * `Admin-credit-notes`: one DataTable (cards below 640px) with Number (+ the
 * Refund chip), Issued, Original tax invoice, Member, Reason, Total and a PDF
 * download; the number opens the detail, so there is no separate View
 * button. The filters sit on AURA's FilterBar and push `q` / `fy` exactly as
 * before (`scroll: false`, the page reset).
 *
 * Renders with the REAL `en.json`, so a dangling key fails instead of
 * echoing itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import type { ListCreditNotesRow } from '@/modules/invoicing';

const push = vi.fn();
let searchParamsStub = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => searchParamsStub,
  usePathname: () => '/admin/credit-notes',
}));

import { CreditNotesTable } from '@/app/(staff)/admin/credit-notes/_components/credit-notes-table';
import { CREDIT_NOTES_COLUMN_LAYOUT } from '@/app/(staff)/admin/credit-notes/_components/credit-notes-table-columns';
import { CreditNoteFilters } from '@/app/(staff)/admin/credit-notes/_components/credit-note-filters';

const list = en.admin.creditNotes.list;

function row(overrides: Partial<ListCreditNotesRow> = {}): ListCreditNotesRow {
  return {
    creditNoteId: 'cn-1',
    documentNumberRaw: 'CN-2026-000014',
    issueDate: '2026-09-23',
    originalInvoiceId: 'inv-1',
    original: {
      receiptNumberRaw: 'RC-2026-000038',
      related: { kind: 'bill', numberRaw: 'SC-2026-000102' },
    },
    isRefund: false,
    memberLegalName: 'Siam Nordic Trading Co., Ltd.',
    totalSatang: '1070000',
    reason: 'Charged the Premium rate',
    ...overrides,
  };
}

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  push.mockClear();
  searchParamsStub = new URLSearchParams();
});

describe('<CreditNotesTable>', () => {
  it('draws the board columns in order', () => {
    render(wrap(<CreditNotesTable rows={[row()]} />));
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim());
    expect(headers).toEqual([
      list.columns.documentNumber,
      list.columns.issueDate,
      list.columns.originalReceipt,
      list.columns.member,
      list.columns.reason,
      list.columns.total,
      list.columns.pdf,
    ]);
  });

  it('opens the detail from the number; there is no separate View button', () => {
    render(wrap(<CreditNotesTable rows={[row()]} />));
    const table = screen.getByRole('grid');
    expect(within(table).getByRole('link', { name: 'CN-2026-000014' })).toHaveAttribute(
      'href',
      '/admin/credit-notes/cn-1',
    );
    expect(within(table).queryByRole('link', { name: /^View/ })).toBeNull();
  });

  it('downloads the PDF from the same URL as before, named for the credit note', () => {
    render(wrap(<CreditNotesTable rows={[row()]} />));
    const pdf = screen.getByRole('link', { name: 'Download PDF for credit note CN-2026-000014' });
    expect(pdf).toHaveAttribute('href', '/api/credit-notes/cn-1/pdf');
    expect(pdf).toHaveAttribute('download');
  });

  it('puts the PDF download at the phone card\'s top right, as an icon named by its label', () => {
    // Maintainer, 3 Oct: the list's only action needs no row of its own.
    // AURA puts an `actions` column top-right in a stacked card unless it is
    // given a `card` place (a 'footer' row is what this replaced).
    expect(CREDIT_NOTES_COLUMN_LAYOUT.pdf).toMatchObject({ actions: true });
    expect(CREDIT_NOTES_COLUMN_LAYOUT.pdf).not.toHaveProperty('card');
    render(wrap(<CreditNotesTable rows={[row()]} />));
    const pdf = screen.getByRole('link', { name: 'Download PDF for credit note CN-2026-000014' });
    expect(pdf.textContent).toBe('');
  });

  it('shows the total with the formatter used on main, the date and the original receipt', () => {
    render(wrap(<CreditNotesTable rows={[row()]} />));
    const table = screen.getByRole('grid');
    expect(within(table).getByText('10,700.00 THB')).toBeInTheDocument();
    expect(within(table).getByText('RC-2026-000038')).toBeInTheDocument();
    expect(within(table).getByText('Siam Nordic Trading Co., Ltd.')).toBeInTheDocument();
  });

  it('marks a credit note issued by a refund with the Refund chip', () => {
    render(wrap(<CreditNotesTable rows={[row({ isRefund: true })]} />));
    expect(screen.getByText(en.shared.creditNoteOriginal.refund)).toBeInTheDocument();
  });
});

describe('<CreditNoteFilters> on the FilterBar', () => {
  it('pushes the fiscal year with scroll kept and the page reset', () => {
    searchParamsStub = new URLSearchParams('page=3');
    render(wrap(<CreditNoteFilters />));
    // AURA's Select keeps a real <select> under its listbox (US5a precedent).
    const fy = screen
      .getByRole('combobox', { name: new RegExp(list.filters.fiscalYear) })
      .closest('.aura-select')
      ?.querySelector('select');
    const year = String(new Date().getFullYear());
    fireEvent.change(fy!, { target: { value: year } });
    expect(push).toHaveBeenLastCalledWith(`/admin/credit-notes?fy=${year}`, { scroll: false });
  });

  it('pushes the search after the debounce', () => {
    render(wrap(<CreditNoteFilters />));
    const box = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    fireEvent.change(box, { target: { value: 'CN-2026' } });
    act(() => vi.advanceTimersByTime(350));
    expect(push).toHaveBeenLastCalledWith('/admin/credit-notes?q=CN-2026', { scroll: false });
  });

  it('Clear filters drops both and goes back to the bare list', () => {
    searchParamsStub = new URLSearchParams('q=CN&fy=2025');
    render(wrap(<CreditNoteFilters />));
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(push).toHaveBeenLastCalledWith('/admin/credit-notes', { scroll: false });
  });
});

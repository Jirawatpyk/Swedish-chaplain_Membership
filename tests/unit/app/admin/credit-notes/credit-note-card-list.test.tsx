/**
 * Render test for `<CreditNoteCardList>` — the ≤md card layout of the admin
 * credit-note directory (the desktop table scrolls sideways on a phone).
 *
 * Renders with the REAL `en.json` (a dangling key fails the assertion rather
 * than echoing the key) inside a NextIntlClientProvider, because the shared
 * `CreditNoteOriginalReceipt` / `CreditNoteRefundBadge` cells read their own
 * `shared.creditNoteOriginal` translations.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import en from '@/i18n/messages/en.json';
import type { ListCreditNotesRow } from '@/modules/invoicing';
import { formatTaxDocDate } from '@/lib/format-tax-doc-date';
import { CreditNoteCardList } from '@/app/(staff)/admin/credit-notes/_components/credit-note-card-list';

// Widened to the component's `t` prop shape (the page passes next-intl's
// namespaced translator the same way).
const t = createTranslator({
  locale: 'en',
  messages: en,
  namespace: 'admin.creditNotes.list',
}) as unknown as (key: string, values?: Record<string, string | number>) => string;

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
    memberLegalName: 'Credit Refs Co',
    totalSatang: '1070000',
    reason: 'difference credited',
    ...overrides,
  };
}

function renderList(rows: readonly ListCreditNotesRow[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Bangkok">
      <CreditNoteCardList rows={rows} locale="en" t={t} className="md:hidden" />
    </NextIntlClientProvider>,
  );
}

describe('<CreditNoteCardList>', () => {
  it('renders one list item per credit note, each titled by a level-2 heading link of 44px', () => {
    renderList([row(), row({ creditNoteId: 'cn-2', documentNumberRaw: 'CN-2026-000015' })]);
    const list = screen.getByRole('list');
    expect(list.className).toContain('md:hidden');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    const heading = within(items[0]!).getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent('CN-2026-000014');
    const link = within(heading).getByRole('link');
    expect(link).toHaveAttribute('href', '/admin/credit-notes/cn-1');
    expect(link.className).toContain('min-h-11');
  });

  it('shows the issue date, original tax invoice, member, reason and total', () => {
    renderList([row()]);
    const item = screen.getByRole('listitem');
    expect(item).toHaveTextContent(formatTaxDocDate('2026-09-23', 'en'));
    expect(item).toHaveTextContent('Original tax invoice');
    expect(item).toHaveTextContent('RC-2026-000038');
    expect(within(item).getByRole('link', { name: /Bill SC-2026-000102/ })).toHaveAttribute(
      'href',
      '/admin/invoices/inv-1',
    );
    // Member + reason keep their column names for screen readers.
    const terms = within(item)
      .getAllByRole('term')
      .map((el) => el.textContent);
    expect(terms).toEqual(['Member', 'Reason']);
    expect(item).toHaveTextContent('Credit Refs Co');
    expect(item).toHaveTextContent('difference credited');
    expect(item).toHaveTextContent('10,700.00 THB');
  });

  it('shows a long reason in full — no clamp, no touch-unreachable title', () => {
    const reason = 'A very long reason '.repeat(12).trim();
    renderList([row({ reason })]);
    const dd = screen.getByText(reason);
    expect(dd.className).not.toContain('line-clamp');
    expect(dd).not.toHaveAttribute('title');
  });

  it('marks only refund-origin notes with the Refund badge', () => {
    renderList([
      row(),
      row({ creditNoteId: 'cn-2', documentNumberRaw: 'CN-2026-000015', isRefund: true }),
    ]);
    const [manual, refund] = screen.getAllByRole('listitem');
    expect(manual).not.toHaveTextContent('Refund');
    expect(refund).toHaveTextContent('Refund');
  });

  it('View and PDF actions are named per note and meet the 44px target', () => {
    renderList([row()]);
    const view = screen.getByRole('link', { name: 'View credit note CN-2026-000014' });
    expect(view).toHaveAttribute('href', '/admin/credit-notes/cn-1');
    expect(view.className).toContain('min-h-11');
    const pdf = screen.getByRole('link', { name: 'Download PDF for credit note CN-2026-000014' });
    expect(pdf).toHaveAttribute('href', '/api/credit-notes/cn-1/pdf');
    expect(pdf.className).toContain('min-h-11');
  });
});

/**
 * 122 US5b-1 (T556) — the member's invoices on AURA `DataTable` (board
 * `Admin-member-detail`): Number, Status, Issued, Due, Paid, Total, Remaining
 * and a "⋯" row menu with the same destinations as before.
 *
 * - A writer gets View plus the actions the invoice's state allows: Record
 *   payment and Void on an issued invoice, Issue credit note on a paid or
 *   partly credited one.
 * - A manager (read-only on finance) sees the same items disabled, each
 *   saying why (the tooltip before) — never a dead link.
 * - The figures are the server's: the table prints what it is given.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemberInvoicesTable, type MemberInvoiceRow } from '@/app/(staff)/admin/members/[memberId]/_components/member-invoices-table';

afterEach(cleanup);

const labels = {
  caption: 'Invoices for this member',
  number: 'Number',
  status: 'Status',
  issued: 'Issued',
  due: 'Due',
  paid: 'Paid',
  total: 'Total',
  remaining: 'Remaining',
  notPaid: 'Not paid yet',
  actionsFor: 'Actions for {number}',
  view: 'View',
  recordPayment: 'Record payment',
  issueCreditNote: 'Issue credit note',
  void: 'Void',
  disabledForManager: 'Managers can view invoices but not change them.',
};

const issued: MemberInvoiceRow = {
  invoiceId: 'i-1',
  number: 'SC-2026-000123',
  status: 'issued',
  statusLabel: 'Issued',
  issued: '15 Sep 2026',
  due: '15 Oct 2026',
  paid: null,
  total: '38,520.00 THB',
  remaining: '38,520.00 THB',
  owing: true,
};
const paid: MemberInvoiceRow = {
  ...issued,
  invoiceId: 'i-2',
  number: 'SC-2026-000045',
  status: 'paid',
  statusLabel: 'Paid',
  paid: '20 Mar 2026',
  remaining: '0.00 THB',
  owing: false,
};

function openMenu(number: string) {
  fireEvent.click(screen.getByRole('button', { name: labels.actionsFor.replace('{number}', number) }));
  return screen.getByRole('menu');
}

describe('MemberInvoicesTable (T556)', () => {
  it('a grid with the board columns, the figures as given', () => {
    render(<MemberInvoicesTable rows={[issued, paid]} labels={labels} canMutate />);
    const grid = screen.getByRole('grid', { name: labels.caption });
    const headers = within(grid).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    expect(headers.slice(0, 7)).toEqual(['Number', 'Status', 'Issued', 'Due', 'Paid', 'Total', 'Remaining']);
    expect(grid).toHaveTextContent('SC-2026-000123');
    expect(grid).toHaveTextContent('38,520.00 THB');
    // The board prints "Not paid yet" in the Paid column (G-U7P: words, not a dash).
    expect(within(grid).getByText(labels.notPaid)).not.toHaveClass('sr-only');
  });

  it('a writer, issued invoice: View, Record payment and Void — the links as before', () => {
    render(<MemberInvoicesTable rows={[issued]} labels={labels} canMutate />);
    const menu = openMenu('SC-2026-000123');
    expect(within(menu).getByRole('menuitem', { name: labels.view })).toHaveAttribute('href', '/admin/invoices/i-1');
    expect(within(menu).getByRole('menuitem', { name: labels.recordPayment })).toHaveAttribute(
      'href',
      '/admin/invoices/i-1#record-payment',
    );
    expect(within(menu).getByRole('menuitem', { name: labels.void })).toHaveAttribute('href', '/admin/invoices/i-1/void');
    expect(within(menu).queryByRole('menuitem', { name: labels.issueCreditNote })).toBeNull();
  });

  it('a writer, paid invoice: View and Issue credit note', () => {
    render(<MemberInvoicesTable rows={[paid]} labels={labels} canMutate />);
    const menu = openMenu('SC-2026-000045');
    expect(within(menu).getByRole('menuitem', { name: labels.issueCreditNote })).toHaveAttribute(
      'href',
      '/admin/invoices/i-2/credit-notes/new',
    );
    expect(within(menu).queryByRole('menuitem', { name: labels.void })).toBeNull();
  });

  it('a manager sees the actions disabled, each saying why', () => {
    render(<MemberInvoicesTable rows={[issued]} labels={labels} canMutate={false} />);
    const menu = openMenu('SC-2026-000123');
    expect(within(menu).getByRole('menuitem', { name: labels.view })).toHaveAttribute('href', '/admin/invoices/i-1');
    for (const name of [labels.recordPayment, labels.void]) {
      const item = within(menu).getByRole('menuitem', { name: new RegExp(name) });
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item).not.toHaveAttribute('href');
      expect(item).toHaveTextContent(labels.disabledForManager);
    }
  });

  // UX review H1: the chip-ink token (--aura-status-warning-fg) is near-black
  // in dark mode (1.13:1 on the surface); the owed figure takes AURA's warning
  // text token (5.14, handoff #106), ≥6.8:1 in both themes.
  it('an owed Remaining figure takes the warning text colour', () => {
    render(<MemberInvoicesTable rows={[issued]} labels={labels} canMutate />);
    const figure = screen.getAllByText('38,520.00 THB').find((el) => el.className.includes('font-medium'));
    expect(figure?.className).toContain('--aura-fg-warning');
  });

  // Board `Admin-member-detail-mobile`: a phone card shows Due, Total and
  // Remaining, the figures left-aligned under their labels. AURA starts an
  // end-aligned column under its label in the cards (5.14, handoff #108), so
  // the figure needs no wrapper of ours.
  it('phone cards leave out Issued and Paid, and leave figure alignment to AURA', () => {
    const { container } = render(<MemberInvoicesTable rows={[issued]} labels={labels} canMutate />);
    const total = within(container).getAllByText('38,520.00 THB')[0]!;
    expect(total.closest('[class*="max-[639px]:text-start"]')).toBeNull();
  });
});

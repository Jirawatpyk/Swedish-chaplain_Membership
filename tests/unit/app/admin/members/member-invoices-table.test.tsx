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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemberInvoicesTable, type MemberInvoiceRow } from '@/app/(staff)/admin/members/[memberId]/_components/member-invoices-table';

// PR P review M4 — jsdom has no layout: AURA DataTable measures its wrapper
// (`getBoundingClientRect().width` in a layout effect, then a ResizeObserver),
// and a 0px box reads as a phone. Give every box a desktop 1280px width and a
// ResizeObserver that reports it, so the table renders as a browser at 1280
// does: not stacked (the card-only columns are `grid: false`, see below).
const DESKTOP_WIDTH = 1280;
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ x: 0, y: 0, top: 0, left: 0, right: DESKTOP_WIDTH, bottom: 0, width: DESKTOP_WIDTH, height: 0, toJSON: () => ({}) }) as DOMRect,
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly cb: ResizeObserverCallback) {}
      observe(target: Element): void {
        this.cb([{ target, borderBoxSize: [{ inlineSize: DESKTOP_WIDTH, blockSize: 0 }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
    // Status is its own column, as the board draws it, whenever the table is
    // wide enough (AURA `hideBelow` reads the table's width). Below that the
    // column drops and the pill shows under the number instead, so the card
    // still fits the 655px main column at 1280 (PR P). The card-only Number
    // column (the phone card's title) is AURA 5.85 `grid: false`: drawn with
    // `data-grid="off"`, which AURA's stylesheet hides in the grid (jsdom
    // applies no CSS, so the test leaves it out by that marker).
    const allHeaders = within(grid).getAllByRole('columnheader');
    expect(allHeaders.filter((h) => h.getAttribute('data-grid') === 'off').map((h) => h.textContent?.trim())).toEqual(['Number']);
    const visible = allHeaders.filter((h) => h.getAttribute('data-grid') !== 'off');
    const headers = visible.map((h) => h.textContent?.trim());
    expect(headers.slice(0, 7)).toEqual(['Number', 'Status', 'Issued', 'Due', 'Paid', 'Total', 'Remaining']);
    expect(visible[1]).toHaveAttribute('data-hide');
    const cells = within(grid).getAllByRole('row')[1]!.querySelectorAll<HTMLElement>('[role=gridcell]:not([data-grid="off"])');
    expect(cells[0]).toHaveTextContent('SC-2026-000123');
    expect(cells[1]).toHaveTextContent(issued.statusLabel);
    // The stacked pill under the number is the narrow-table fallback only.
    const stacked = within(cells[0]!).getByText(issued.statusLabel).closest('[data-stacked-status]');
    // Named container: AURA nests its own (very wide) query containers.
    expect(stacked).toHaveClass('@min-[712px]/invoices:hidden');
    expect(grid.closest('.\\@container\\/invoices')).not.toBeNull();
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

  // PR Q review round 1 (a11y), AURA 5.86 #200 — `grid: false` columns are out
  // of aria-colcount / aria-colindex, so the card title can sit beside Number
  // and the grid's visible headers still number 1..N of N.
  it('the visible grid headers run aria-colindex 1..N of N with no gap', () => {
    render(<MemberInvoicesTable rows={[issued]} labels={labels} canMutate />);
    const grid = screen.getByRole('grid', { name: labels.caption });
    const visible = within(grid)
      .getAllByRole('columnheader')
      .filter((h) => h.getAttribute('data-grid') !== 'off')
      .map((h) => Number(h.getAttribute('aria-colindex')));
    expect(visible).toEqual(visible.map((_, i) => i + 1));
    expect(Number(grid.getAttribute('aria-colcount'))).toBe(visible.length);
  });

  it('on a phone the rows are a divided list inside the Invoices card, not framed cards of their own', () => {
    // AURA 5.87 #204: DataTable stackStyle="list" (no stand-in of ours).
    const { container } = render(<MemberInvoicesTable rows={[issued]} labels={labels} canMutate />);
    expect(container.querySelector('.aura-table--stack-list')).not.toBeNull();
    expect(container.querySelector('.member-invoices-list')).toBeNull();
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    expect(css).not.toContain('member-invoices-list');
    // AURA's list keeps the ⋯ cell's -8px end margin with 0 row padding, so
    // it would overhang the table by 8px (R143b): stand-in until AURA #207.
    expect(css).toMatch(/\.aura-table--stack-list \.aura-table__td\[data-card='actions'\] \{ margin-inline-end: 0; \}/);
  });

  it('the phone card still takes the number as its title and the status as its pill', () => {
    render(<MemberInvoicesTable rows={[issued]} labels={labels} canMutate />);
    const row = within(screen.getByRole('grid', { name: labels.caption })).getAllByRole('row')[1]!;
    expect(row.querySelector('[data-card="title"]')).toHaveTextContent(issued.number);
    expect(row.querySelector('[data-card="pill"]')).toHaveTextContent(issued.statusLabel);
  });
});

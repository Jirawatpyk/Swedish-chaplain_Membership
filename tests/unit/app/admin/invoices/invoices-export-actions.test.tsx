/**
 * Spec 122 US8 (T809) — the invoice list's secondary header actions on a
 * phone: "New invoice" keeps the row, and Tax registers and Export CSV… move
 * into a ⋯ menu (the US5a members header and the US5b-1 member-detail ⋯
 * menu). From sm up the Export CSV… button shows as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { InvoicesExportActions } from '@/app/(staff)/admin/invoices/_components/invoices-export-actions';

const inv = enMessages.admin.invoices;

function renderActions(showRegisters = true) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <InvoicesExportActions showRegisters={showRegisters} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
});

describe('InvoicesExportActions (T809)', () => {
  it('the Export CSV… button is for sm and up; the phone gets a 44px ⋯ instead', () => {
    renderActions();
    expect(screen.getByRole('button', { name: inv.csvExport.trigger })).toHaveClass('max-sm:hidden');
    const more = screen.getByRole('button', { name: inv.list.actions.moreHeaderAria });
    expect(more).toHaveClass('aura-icon-btn--touch');
    expect(more.closest('.sm\\:hidden')).not.toBeNull();
  });

  it('the ⋯ menu holds Tax registers (a link) and Export CSV…', () => {
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: inv.list.actions.moreHeaderAria }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: inv.registers.entry })).toHaveAttribute(
      'href',
      '/admin/invoices/registers',
    );
    expect(within(menu).getByRole('menuitem', { name: inv.csvExport.trigger })).toBeInTheDocument();
  });

  it('without the registers flag the menu has no Tax registers item', () => {
    renderActions(false);
    fireEvent.click(screen.getByRole('button', { name: inv.list.actions.moreHeaderAria }));
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: inv.registers.entry })).toBeNull();
  });

  it('Export CSV… in the menu opens the export dialog, and closing it returns focus to ⋯', async () => {
    vi.useRealTimers();
    renderActions();
    const more = screen.getByRole('button', { name: inv.list.actions.moreHeaderAria });
    fireEvent.click(more);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: inv.csvExport.trigger }));
    const dialog = await screen.findByRole('dialog', { name: inv.csvExport.dialog.title });
    fireEvent.click(within(dialog).getByRole('button', { name: inv.csvExport.actions.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: inv.csvExport.dialog.title })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(more));
  });
});

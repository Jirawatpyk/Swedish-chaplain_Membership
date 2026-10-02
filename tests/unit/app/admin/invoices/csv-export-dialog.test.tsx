/**
 * Spec 122 US8 (T805) — the CSV export dialog on AURA: the same export URL
 * opened the same way, the same range checks, on AURA's button and dialog.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { CsvExportDialog } from '@/app/(staff)/admin/invoices/_components/csv-export-dialog';

const t = enMessages.admin.invoices.csvExport;

function openDialog() {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CsvExportDialog />
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: t.trigger }));
  return screen.getByRole('dialog', { name: t.dialog.title });
}

function setRange(dialog: HTMLElement, from: string, to: string) {
  fireEvent.change(within(dialog).getByLabelText(new RegExp(`^${t.fields.from}`)), { target: { value: from } });
  fireEvent.change(within(dialog).getByLabelText(new RegExp(`^${t.fields.to}`)), { target: { value: to } });
}

afterEach(() => vi.restoreAllMocks());

describe('CsvExportDialog on AURA (T805)', () => {
  it('a secondary AURA trigger opens an AURA dialog with the title and description', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CsvExportDialog />
      </NextIntlClientProvider>,
    );
    const trigger = screen.getByRole('button', { name: t.trigger });
    expect(trigger).toHaveClass('aura-btn', 'aura-btn--secondary');
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: t.dialog.title });
    expect(dialog).toHaveClass('aura-dialog');
    expect(dialog).toHaveAccessibleDescription(t.dialog.description);
  });

  it('Download opens the same export URL in a new tab, and the dialog stays open', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const dialog = openDialog();
    setRange(dialog, '2026-09-01', '2026-09-30');
    fireEvent.click(within(dialog).getByRole('button', { name: t.actions.download }));
    expect(open).toHaveBeenCalledWith(
      '/api/admin/invoices/export.csv?from=2026-09-01&to=2026-09-30',
      '_blank',
      'noopener,noreferrer',
    );
    expect(screen.getByRole('dialog', { name: t.dialog.title })).toBeInTheDocument();
  });

  it.each([
    ['an inverted range', '2026-09-30', '2026-09-01', t.errors.rangeInverted],
    ['a range over a year', '2025-01-01', '2026-09-30', t.errors.rangeTooWide],
  ])('%s is refused in place, with both fields marked', (_name, from, to, message) => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const dialog = openDialog();
    setRange(dialog, from, to);
    fireEvent.click(within(dialog).getByRole('button', { name: t.actions.download }));
    expect(open).not.toHaveBeenCalled();
    expect(within(dialog).getByTestId('csv-export-error')).toHaveTextContent(message);
    for (const label of [t.fields.from, t.fields.to]) {
      const field = within(dialog).getByLabelText(new RegExp(`^${label}`));
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(field.getAttribute('aria-describedby') ?? '').toContain('csv-export-error-msg');
    }
  });

  it('Cancel closes it', () => {
    const dialog = openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: t.actions.cancel }));
    expect(screen.queryByRole('dialog', { name: t.dialog.title })).toBeNull();
  });
});

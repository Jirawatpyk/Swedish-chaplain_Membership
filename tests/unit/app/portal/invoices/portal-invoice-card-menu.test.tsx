/**
 * Spec 122 US4 (option C) — the phone invoice card's "⋯" menu. The card shows
 * one labelled download (the invoice while unpaid, the receipt once paid);
 * this menu holds the other document and "Email me a copy". Choosing an item
 * runs the same download / resend the buttons run (same URL, same toasts,
 * same 5-minute cooldown).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  loading: vi.fn(() => 'loading-id'),
  dismiss: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));
const downloadPdf = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/download-pdf-client', () => ({ downloadPdf }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { PortalInvoiceCardMenu } from '@/app/(member)/portal/invoices/_components/portal-invoice-card-menu';

const fetchMock = vi.fn();

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  downloadPdf.mockClear();
});

function renderMenu(props: Partial<Parameters<typeof PortalInvoiceCardMenu>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PortalInvoiceCardMenu
        invoiceId="inv-1"
        label="More actions for SC-2026-000045"
        invoiceDownload={{ documentNumber: 'SC-2026-000045', label: 'Invoice' }}
        resendable
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'More actions for SC-2026-000045' }));
}

describe('<PortalInvoiceCardMenu>', () => {
  it('is a 44px "More actions for …" button that opens the other document and "Email me a copy"', () => {
    renderMenu();
    const trigger = screen.getByRole('button', { name: 'More actions for SC-2026-000045' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger.className).toContain('min-h-11');
    expect(trigger.className).toContain('min-w-11');

    openMenu();
    const items = screen.getAllByRole('menuitem').map((el) => el.textContent?.trim());
    expect(items).toEqual(['Invoice', 'Email me a copy']);
  });

  it('choosing the invoice downloads the same PDF the button downloads', async () => {
    renderMenu();
    openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Invoice/ }));
    });
    expect(downloadPdf).toHaveBeenCalledTimes(1);
    expect(downloadPdf).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/api/portal/invoices/inv-1/pdf',
        fallbackFilename: 'SC-2026-000045.pdf',
      }),
    );
    expect(toastMock.loading).toHaveBeenCalled();
    expect(toastMock.dismiss).toHaveBeenCalledWith('loading-id');
  });

  it('choosing "Email me a copy" resends once, then the item stays unavailable for the cooldown', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    renderMenu();
    openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Email me a copy' }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/portal/invoices/inv-1/resend',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(toastMock.success).toHaveBeenCalledWith(en.portal.invoices.toast.resendSuccess);

    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Email me a copy' })).toBeDisabled();
  });

  it('with only the resend to offer, the menu holds just "Email me a copy"', () => {
    renderMenu({ invoiceDownload: undefined });
    openMenu();
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent?.trim())).toEqual([
      'Email me a copy',
    ]);
  });
});

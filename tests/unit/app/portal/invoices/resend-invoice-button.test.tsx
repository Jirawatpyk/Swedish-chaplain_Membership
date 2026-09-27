/**
 * Spec 122 US4 (UX review M4) — the compact (icon) resend button stays
 * focusable while it sends and during the 5-minute cooldown: a real
 * `disabled` drops keyboard focus to <body> the moment Enter lands. It is
 * `aria-disabled` instead, and a second press sends nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { ResendInvoiceButton } from '@/app/(member)/portal/invoices/_components/resend-invoice-button';

const fetchMock = vi.fn();

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function renderCompact() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ResendInvoiceButton invoiceId="inv-1" documentNumber="SC-2026-000123" layout="compact" />
    </NextIntlClientProvider>,
  );
}

describe('<ResendInvoiceButton layout="compact">', () => {
  it('keeps focus while sending and after it sent; repeat presses send nothing', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    renderCompact();
    const button = screen.getByRole('button', { name: /SC-2026-000123/ });
    button.focus();

    await act(async () => {
      fireEvent.click(button);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveFocus();

    await act(async () => {
      fireEvent.click(button);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

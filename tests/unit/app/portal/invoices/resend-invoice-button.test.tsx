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
import th from '@/i18n/messages/th.json';
import sv from '@/i18n/messages/sv.json';

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

  it.each([
    ['en', en],
    ['th', th],
    ['sv', sv],
  ] as const)('%s — the full button\'s name starts with its visible text (WCAG 2.5.3 Label in Name)', (locale, messages) => {
    render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <ResendInvoiceButton invoiceId="inv-1" documentNumber="SC-2026-000123" layout="full" />
      </NextIntlClientProvider>,
    );
    const visible = messages.portal.invoices.actions.emailCopy;
    const button = screen.getByRole('button', { name: /SC-2026-000123/ });
    expect(button).toHaveTextContent(visible);
    expect(button.getAttribute('aria-label')?.startsWith(visible)).toBe(true);
  });

  it('the full form (detail page) shows the 5-minute cooldown as aria-disabled too', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ResendInvoiceButton invoiceId="inv-1" documentNumber="SC-2026-000123" layout="full" />
      </NextIntlClientProvider>,
    );
    const button = screen.getByRole('button', { name: /SC-2026-000123/ });
    button.focus();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    expect(button).toHaveFocus();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the full form is AURA Button: aria-disabled holds through the 5-minute window while loading toggles, and it swallows clicks', async () => {
    vi.useFakeTimers();
    try {
      let answer: (res: Response) => void = () => {};
      fetchMock.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      render(
        <NextIntlClientProvider locale="en" messages={en}>
          <ResendInvoiceButton invoiceId="inv-1" documentNumber="SC-2026-000123" layout="full" />
        </NextIntlClientProvider>,
      );
      const button = screen.getByRole('button', { name: /SC-2026-000123/ });
      expect(button).toHaveClass('aura-btn', 'aura-btn--ghost');

      await act(async () => {
        fireEvent.click(button);
      });
      // Sending: AURA's loading state, busy and blocked.
      expect(button).toHaveClass('is-loading');
      expect(button).toHaveAttribute('aria-busy', 'true');
      expect(button).toHaveAttribute('aria-disabled', 'true');

      await act(async () => {
        answer(new Response(null, { status: 202 }));
      });
      // Sent: loading is off, the cooldown keeps it aria-disabled.
      expect(button).not.toHaveClass('is-loading');
      expect(button).not.toHaveAttribute('aria-busy');
      expect(button).toHaveAttribute('aria-disabled', 'true');

      await act(async () => {
        vi.advanceTimersByTime(4 * 60_000 + 59_000);
      });
      expect(button).toHaveAttribute('aria-disabled', 'true');
      // AURA's Button swallows the click itself (preventDefault, no handler).
      let notPrevented = true;
      await act(async () => {
        notPrevented = fireEvent.click(button);
      });
      expect(notPrevented).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      expect(button).not.toHaveAttribute('aria-disabled');
    } finally {
      vi.useRealTimers();
    }
  });
});

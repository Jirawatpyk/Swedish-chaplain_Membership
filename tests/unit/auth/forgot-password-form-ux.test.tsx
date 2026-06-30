/**
 * ForgotPasswordForm UX (audit XF focus + XF-08).
 *
 * On success the form must move focus to the status card (the focused submit
 * button is unmounted); a 429 surfaces an actionable rate-limit message inline
 * (not a generic "went wrong"). Rendered against real en.json with mocked fetch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';

beforeEach(() => {
  vi.useRealTimers();
});

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ForgotPasswordForm />
    </NextIntlClientProvider>,
  );
}

describe('ForgotPasswordForm', () => {
  it('moves focus to the status card on a successful submit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const { container } = renderForm();
    fireEvent.change(container.querySelector('#email')!, {
      target: { value: 'user@example.com' },
    });
    fireEvent.submit(container.querySelector('form')!);

    const card = await screen.findByRole('status');
    await waitFor(() => expect(document.activeElement).toBe(card));
    vi.unstubAllGlobals();
  });

  it('shows the error banner when a RESEND fails (banner is not gated on !submitted)', async () => {
    // Regression: the banner was `{!submitted && errorMsg}`, but a resend only
    // happens after submitted===true, so a failed resend was silent.
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200 }) // first submit
        .mockResolvedValueOnce({ ok: false, status: 429 }); // resend
      vi.stubGlobal('fetch', fetchMock);
      const { container } = renderForm();
      fireEvent.change(container.querySelector('#email')!, {
        target: { value: 'user@example.com' },
      });
      fireEvent.submit(container.querySelector('form')!);
      // Flush the first submit → success card + 60s resend countdown start.
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByRole('status')).toBeTruthy();
      // Run the countdown so the Resend button re-enables, then click it.
      await vi.advanceTimersByTimeAsync(60_000);
      fireEvent.click(screen.getByRole('button', { name: /resend/i }));
      await vi.advanceTimersByTimeAsync(0); // flush the resend fetch
      // The 429 banner must render even though submitted===true.
      expect(
        screen.getByText(
          'Too many requests. Please wait a moment and try again.',
        ),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('shows an actionable rate-limit message inline on 429 (not generic)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    const { container } = renderForm();
    fireEvent.change(container.querySelector('#email')!, {
      target: { value: 'user@example.com' },
    });
    fireEvent.submit(container.querySelector('form')!);

    expect(
      await screen.findByText(
        'Too many requests. Please wait a moment and try again.',
      ),
    ).toBeTruthy();
    // No success card on a failed attempt.
    expect(screen.queryByRole('status')).toBeNull();
    vi.unstubAllGlobals();
  });
});

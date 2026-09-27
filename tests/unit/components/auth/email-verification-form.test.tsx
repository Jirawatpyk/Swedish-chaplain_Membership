/**
 * Spec 122 US2 T206 — the email-verification landing on AURA (`Auth-verify`
 * boards): a live status line while it verifies, then AURA's success alert
 * with a full-width link button to sign in, or a danger alert with a retry
 * button when retrying can help. Rendered against real en.json.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { EmailVerificationForm } from '@/components/auth/email-verification-form';

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderWith(response: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <EmailVerificationForm token="tok" redirectTo="/portal" />
    </NextIntlClientProvider>,
  );
}

describe('EmailVerificationForm on AURA (spec 122 US2)', () => {
  it('announces success in a titled success alert, retitles the page, and links a member on to the portal', async () => {
    renderWith(new Response(null, { status: 200 }));
    const status = await screen.findByText(en.auth.emailVerification.successAlertBody);
    const alert = status.closest('.aura-alert');
    expect(alert).toHaveClass('aura-alert--success');
    expect(alert).toHaveAttribute('role', 'status');
    expect(alert).toHaveTextContent(en.auth.emailVerification.successAlertTitle);
    expect(screen.getByRole('heading', { level: 1, name: en.auth.emailVerification.successTitle })).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: en.auth.emailVerification.continueToPortal });
    expect(cta).toHaveAttribute('href', '/portal');
    expect(cta).toHaveClass('aura-btn');
  });

  it('shows a retryable failure in a danger alert with an AURA retry button', async () => {
    renderWith(new Response(JSON.stringify({}), { status: 500 }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('aura-alert', 'aura-alert--danger');
    expect(alert).toHaveTextContent(en.auth.emailVerification.errors.serverError);
    expect(screen.getByRole('button', { name: en.auth.emailVerification.retry })).toHaveClass('aura-btn');
  });

  it('offers no retry for an invalid link', async () => {
    renderWith(new Response(JSON.stringify({ error: 'invalid' }), { status: 400 }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('aura-alert--danger');
    expect(screen.queryByRole('button', { name: en.auth.emailVerification.retry })).toBeNull();
  });
});

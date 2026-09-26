/**
 * Unit tests for <EmailChangeRevertForm> — the FR-012b revert landing card.
 *
 * The card's copy must match the state the user is in:
 *   - success: the "click below to revert" description is gone (the button
 *     is gone too) and focus moves to the success region instead of <body>.
 *   - 400 invalid_token: the link can never succeed, so the revert button is
 *     replaced by a sign-in link.
 *   - 429 / 5xx: the button stays so the user can retry.
 *
 * Spec 122 US2 T206 — drawn with AURA as on the `Auth-revert*` boards: the
 * page title is this form's h1, AURA alerts carry each outcome, and the
 * buttons are AURA's.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';

import { EmailChangeRevertForm } from '@/components/auth/email-change-revert-form';

const copy = messages.auth.emailChangeRevert;

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <EmailChangeRevertForm token="tok-123" />
    </NextIntlClientProvider>,
  );
}

function stubRevertResponse(status: number, body: unknown = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'retry-after': '30' }),
      json: () => Promise.resolve(body),
    }),
  );
}

async function clickRevert() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: copy.revert }));
  });
}

describe('<EmailChangeRevertForm>', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the "click below" card description before the revert is submitted', () => {
    renderForm();
    expect(screen.queryByText(copy.cardDescription)).not.toBeNull();
  });

  it('draws the page h1, a warning alert on what reverting does and an AURA danger button', () => {
    renderForm();
    expect(screen.getByRole('heading', { level: 1, name: copy.title })).toBeInTheDocument();
    expect(screen.getByText(copy.description).closest('.aura-alert')).toHaveClass('aura-alert--warning');
    expect(screen.getByRole('button', { name: copy.revert })).toHaveClass('aura-btn', 'aura-btn--danger');
  });

  it('after a successful revert, the card description is gone and focus is on the success region', async () => {
    stubRevertResponse(200, { ok: true });
    renderForm();
    await clickRevert();

    expect(screen.queryByText(copy.cardDescription)).toBeNull();
    expect(screen.queryByRole('button', { name: copy.revert })).toBeNull();
    const region = screen.getByRole('status');
    expect(region.textContent).toContain(copy.successMessage);
    expect(region).toHaveClass('aura-alert', 'aura-alert--success');
    expect(document.activeElement).toBe(region);
    expect(screen.getByRole('link', { name: copy.completePasswordReset })).toHaveClass('aura-btn');
  });

  it('after a 400 (expired / used link), the revert button is not rendered and a sign-in link is', async () => {
    stubRevertResponse(400, { error: 'invalid_token' });
    renderForm();
    await clickRevert();

    expect(screen.queryByText(copy.errors.invalidToken)).not.toBeNull();
    expect(screen.queryByRole('button', { name: copy.revert })).toBeNull();
    const link = screen.getByRole('link', { name: copy.goToSignIn });
    expect(link.getAttribute('href')).toBe('/portal/sign-in');
    expect(link).toHaveClass('aura-btn');
    expect(screen.getByRole('alert')).toHaveClass('aura-alert--danger');
  });

  it.each([
    [429, copy.errors.rateLimited.replace('{seconds}', '30'), 'aura-alert--warning'],
    [500, copy.errors.serverError, 'aura-alert--danger'],
  ])('after a %i the revert button stays so the user can retry', async (status, message, tone) => {
    stubRevertResponse(status, {});
    renderForm();
    await clickRevert();

    expect(screen.getByText(message).closest('.aura-alert')).toHaveClass(tone);
    expect(screen.queryByRole('button', { name: copy.revert })).not.toBeNull();
  });
});

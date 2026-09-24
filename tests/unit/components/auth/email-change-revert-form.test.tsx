/**
 * Unit tests for <EmailChangeRevertForm> — the FR-012b revert landing card.
 *
 * The card's copy must match the state the user is in:
 *   - success: the "click below to revert" description is gone (the button
 *     is gone too) and focus moves to the success region instead of <body>.
 *   - 400 invalid_token: the link can never succeed, so the revert button is
 *     replaced by a sign-in link.
 *   - 429 / 5xx: the button stays so the user can retry.
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

  it('after a successful revert, the card description is gone and focus is on the success region', async () => {
    stubRevertResponse(200, { ok: true });
    renderForm();
    await clickRevert();

    expect(screen.queryByText(copy.cardDescription)).toBeNull();
    expect(screen.queryByRole('button', { name: copy.revert })).toBeNull();
    const region = screen.getByRole('status');
    expect(region.textContent).toContain(copy.successMessage);
    expect(document.activeElement).toBe(region);
  });

  it('after a 400 (expired / used link), the revert button is not rendered and a sign-in link is', async () => {
    stubRevertResponse(400, { error: 'invalid_token' });
    renderForm();
    await clickRevert();

    expect(screen.queryByText(copy.errors.invalidToken)).not.toBeNull();
    expect(screen.queryByRole('button', { name: copy.revert })).toBeNull();
    const link = screen.getByRole('link', { name: copy.goToSignIn });
    expect(link.getAttribute('href')).toBe('/portal/sign-in');
  });

  it.each([
    [429, copy.errors.rateLimited.replace('{seconds}', '30')],
    [500, copy.errors.serverError],
  ])('after a %i the revert button stays so the user can retry', async (status, message) => {
    stubRevertResponse(status, {});
    renderForm();
    await clickRevert();

    expect(screen.queryByText(message)).not.toBeNull();
    expect(screen.queryByRole('button', { name: copy.revert })).not.toBeNull();
  });
});

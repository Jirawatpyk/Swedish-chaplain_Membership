/**
 * Unit tests for <EmailChangeRevertForm> — the FR-012b revert landing card.
 *
 * The card's copy must match the state the user is in:
 *   - success: the "click below to revert" description is gone (the button
 *     is gone too) and focus moves to the success region instead of <body>.
 *   - 400 invalid_token: the link can never succeed, so the revert button is
 *     replaced by a sign-in link.
 *   - 429: the button stays, disabled until the wait is over; 5xx: it stays
 *     so the user can retry; 409: nothing here can fix it, so only the alert.
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
    const note = screen.getByText(copy.description.replace('{hours}', '48')).closest('.aura-alert');
    expect(note).toHaveClass('aura-alert--warning');
    expect(note).toHaveTextContent(copy.warningTitle);
    // Static text: not a live region, so it is not read out as an alert on load.
    expect(note?.getAttribute('role') ?? 'none').toBe('none');
    expect(screen.getByRole('button', { name: copy.revert })).toHaveClass('aura-btn', 'aura-btn--danger');
    expect(screen.getByRole('link', { name: copy.madeThisChange })).toHaveAttribute('href', '/portal/sign-in');
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
    [429, copy.errors.rateLimited.replace('{seconds}', '30'), 'aura-alert--warning', true],
    [500, copy.errors.serverError, 'aura-alert--danger', false],
  ])('after a %i the revert button stays (disabled while a 429 waits)', async (status, message, tone, disabled) => {
    stubRevertResponse(status, {});
    renderForm();
    await clickRevert();

    expect(screen.getByText(message).closest('.aura-alert')).toHaveClass(tone);
    // What reverting does stays on screen beside the retry button.
    expect(screen.queryByText(copy.description.replace('{hours}', '48'))).not.toBeNull();
    const button = screen.getByRole('button', { name: copy.revert });
    if (disabled) expect(button).toBeDisabled();
    else expect(button).toBeEnabled();
  });

  it('after a 409 shows the alert alone: no retry can bring the old address back', async () => {
    stubRevertResponse(409, { error: 'conflict' });
    renderForm();
    await clickRevert();

    expect(screen.getByText(copy.errors.conflict).closest('.aura-alert')).toHaveClass('aura-alert--danger');
    expect(screen.queryByRole('button', { name: copy.revert })).toBeNull();
  });

  it('says how long the link works with the token TTL the members module issues it with', async () => {
    const { REVERT_LINK_HOURS } = await import('@/components/auth/email-change-revert-form');
    const { REVERT_TOKEN_TTL_MS } = await import('@/modules/members/application/crypto-helpers');
    expect(REVERT_LINK_HOURS * 60 * 60 * 1000).toBe(REVERT_TOKEN_TTL_MS);
  });
});

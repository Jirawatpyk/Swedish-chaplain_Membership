/**
 * Spec 122 US9c (T942) — the one-time secret reveal on AURA (Clarifications
 * 2026-10-09, US9c start). AURA has no secret field, so the value sits in
 * the page's value box with eye / eye-off and copy `IconButton`s, and the
 * "saved" gate is AURA `Checkbox` (a native checkbox with its hint as the
 * description).
 *
 * Unchanged (FR-011): the value is masked until revealed, copy writes the
 * plaintext secret, and Continue stays disabled until the box is ticked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

const toastMock = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

const { WebhookSecretReveal } = await import('@/components/events/webhook-secret-reveal');

const a = en.admin.integrations.eventcreate.phaseA;
const SECRET = 'whsec_abcdefghijklmnopqrstuvwx7f3a';

const writeText = vi.fn(() => Promise.resolve());
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function renderReveal(onContinue = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <WebhookSecretReveal secret={SECRET} secretLastFour="7f3a" onContinue={onContinue} />
    </NextIntlClientProvider>,
  );
  return onContinue;
}

describe('<WebhookSecretReveal> on AURA', () => {
  it('gates Continue on a native "saved" checkbox that carries the last-four hint', () => {
    const onContinue = renderReveal();
    const box = screen.getByRole('checkbox', { name: a.savedInPasswordManager });
    expect(box.tagName).toBe('INPUT');
    expect(box).toHaveAccessibleDescription(a.savedHint.replace('{lastFour}', '7f3a'));
    const cont = screen.getByRole('button', { name: a.continueToSetup });
    expect(cont).toBeDisabled();
    fireEvent.click(box);
    expect(cont).toBeEnabled();
    fireEvent.click(cont);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('masks the secret until revealed, then hides it again', () => {
    renderReveal();
    const value = screen.getByTestId('webhook-secret-value');
    expect(value).not.toHaveTextContent(SECRET);
    expect(value).toHaveTextContent(/•{20}7f3a/);
    fireEvent.click(screen.getByRole('button', { name: a.revealSecret }));
    expect(value).toHaveTextContent(SECRET);
    fireEvent.click(screen.getByRole('button', { name: a.hideSecret }));
    expect(value).not.toHaveTextContent(SECRET);
  });

  it('keeps its own group name when step 3 is behind it (the rotate dialog)', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <span id="webhook-secret-label">Current secret</span>
        <WebhookSecretReveal secret={SECRET} secretLastFour="7f3a" onContinue={vi.fn()} hideInternalContinue />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('group', { name: a.secretLabel })).toContainElement(
      screen.getByTestId('webhook-secret-value'),
    );
  });

  it('copies the plaintext secret', async () => {
    renderReveal();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: a.copySecret }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(SECRET);
    expect(toastMock.success).toHaveBeenCalledWith(a.copied);
  });
});

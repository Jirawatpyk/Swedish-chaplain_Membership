/**
 * Strength-bar reset on server rejection (UAT follow-up).
 *
 * Before: a client-"acceptable"/"strong" password that the server then
 * rejects (e.g. HIBP-breached) left the bar amber/green right next to a red
 * "breached" error — a visual contradiction. The forms now call
 * `markRejected(value)` from `usePasswordStrengthMeter`, pinning the bar to a
 * red "rejected" caption for that exact value and releasing it as soon as the
 * user edits. This exercises that wiring end-to-end through ChangePasswordForm
 * against the REAL en.json.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ChangePasswordForm } from '@/components/auth/change-password-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// tests/setup.ts installs global fake timers; RHF async validation + findBy
// polling need real timers to settle.
beforeEach(() => {
  vi.useRealTimers();
});

function setValue(root: ParentNode, id: string, value: string) {
  const input = root.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`missing #${id}`);
  fireEvent.change(input, { target: { value } });
}

describe('ChangePasswordForm strength-bar reset on server rejection', () => {
  it('flips the bar to a red "rejected" caption on reject, then recovers on edit', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'weak-password', issues: ['breached'] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ChangePasswordForm />
      </NextIntlClientProvider>,
    );

    // A client-"acceptable" password (14 chars, only lower+upper = 2 character
    // classes, so under the BUG-004 rule the bar starts amber, not green).
    setValue(container, 'current-password', 'current-secret');
    setValue(container, 'new-password', 'aBcDeFgHiJkLmN');
    setValue(container, 'confirm-password', 'aBcDeFgHiJkLmN');
    expect(screen.getByText('Acceptable strength.')).toBeTruthy();

    const form = container.querySelector('form');
    if (!form) throw new Error('change-password form did not render');
    fireEvent.submit(form);

    // Server says breached → the bar must agree (red, rejected caption), not
    // keep showing "Acceptable" beside the error.
    expect(
      await screen.findByText('Weak — choose a different password.'),
    ).toBeTruthy();
    expect(screen.queryByText('Acceptable strength.')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Editing the value releases the pin → the live estimate returns.
    setValue(container, 'new-password', 'aBcDeFgHiJkLmNo');
    await waitFor(() =>
      expect(screen.getByText('Acceptable strength.')).toBeTruthy(),
    );
    expect(
      screen.queryByText('Weak — choose a different password.'),
    ).toBeNull();

    vi.unstubAllGlobals();
  });
});

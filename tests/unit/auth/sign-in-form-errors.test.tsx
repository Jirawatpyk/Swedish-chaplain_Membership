/**
 * SignInForm — inline server-rejection banner + email keyboard (audit XF-01/XF-06).
 *
 * Every server rejection (account-disabled / locked / rate-limited /
 * invalid-credentials) surfaces in the inline root banner (role=alert),
 * associated with the focused email field — not a transient toast. The email
 * field uses inputmode=email. Rendered against real en.json.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { SignInForm } from '@/components/auth/sign-in-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) },
}));

beforeEach(() => {
  vi.useRealTimers();
  toastError.mockClear();
});

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SignInForm portal="staff" />
    </NextIntlClientProvider>,
  );
}

describe('SignInForm', () => {
  it('email field uses inputmode=email for the right mobile keyboard', () => {
    const { container } = renderForm();
    expect(container.querySelector('#email')?.getAttribute('inputmode')).toBe(
      'email',
    );
  });

  it('DOES mark the email field invalid for a malformed email (positive branch)', async () => {
    // Pins the other side of the aria-invalid restriction: a real email-FORMAT
    // error must set aria-invalid='true' + render #email-error (no server call).
    const { container } = renderForm();
    fireEvent.change(container.querySelector('#email')!, {
      target: { value: 'notanemail' },
    });
    fireEvent.change(container.querySelector('#password')!, {
      target: { value: 'some-password' },
    });
    fireEvent.submit(container.querySelector('form')!);

    await screen.findByText((_t, node) => node?.id === 'email-error');
    expect(container.querySelector('#email')?.getAttribute('aria-invalid')).toBe(
      'true',
    );
  });

  it('shows account-disabled inline in the root banner (not a toast), tied to email', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'account-disabled' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderForm();
    fireEvent.change(container.querySelector('#email')!, {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(container.querySelector('#password')!, {
      target: { value: 'some-password' },
    });
    fireEvent.submit(container.querySelector('form')!);

    const banner = await screen.findByText((_t, node) => node?.id === 'signin-error');
    expect(banner.getAttribute('role')).toBe('alert');
    // Email is associated with the banner so a focused SR user gets the reason.
    expect(
      container.querySelector('#email')?.getAttribute('aria-describedby') ?? '',
    ).toContain('signin-error');
    // …but a syntactically-valid email is NOT marked invalid for an account-state
    // rejection (aria-invalid is only for an actual email-format error).
    expect(
      container.querySelector('#email')?.getAttribute('aria-invalid'),
    ).not.toBe('true');
    expect(toastError).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

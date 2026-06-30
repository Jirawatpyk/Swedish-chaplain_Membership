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
    expect(toastError).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

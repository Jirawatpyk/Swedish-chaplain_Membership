/**
 * SignInForm renders LOCALIZED validation messages, never Zod's built-in
 * English defaults ("Invalid email", "String must contain …").
 *
 * Regression guard for the 2026-06-20 raw-Zod-leak sweep. Critically this
 * renders with the REAL `en.json` via NextIntlClientProvider (NOT a mocked
 * `useTranslations`) so a missing `shared.validation.*` key fails loudly —
 * the existing form tests mock next-intl and therefore cannot catch a
 * MISSING_MESSAGE the way a user's browser would.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { SignInForm } from '@/components/auth/sign-in-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// tests/setup.ts installs global fake timers (for deterministic Date);
// react-hook-form's async validation + Testing Library's findBy polling
// need real timers to settle.
beforeEach(() => {
  vi.useRealTimers();
});

function renderSignIn() {
  const utils = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SignInForm portal="staff" />
    </NextIntlClientProvider>,
  );
  const form = utils.container.querySelector('form');
  if (!form) throw new Error('sign-in form did not render');
  return { ...utils, form };
}

// The Zod defaults that used to leak into every locale.
const RAW_ZOD_DEFAULTS = [/String must contain/i, /^Invalid email$/i];

describe('SignInForm i18n validation messages', () => {
  it('empty submit → localized required + invalid-email (never raw Zod)', async () => {
    const { form } = renderSignIn();
    fireEvent.submit(form);

    // email '' fails .email() → shared.validation.invalidEmail
    expect(
      await screen.findByText('Please enter a valid email address.'),
    ).toBeTruthy();
    // password '' fails .min(1) → shared.validation.required
    expect(await screen.findByText('This field is required.')).toBeTruthy();

    for (const pattern of RAW_ZOD_DEFAULTS) {
      expect(screen.queryByText(pattern)).toBeNull();
    }
  });

  it('over-long password → {max}-interpolated tooLong message', async () => {
    const { form } = renderSignIn();
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'a'.repeat(257) },
    });
    fireEvent.submit(form);

    expect(
      await screen.findByText('Please use 256 characters or fewer.'),
    ).toBeTruthy();
  });
});

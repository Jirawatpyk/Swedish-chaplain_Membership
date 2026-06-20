/**
 * change-password (and the other password-pair forms) resolve
 * shared.validation keys EAGERLY in the component body — straight into
 * buildSchema(...) → zodResolver, with no useMemo — so a missing key
 * would MISSING_MESSAGE on first render in that locale. Render against
 * the REAL en.json and assert the localized message appears on submit,
 * guarding the eager tv('required') path the mocked-next-intl tests
 * cannot see.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ChangePasswordForm } from '@/components/auth/change-password-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// tests/setup.ts installs global fake timers; RHF async validation + the
// findBy polling need real timers to settle.
beforeEach(() => {
  vi.useRealTimers();
});

describe('ChangePasswordForm eager i18n validation', () => {
  it('empty submit → localized required (never raw Zod)', async () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ChangePasswordForm />
      </NextIntlClientProvider>,
    );
    const form = container.querySelector('form');
    if (!form) throw new Error('change-password form did not render');
    fireEvent.submit(form);

    // currentPassword '' fails .min(1, tv('required')) — proves the eager
    // shared.validation.required key resolves to real localized text.
    expect(await screen.findByText('This field is required.')).toBeTruthy();
    expect(screen.queryByText(/String must contain/i)).toBeNull();
  });
});

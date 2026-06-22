/**
 * Security regression guard (CWE-598) — credential-bearing auth forms MUST
 * declare `method="post"` on the <form> element.
 *
 * These forms submit via a client `onSubmit` → `fetch()` handler that only
 * runs once React has hydrated. If a user clicks submit BEFORE hydration
 * (slow device, large bundle, a hydration error earlier in the tree), the
 * browser performs the NATIVE form submission. With the HTML default
 * `method="get"` that native submit serialises every field — including the
 * password — into the URL query string:
 *
 *     GET /admin/sign-in?email=victim@example.com&password=Sup3rSecret
 *
 * …which then leaks into browser history, server access logs, and Referer
 * headers. Declaring `method="post"` moves any native fallback into the
 * request BODY (discarded by the page route), closing the leak. When
 * hydrated, react-hook-form's `handleSubmit` calls `preventDefault()`, so
 * the attribute is inert — zero behaviour change in the normal path.
 *
 * Root-caused 2026-06-22 (sign-in form native GET fallback observed during
 * the F7 verify sweep).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { SignInForm } from '@/components/auth/sign-in-form';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';
import { ChangePasswordForm } from '@/components/auth/change-password-form';
import { InviteRedeemForm } from '@/components/auth/invite-redeem-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// tests/setup.ts installs global fake timers; RHF + RTL need real timers.
beforeEach(() => {
  vi.useRealTimers();
});

function formOf(ui: React.ReactElement): HTMLFormElement {
  const { container } = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
  const form = container.querySelector('form');
  if (!form) throw new Error('form did not render');
  return form;
}

describe('credential-bearing auth forms declare method="post" (CWE-598)', () => {
  it('SignInForm posts (never GETs credentials into the URL)', () => {
    expect(formOf(<SignInForm portal="staff" />).getAttribute('method')).toBe(
      'post',
    );
  });

  it('ResetPasswordForm posts (never GETs the new password into the URL)', () => {
    expect(
      formOf(<ResetPasswordForm token="tok_test" />).getAttribute('method'),
    ).toBe('post');
  });

  it('ChangePasswordForm posts (never GETs current/new password into the URL)', () => {
    expect(formOf(<ChangePasswordForm />).getAttribute('method')).toBe('post');
  });

  it('InviteRedeemForm posts (never GETs the new account password into the URL)', () => {
    expect(
      formOf(
        <InviteRedeemForm token="tok_test" email="invitee@example.com" />,
      ).getAttribute('method'),
    ).toBe('post');
  });
});

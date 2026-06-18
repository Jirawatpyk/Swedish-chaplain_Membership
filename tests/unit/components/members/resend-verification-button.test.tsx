// tests/unit/components/members/resend-verification-button.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { toast } from 'sonner';
import { ResendVerificationButton } from '@/components/members/resend-verification-button';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function renderButton() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ResendVerificationButton memberId="m1" contactId="c1" />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  // Real timers required: global setup.ts enables fake timers (setTimeout faked);
  // waitFor() + Promise resolution needs real timers. Same pattern as portal-sign-out-button.test.tsx.
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.useFakeTimers();
});

describe('ResendVerificationButton', () => {
  it('posts and toasts success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /Re-send verification email/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Verification email re-sent.'));
  });

  it('toasts emailVerified on 409 not_eligible/email_verified', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 409, json: async () => ({ error: 'not_eligible', reason: 'email_verified' }),
    } as unknown as Response);
    renderButton();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This email has already been verified.'));
  });

  it('toasts notFound on flat 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 404, json: async () => ({ error: 'not_found' }),
    } as unknown as Response);
    renderButton();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Contact not found.'));
  });

  it('toasts rateLimited on 429', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 429, json: async () => ({ error: 'rate_limited' }),
    } as unknown as Response);
    renderButton();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(en.admin.members.detail.resendVerification.errors.rateLimited));
  });

  it('toasts serverError on 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 500, json: async () => ({ error: 'server_error' }),
    } as unknown as Response);
    renderButton();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Something went wrong. Please try again.'));
  });

  it('toasts noLinkedUser on 409 not_eligible/no_linked_user', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 409, json: async () => ({ error: 'not_eligible', reason: 'no_linked_user' }),
    } as unknown as Response);
    renderButton();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(en.admin.members.detail.resendVerification.errors.noLinkedUser));
  });
});

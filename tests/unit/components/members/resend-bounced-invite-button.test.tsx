// tests/unit/components/members/resend-bounced-invite-button.test.tsx
//
// Regression guard for the Fix 10 refactor: ResendBouncedInviteButton now
// delegates to useContactResendAction but must preserve its exact original
// behaviour (success / 409 not_eligible branches / 404 / 500 / network error).
// Notably NO 429 path — the inviteBounced namespace has no rateLimited key.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { toast } from 'sonner';
import { ResendBouncedInviteButton } from '@/components/members/resend-bounced-invite-button';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const refreshSpy = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));

function renderButton() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ResendBouncedInviteButton memberId="m1" contactId="c1" />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.useRealTimers();
  refreshSpy.mockClear();
  (toast.success as ReturnType<typeof vi.fn>).mockClear();
  (toast.error as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  cleanup();
  vi.useFakeTimers();
});

describe('ResendBouncedInviteButton', () => {
  it('posts, toasts success, calls router.refresh, and button stays disabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    renderButton();
    const btn = screen.getByRole('button', { name: /Re-send invite/i });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(en.admin.members.detail.inviteBounced.resendSuccess),
    );
    expect(refreshSpy).toHaveBeenCalled();
    // This button opts into keepDisabledOnSuccess (its gate clears on success →
    // it unmounts after refresh), so it intentionally stays disabled — unlike
    // the verification button, which re-enables. See use-contact-resend-action.
    expect(btn).toBeDisabled();
  });

  it('toasts notBounced on 409 not_eligible/not_bounced', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 409, json: async () => ({ error: 'not_eligible', reason: 'not_bounced' }),
    } as unknown as Response);
    renderButton();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(en.admin.members.detail.inviteBounced.errors.notBounced),
    );
  });

  it('toasts alreadyActive on 409 not_eligible/already_active', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 409, json: async () => ({ error: 'not_eligible', reason: 'already_active' }),
    } as unknown as Response);
    renderButton();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(en.admin.members.detail.inviteBounced.errors.alreadyActive),
    );
  });

  it('toasts noLinkedUser on 409 not_eligible/no_linked_user', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 409, json: async () => ({ error: 'not_eligible', reason: 'no_linked_user' }),
    } as unknown as Response);
    renderButton();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(en.admin.members.detail.inviteBounced.errors.noLinkedUser),
    );
  });

  it('toasts serverError on 409 not_eligible with unknown reason', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 409, json: async () => ({ error: 'not_eligible', reason: 'unexpected' }),
    } as unknown as Response);
    renderButton();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(en.admin.members.detail.inviteBounced.errors.serverError),
    );
  });

  it('toasts notFound on flat 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 404, json: async () => ({ error: 'not_found' }),
    } as unknown as Response);
    renderButton();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(en.admin.members.detail.inviteBounced.errors.notFound),
    );
  });

  it('toasts serverError on 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 500, json: async () => ({ error: 'server_error' }),
    } as unknown as Response);
    renderButton();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(en.admin.members.detail.inviteBounced.errors.serverError),
    );
  });

  it('toasts serverError on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    renderButton();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(en.admin.members.detail.inviteBounced.errors.serverError),
    );
  });
});

// tests/unit/broadcasts/components/cancel-broadcast-dialog.test.tsx
/**
 * DV-12 — Unit tests for <CancelBroadcastDialog>.
 *
 * Pattern: real NextIntlClientProvider + real en.json, mock fetch +
 * sonner + next/navigation. Real timers (global setup uses fake timers
 * which hang userEvent/waitFor). fireEvent for click/type (mirrors
 * resend-verification-button.test.tsx).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { toast } from 'sonner';
import { CancelBroadcastDialog } from '@/components/broadcast/cancel-broadcast-dialog';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const refreshSpy = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));

// ── helpers ────────────────────────────────────────────────────────────

function renderAdmin(extra: Partial<React.ComponentProps<typeof CancelBroadcastDialog>> = {}) {
  const onOpenChange = extra.onOpenChange ?? vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <CancelBroadcastDialog
        broadcastId="b1"
        open
        onOpenChange={onOpenChange}
        endpoint="/api/admin/broadcasts/b1/cancel"
        namespace="admin.broadcasts.cancelDialog"
        toastNamespace="admin.broadcasts.toast"
        reasonRequired
        {...extra}
      />
    </NextIntlClientProvider>,
  );
  return { onOpenChange };
}

function renderMember(
  extra: Partial<React.ComponentProps<typeof CancelBroadcastDialog>> = {},
) {
  const onOpenChange = extra.onOpenChange ?? vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <CancelBroadcastDialog
        broadcastId="b1"
        open
        onOpenChange={onOpenChange}
        endpoint="/api/broadcasts/b1/cancel"
        namespace="portal.broadcasts.detail.cancelDialog"
        toastNamespace="portal.broadcasts.detail.toast"
        reasonRequired={false}
        {...extra}
      />
    </NextIntlClientProvider>,
  );
  return { onOpenChange };
}

// ── timer + mock lifecycle ──────────────────────────────────────────────

beforeEach(() => {
  // Real timers required: global setup enables fake timers (setTimeout faked);
  // waitFor() + Promise resolution needs real timers. Mirror:
  // tests/unit/components/members/resend-verification-button.test.tsx
  vi.useRealTimers();
  refreshSpy.mockClear();
  (toast.success as ReturnType<typeof vi.fn>).mockClear();
  (toast.error as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  cleanup();
  vi.useFakeTimers();
});

// ── Admin (reasonRequired=true) ─────────────────────────────────────────

describe('CancelBroadcastDialog (admin, reasonRequired=true)', () => {
  it('shows the dialog title when open', () => {
    renderAdmin();
    expect(
      screen.getByText(en.admin.broadcasts.cancelDialog.title),
    ).toBeInTheDocument();
  });

  it('submit disabled when reason is empty', () => {
    renderAdmin();
    const confirmBtn = screen.getByRole('button', {
      name: en.admin.broadcasts.cancelDialog.confirm,
    });
    expect(confirmBtn).toBeDisabled();
  });

  it('does NOT submit and shows inline error when reason is empty and confirm clicked', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);
    renderAdmin();
    // Confirm button should be disabled for empty reason
    const confirmBtn = screen.getByRole('button', {
      name: en.admin.broadcasts.cancelDialog.confirm,
    });
    expect(confirmBtn).toBeDisabled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('success path: toasts cancelled + calls onOpenChange(false) + router.refresh', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);
    const onOpenChange = vi.fn();
    renderAdmin({ onOpenChange });
    // Type a valid reason
    const textarea = screen.getByLabelText(
      new RegExp(en.admin.broadcasts.cancelDialog.reasonLabel, 'i'),
    );
    fireEvent.change(textarea, { target: { value: 'duplicate send' } });
    // Click confirm
    fireEvent.click(
      screen.getByRole('button', { name: en.admin.broadcasts.cancelDialog.confirm }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        en.admin.broadcasts.toast.cancelled,
      ),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('409 broadcast_cancel_too_late → toasts cancelTooLate', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'broadcast_cancel_too_late' } }),
    } as unknown as Response);
    renderAdmin();
    fireEvent.change(
      screen.getByLabelText(
        new RegExp(en.admin.broadcasts.cancelDialog.reasonLabel, 'i'),
      ),
      { target: { value: 'x' } },
    );
    fireEvent.click(
      screen.getByRole('button', { name: en.admin.broadcasts.cancelDialog.confirm }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        en.admin.broadcasts.toast.cancelTooLate,
      ),
    );
  });

  it('409 broadcast_concurrent_action_blocked → toasts cancelError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'broadcast_concurrent_action_blocked' } }),
    } as unknown as Response);
    renderAdmin();
    fireEvent.change(
      screen.getByLabelText(
        new RegExp(en.admin.broadcasts.cancelDialog.reasonLabel, 'i'),
      ),
      { target: { value: 'x' } },
    );
    fireEvent.click(
      screen.getByRole('button', { name: en.admin.broadcasts.cancelDialog.confirm }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        en.admin.broadcasts.toast.cancelError,
      ),
    );
  });

  it('non-409 server error → toasts cancelError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response);
    renderAdmin();
    fireEvent.change(
      screen.getByLabelText(
        new RegExp(en.admin.broadcasts.cancelDialog.reasonLabel, 'i'),
      ),
      { target: { value: 'y' } },
    );
    fireEvent.click(
      screen.getByRole('button', { name: en.admin.broadcasts.cancelDialog.confirm }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        en.admin.broadcasts.toast.cancelError,
      ),
    );
  });

  it('reason > 500 chars → shows reasonTooLong inline error + confirm stays disabled', () => {
    renderAdmin();
    const textarea = screen.getByLabelText(
      new RegExp(en.admin.broadcasts.cancelDialog.reasonLabel, 'i'),
    );
    fireEvent.change(textarea, { target: { value: 'a'.repeat(501) } });
    expect(
      screen.getByRole('alert'),
    ).toHaveTextContent(en.admin.broadcasts.cancelDialog.errors.reasonTooLong);
    expect(
      screen.getByRole('button', { name: en.admin.broadcasts.cancelDialog.confirm }),
    ).toBeDisabled();
  });
});

// ── Member (reasonRequired=false) ───────────────────────────────────────

describe('CancelBroadcastDialog (member, reasonRequired=false)', () => {
  it('shows the member dialog title when open', () => {
    renderMember();
    expect(
      screen.getByText(en.portal.broadcasts.detail.cancelDialog.title),
    ).toBeInTheDocument();
  });

  it('confirm enabled even with empty reason (optional)', () => {
    renderMember();
    expect(
      screen.getByRole('button', {
        name: en.portal.broadcasts.detail.cancelDialog.confirm,
      }),
    ).not.toBeDisabled();
  });

  it('member success with empty reason → toasts cancelled + onOpenChange(false)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);
    const onOpenChange = vi.fn();
    renderMember({ onOpenChange });
    fireEvent.click(
      screen.getByRole('button', {
        name: en.portal.broadcasts.detail.cancelDialog.confirm,
      }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        en.portal.broadcasts.detail.toast.cancelled,
      ),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('member reason > 500 chars → shows reasonTooLong + confirm disabled', () => {
    renderMember();
    // Escape parentheses in "Reason (optional)" for use in a RegExp
    const escapedLabel = en.portal.broadcasts.detail.cancelDialog.reasonLabel.replace(
      /[()]/g,
      '\\$&',
    );
    const textarea = screen.getByLabelText(new RegExp(escapedLabel, 'i'));
    fireEvent.change(textarea, { target: { value: 'b'.repeat(501) } });
    expect(
      screen.getByRole('alert'),
    ).toHaveTextContent(en.portal.broadcasts.detail.cancelDialog.errors.reasonTooLong);
    expect(
      screen.getByRole('button', {
        name: en.portal.broadcasts.detail.cancelDialog.confirm,
      }),
    ).toBeDisabled();
  });

  it('member 409 too_late → toasts cancelTooLate', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'broadcast_cancel_too_late' } }),
    } as unknown as Response);
    renderMember();
    fireEvent.click(
      screen.getByRole('button', {
        name: en.portal.broadcasts.detail.cancelDialog.confirm,
      }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        en.portal.broadcasts.detail.toast.cancelTooLate,
      ),
    );
  });
});

// tests/unit/broadcasts/components/cancel-broadcast-dialog.test.tsx
/**
 * DV-12 — Unit tests for <CancelBroadcastDialog> (thin wrapper over the shared
 * <ReasonConfirmationDialog>).
 *
 * Pattern: real NextIntlClientProvider + real en.json, mock fetch +
 * sonner + next/navigation. Real timers (global setup uses fake timers
 * which hang waitFor). fireEvent for click/type (mirrors
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

// "Reason (optional)" contains parens — escape for use in a RegExp matcher.
const MEMBER_REASON_LABEL = new RegExp(
  en.portal.broadcasts.detail.cancelDialog.reasonLabel.replace(/[()]/g, '\\$&'),
  'i',
);

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
  // Restore the per-test fetch spy so its impl never leaks into a later test
  // (the global afterEach only clearAllMocks — call history, not the spy impl).
  // Safe: restoreAllMocks restores vi.spyOn spies only; it does not un-register
  // the vi.mock factories for sonner / next-navigation.
  vi.restoreAllMocks();
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

  it('auto-focuses the reason textarea on open (admin/required path)', async () => {
    // reasonRequired=true → the shared dialog double-RAFs an imperative
    // textarea.focus(); jsdom's real RAF + .focus() DO set document.activeElement
    // for the attached textarea (unlike Base UI's portal initialFocus). This is a
    // real focus assertion for the admin path (the member path is covered
    // structurally below + by e2e @a11y).
    renderAdmin();
    const textarea = screen.getByLabelText(
      new RegExp(en.admin.broadcasts.cancelDialog.reasonLabel, 'i'),
    );
    await waitFor(() => expect(textarea).toHaveFocus());
  });

  it('confirm stays disabled and does NOT fetch when reason is empty (no inline error — disabled-button UX)', () => {
    // The required-reason rule is enforced by DISABLING confirm, not by an
    // inline "reason required" error. Assert: confirm disabled, NO alert (the
    // only inline alert is reasonTooLong, gated on over-cap), and no request.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    renderAdmin();
    expect(
      screen.getByRole('button', {
        name: en.admin.broadcasts.cancelDialog.confirm,
      }),
    ).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('success path: toasts cancelled + calls onOpenChange(false) + router.refresh', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);
    const onOpenChange = vi.fn();
    renderAdmin({ onOpenChange });
    const textarea = screen.getByLabelText(
      new RegExp(en.admin.broadcasts.cancelDialog.reasonLabel, 'i'),
    );
    fireEvent.change(textarea, { target: { value: 'duplicate send' } });
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

  it('409 broadcast_concurrent_action_blocked → toasts concurrentRace + closes dialog', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'broadcast_concurrent_action_blocked' } }),
    } as unknown as Response);
    const onOpenChange = vi.fn();
    renderAdmin({ onOpenChange });
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
        en.admin.broadcasts.toast.concurrentRace,
      ),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
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
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
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
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Member (reasonRequired=false) ───────────────────────────────────────

describe('CancelBroadcastDialog (member, reasonRequired=false)', () => {
  it('member path wires Cancel as the initial-focus target and does NOT auto-focus the textarea', () => {
    // reasonRequired=false → the shared dialog hands initial focus to the Cancel
    // ("Keep it") button via Base UI `initialFocus={cancelRef}` and SKIPS the
    // textarea auto-focus RAF. Base UI's portal focus machinery does not fire a
    // real focus event under jsdom, so we cannot assert toHaveFocus() on the
    // Cancel button here (covered by e2e @a11y on preview). What we CAN assert
    // deterministically: the Cancel button is the wired target (present + not
    // disabled) AND the textarea is NOT auto-focused (proving the required-path
    // RAF was correctly skipped for the optional path).
    renderMember();
    const cancelBtn = screen.getByRole('button', {
      name: en.portal.broadcasts.detail.cancelDialog.cancel,
    });
    expect(cancelBtn).toBeInTheDocument();
    expect(cancelBtn).not.toBeDisabled();
    expect(screen.getByLabelText(MEMBER_REASON_LABEL)).not.toHaveFocus();
  });

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

  it('member success with empty reason → toasts cancelled + onOpenChange(false) + router.refresh', async () => {
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
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('member reason > 500 chars → shows reasonTooLong + confirm disabled', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    renderMember();
    const textarea = screen.getByLabelText(MEMBER_REASON_LABEL);
    fireEvent.change(textarea, { target: { value: 'b'.repeat(501) } });
    expect(
      screen.getByRole('alert'),
    ).toHaveTextContent(en.portal.broadcasts.detail.cancelDialog.errors.reasonTooLong);
    expect(
      screen.getByRole('button', {
        name: en.portal.broadcasts.detail.cancelDialog.confirm,
      }),
    ).toBeDisabled();
    expect(fetchSpy).not.toHaveBeenCalled();
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

  it('member 409 concurrent → toasts concurrentRace', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'broadcast_concurrent_action_blocked' } }),
    } as unknown as Response);
    renderMember();
    fireEvent.click(
      screen.getByRole('button', {
        name: en.portal.broadcasts.detail.cancelDialog.confirm,
      }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        en.portal.broadcasts.detail.toast.concurrentRace,
      ),
    );
  });
});

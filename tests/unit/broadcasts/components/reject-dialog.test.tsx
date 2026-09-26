// tests/unit/broadcasts/components/reject-dialog.test.tsx
/**
 * Render-level coverage for <RejectDialog> after it became a thin wrapper over
 * the shared <ReasonConfirmationDialog> (DV-12 fix-wave #11). Pins reject's
 * production wire contract that the source-grep guard (approve-reject-final-focus)
 * cannot: the 2000-char cap branch of the shared dialog, the VERBATIM/untrimmed
 * reason in the POST body, the /reject endpoint, the 409 split (sending_started →
 * rejectTooLate, other → concurrentRace), and the 429 / 5xx / network refusals said
 * inside the open dialog.
 *
 * Pattern mirrors cancel-broadcast-dialog.test.tsx: real NextIntlClientProvider
 * + real en.json; mock fetch/sonner/next-navigation; real timers (global setup
 * fakes them); fireEvent (userEvent hangs under fake timers).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { toast } from '@/lib/toast';
import { RejectDialog } from '@/components/broadcast/admin/reject-dialog';

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const refreshSpy = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));

const RD = en.admin.broadcasts.rejectDialog;
const TOAST = en.admin.broadcasts.toast;
const reasonLabel = new RegExp(RD.reasonLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

function renderReject(broadcastId = 'b1', onOpenChange = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <RejectDialog broadcastId={broadcastId} open onOpenChange={onOpenChange} />
    </NextIntlClientProvider>,
  );
  return { onOpenChange };
}

beforeEach(() => {
  vi.useRealTimers();
  refreshSpy.mockClear();
  (toast.success as ReturnType<typeof vi.fn>).mockClear();
  (toast.error as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useFakeTimers();
});

describe('RejectDialog (thin wrapper over ReasonConfirmationDialog)', () => {
  it('shows the dialog title when open', () => {
    renderReject();
    expect(screen.getByText(RD.title)).toBeInTheDocument();
  });

  it('confirm disabled when reason is empty (required)', () => {
    renderReject();
    expect(screen.getByRole('button', { name: RD.confirm })).toBeDisabled();
  });

  it('success: POSTs verbatim reason to /reject, toasts rejected, closes + refreshes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);
    const onOpenChange = vi.fn();
    renderReject('broadcast-r1', onOpenChange);

    // Leading/trailing space proves the body is sent UNtrimmed (member sees it verbatim).
    fireEvent.change(screen.getByLabelText(reasonLabel), {
      target: { value: '  off-topic for the audience  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: RD.confirm }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/admin/broadcasts/broadcast-r1/reject',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ rejectionReason: '  off-topic for the audience  ' }),
        }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith(TOAST.rejected);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('reason > 2000 chars → reasonTooLong alert + confirm disabled + no fetch', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    renderReject();
    fireEvent.change(screen.getByLabelText(reasonLabel), {
      target: { value: 'a'.repeat(2001) },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(RD.errors.reasonTooLong);
    expect(screen.getByRole('button', { name: RD.confirm })).toBeDisabled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a reason at the 2000 cap is allowed (boundary) — confirm enabled', () => {
    renderReject();
    fireEvent.change(screen.getByLabelText(reasonLabel), {
      target: { value: 'a'.repeat(2000) },
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: RD.confirm })).not.toBeDisabled();
  });

  it('any other 409 → toasts concurrentRace + closes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'broadcast_concurrent_action_blocked' } }),
    } as unknown as Response);
    const onOpenChange = vi.fn();
    renderReject('b1', onOpenChange);
    fireEvent.change(screen.getByLabelText(reasonLabel), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: RD.confirm }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(TOAST.concurrentRace),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // F119 round-2 finding 4 — T081 widened reject into stages where the send
  // may already have begun; the route answers 409 `sending_started` there.
  // That is "too late", not someone else's edit, so it must not read as
  // concurrentRace. Closes FIRST, then toasts (cancel dialog's order).
  it('409 sending_started → toasts rejectTooLate (not concurrentRace), closes + refreshes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'sending_started' } }),
    } as unknown as Response);
    const onOpenChange = vi.fn();
    renderReject('b1', onOpenChange);
    fireEvent.change(screen.getByLabelText(reasonLabel), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: RD.confirm }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(TOAST.rejectTooLate));
    expect(toast.error).not.toHaveBeenCalledWith(TOAST.concurrentRace);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(refreshSpy).toHaveBeenCalled();
  });

  // The staff write bucket (30 / 60 s) answers 429. The dialog stays open for
  // a retry, so the refusal is said INSIDE it (role="alert") — a toast would
  // render behind the modal — and the typed reason is kept.
  it('429 → rate-limit refusal inside the open dialog, no toast, reason kept', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { code: 'broadcast_rate_limit_exceeded' } }),
    } as unknown as Response);
    const onOpenChange = vi.fn();
    renderReject('b1', onOpenChange);
    fireEvent.change(screen.getByLabelText(reasonLabel), { target: { value: 'keep me' } });
    fireEvent.click(screen.getByRole('button', { name: RD.confirm }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        en.admin.broadcasts.approval.errors.broadcast_rate_limit_exceeded,
      ),
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByLabelText(reasonLabel)).toHaveValue('keep me');
  });

  it('non-ok non-409 (5xx) → error said inside the open dialog, no toast (retry)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response);
    const onOpenChange = vi.fn();
    renderReject('b1', onOpenChange);
    fireEvent.change(screen.getByLabelText(reasonLabel), { target: { value: 'y' } });
    fireEvent.click(screen.getByRole('button', { name: RD.confirm }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(TOAST.error));
    expect(toast.error).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('network throw → error said inside the open dialog, no toast (retry)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network'));
    const onOpenChange = vi.fn();
    renderReject('b1', onOpenChange);
    fireEvent.change(screen.getByLabelText(reasonLabel), { target: { value: 'z' } });
    fireEvent.click(screen.getByRole('button', { name: RD.confirm }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(TOAST.error));
    expect(toast.error).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

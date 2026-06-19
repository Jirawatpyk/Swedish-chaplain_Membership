// tests/unit/broadcasts/components/reject-dialog.test.tsx
/**
 * Render-level coverage for <RejectDialog> after it became a thin wrapper over
 * the shared <ReasonConfirmationDialog> (DV-12 fix-wave #11). Pins reject's
 * production wire contract that the source-grep guard (approve-reject-final-focus)
 * cannot: the 2000-char cap branch of the shared dialog, the VERBATIM/untrimmed
 * reason in the POST body, the /reject endpoint, and the 409 → concurrentRace map.
 *
 * Pattern mirrors cancel-broadcast-dialog.test.tsx: real NextIntlClientProvider
 * + real en.json; mock fetch/sonner/next-navigation; real timers (global setup
 * fakes them); fireEvent (userEvent hangs under fake timers).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { toast } from 'sonner';
import { RejectDialog } from '@/components/broadcast/admin/reject-dialog';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

  it('any 409 → toasts concurrentRace + closes', async () => {
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

  it('non-ok non-409 → toasts error + stays open (retry)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response);
    const onOpenChange = vi.fn();
    renderReject('b1', onOpenChange);
    fireEvent.change(screen.getByLabelText(reasonLabel), { target: { value: 'y' } });
    fireEvent.click(screen.getByRole('button', { name: RD.confirm }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(TOAST.error));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

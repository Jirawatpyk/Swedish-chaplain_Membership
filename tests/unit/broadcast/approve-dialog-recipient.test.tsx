/**
 * Task 6 (2026-08-01-broadcast-review-queue-pr1) — single-approve dialog
 * shows the recipient count so an admin sees who a broadcast reaches
 * before approving. `recipientCount` is an optional prop threaded from
 * `EnrichedQueueRow` through `ReviewActions` into `ApproveDialog`;
 * absent it, the dialog renders exactly as before (no recipient line).
 *
 * `ApproveDialog` calls `useRouter()` (unused on this path, but required
 * at module scope) — established idiom:
 * tests/unit/app/admin/renewals/tier-upgrade-queue.test.tsx:21-23.
 *
 * Rendered under a real `NextIntlClientProvider` backed by canonical
 * `en.json` so the ICU-plural `recipientCount` key is exercised for
 * real, not an echo mock.
 *
 * Task 5 (2026-08-02-broadcast-review-queue-pr3) — the "send-now Undo
 * toast" describe block below extends this same suite (per the task
 * brief's verify command, which names THIS file rather than a new one)
 * with the `sonner` mock + fetch stubbing the recipient-count tests
 * above don't need. `toast` here is mocked as a callable function WITH
 * `.success`/`.error` attached — mirroring real `sonner`'s shape — since
 * `ApproveDialog` calls both the bare `toast(...)` (the new Undo toast)
 * and `toast.success(...)`/`toast.error(...)` (the pre-existing outcome
 * toasts).
 */
import { describe, expect, it, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ApproveDialog } from '@/components/broadcast/admin/approve-dialog';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const toastFn = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastWarning = vi.fn();
vi.mock('sonner', () => ({
  toast: Object.assign(
    (...a: unknown[]) => toastFn(...a),
    {
      success: (...a: unknown[]) => toastSuccess(...a),
      error: (...a: unknown[]) => toastError(...a),
      warning: (...a: unknown[]) => toastWarning(...a),
    },
  ),
}));

// Base UI Radio (the send-now/schedule choice) dispatches via PointerEvent,
// which jsdom does not implement — polyfill copied from
// tests/unit/broadcast/queue-bulk-action-bar.test.tsx.
beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, params?: PointerEventInit) {
        super(type, params);
        this.pointerId = params?.pointerId ?? 0;
      }
    };
  }
});

beforeEach(() => {
  // Shared test setup installs fake timers globally — the Undo describe
  // block below awaits real fetch/toast microtasks via `waitFor`, which
  // would otherwise spin to the 30s test timeout. Precedent:
  // `queue-bulk-action-bar.test.tsx`.
  vi.useRealTimers();
  toastFn.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
  toastWarning.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ApproveDialog recipient count', () => {
  it('shows the recipient count when provided', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ApproveDialog broadcastId="b1" open onOpenChange={() => {}} recipientCount={12} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(/Reaches ~12 recipients/)).toBeInTheDocument();
  });

  it('omits the recipient line when recipientCount is not provided', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ApproveDialog broadcastId="b1" open onOpenChange={() => {}} />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByText(/Reaches ~/)).not.toBeInTheDocument();
  });
});

/** Stubs `fetch` for both the approve endpoint (this dialog) and the
 * cancel endpoint (the Undo action's `cancelApprovedBroadcasts` call),
 * routed by URL suffix. */
function stubApproveAndCancelFetch(): ReturnType<
  typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>
> {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith('/approve')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (String(url).endsWith('/cancel')) {
      return new Response(JSON.stringify({ status: 'cancelled' }), {
        status: 200,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('ApproveDialog — send-now Undo toast (Task 5, 2026-08-02-broadcast-review-queue-pr3)', () => {
  it('a single send-now success shows an Undo toast whose action cancels that broadcast', async () => {
    const fetchMock = stubApproveAndCancelFetch();

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ApproveDialog broadcastId="b1" open onOpenChange={() => {}} />
      </NextIntlClientProvider>,
    );

    // Default decision is 'send_now' — no radio interaction needed.
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    // The pre-existing outcome toast still fires.
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Broadcast approved.'),
    );
    // The NEW bare `toast(...)` call is the Undo toast, shown IN ADDITION.
    expect(toastFn).toHaveBeenCalledTimes(1);
    const [message, opts] = toastFn.mock.calls[0] as [
      string,
      { duration?: number; action?: { label: string; onClick: () => Promise<void> } },
    ];
    expect(message).toBe('Sending 1 broadcast in 60s.');
    expect(opts.duration).toBe(60_000);
    expect(opts.action?.label).toBe('Undo');

    await opts.action!.onClick();

    const cancelCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/cancel'),
    );
    expect(cancelCall).toBeDefined();
    const [cancelUrl, cancelInit] = cancelCall!;
    expect(cancelUrl).toBe('/api/admin/broadcasts/b1/cancel');
    expect(JSON.parse(cancelInit!.body as string)).toEqual({
      cancellationReason: 'Undone by admin from the review queue',
    });
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Cancelled 1 broadcast.'),
    );
  });

  // Task 3 (2026-08-05-broadcast-crosspr-hotfix, opus audit re-confirm) — the
  // Undo `onClick` handler here is duplicated verbatim from the bulk bar
  // (module docstring: "same 60s send-now Undo toast as the bulk bar,
  // reusing its i18n namespace verbatim") and has the SAME untested
  // tooLate/failed branches. The single-approve path only ever sends ONE
  // id, so the most important race to cover here is tooLate (the cron
  // already dispatched before the admin clicked Undo) — a bare "some toast
  // fired" assertion would pass even if `toast.warning` were swapped for
  // `toast.success` or deleted entirely, so this asserts the SPECIFIC
  // method + real ICU-resolved copy, and that success/error did NOT also
  // fire for this outcome.
  it('a single send-now Undo that races the dispatch cron (409 too-late) shows toast.warning with the tooLate copy — NOT toast.success', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/approve')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (String(url).endsWith('/cancel')) {
        return new Response(
          JSON.stringify({ error: { code: 'broadcast_cancel_too_late' } }),
          { status: 409 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ApproveDialog broadcastId="b1" open onOpenChange={() => {}} />
      </NextIntlClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Broadcast approved.'),
    );
    expect(toastFn).toHaveBeenCalledTimes(1);
    const [, opts] = toastFn.mock.calls[0] as [
      string,
      { action?: { onClick: () => Promise<void> } },
    ];
    const successCallsBeforeUndo = toastSuccess.mock.calls.length;

    await opts.action!.onClick();

    await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1));
    expect(toastWarning).toHaveBeenCalledWith(
      'Already sending — too late to undo 1 broadcast.',
    );
    // toast.success must NOT fire again for the Undo outcome — only the
    // pre-existing "Broadcast approved." call from before counts.
    expect(toastSuccess).toHaveBeenCalledTimes(successCallsBeforeUndo);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('a schedule success shows NO Undo toast', async () => {
    stubApproveAndCancelFetch();

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ApproveDialog broadcastId="b1" open onOpenChange={() => {}} />
      </NextIntlClientProvider>,
    );

    await userEvent.click(
      screen.getByRole('radio', { name: 'Approve & schedule' }),
    );
    fireEvent.change(screen.getByLabelText('Send at'), {
      target: { value: '2099-01-01T09:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Broadcast approved.'),
    );
    // Negative assertion — a scheduled broadcast is cancellable via the
    // normal per-row action; Undo is specifically the "sent now" escape.
    expect(toastFn).not.toHaveBeenCalled();
  });
});

/**
 * Task 5 (2026-08-01-broadcast-review-queue-pr2) — `<QueueBulkActionBar>`.
 *
 * STANDALONE component test for this task — `QueueBulkActionBar` is not yet
 * wired into `queue-table-client.tsx` (Task 6 builds the `QueueWithBulk`
 * wrapper that does that). It operates purely on a `selectedIds: string[]`
 * prop, never a TanStack table instance — see the component's module
 * docstring for why the fan-out moved here could not carry over the
 * `r.original.subject` per-row toast description the sticky-top bar used
 * (a plain id list has no `subject` to report).
 *
 * `vi.useRealTimers()` in `beforeEach` — shared test setup
 * (`tests/setup.ts`) installs fake timers globally, under which
 * `waitFor`/`fireEvent`-driven async state updates can spin
 * `@testing-library/react` internals to the 30s test timeout. Precedent:
 * `queue-card-list.test.tsx`, `bulk-action-bar-spacer.test.tsx`.
 *
 * ResizeObserver stub mirrors `bulk-action-bar-spacer.test.tsx` — captures
 * the constructor callback so a synthetic entry can be driven via `act()`.
 *
 * `fetch` is stubbed per-test (renewals `pipeline-bulk-action-bar.test.tsx`
 * convention) for the fan-out tests; the render/spacer/cap/empty tests never
 * click Approve, so no network call happens in them.
 *
 * Task 4 (2026-08-02-broadcast-review-queue-pr3) — "Approve selected" no
 * longer fans out directly; it opens `BulkApproveConfirmDialog` (Task 3),
 * so every fan-out test below now clicks through the send-now confirm
 * button first. `userEvent` (not `fireEvent.click`) is required for the
 * dialog's own RadioGroup interactions — Base UI Radio dispatches via
 * PointerEvent internally, which jsdom does not implement, hence the
 * polyfill below (copied from `bulk-approve-confirm-dialog.test.tsx`).
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within, act, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { BULK_CAP } from '@/lib/members-bulk-constants';
import { QueueBulkActionBar } from '@/components/broadcast/admin/queue-bulk-action-bar';

const routerRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: routerRefresh }),
}));

const toastFn = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastWarning = vi.fn();
// Task 5 (2026-08-02-broadcast-review-queue-pr3) — `toast` is now called
// BOTH as a bare function (the new 60s send-now Undo toast) and via its
// `.success`/`.error`/`.warning` statics (the pre-existing outcome
// toasts), mirroring real sonner's shape (a callable function with
// methods attached), not just an object of methods.
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

// Base UI Radio (inside BulkApproveConfirmDialog) dispatches via
// PointerEvent, which jsdom does not implement — polyfill copied from
// tests/unit/broadcast/bulk-approve-confirm-dialog.test.tsx /
// tests/unit/broadcast/queue-with-bulk.test.tsx.
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

type RoCallback = (entries: ReadonlyArray<Record<string, unknown>>) => void;
let roCb: RoCallback | undefined;
let disconnectCount = 0;

beforeEach(() => {
  vi.useRealTimers();
  roCb = undefined;
  disconnectCount = 0;
  routerRefresh.mockClear();
  toastFn.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
  toastWarning.mockClear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: RoCallback) {
        roCb = cb;
      }
      observe() {}
      disconnect() {
        disconnectCount++;
      }
      unobserve() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Opens the confirm dialog via "Approve selected" and confirms send-now. */
async function approveViaSendNowConfirm(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'Approve selected' }));
  await userEvent.click(
    await screen.findByRole('button', { name: /Approve & send now/ }),
  );
}

function Provider({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Typed fetch mock factory — an untyped `vi.fn(async () => …)` infers a
 * zero-arg signature, so `mock.calls` becomes `[][]` and destructuring the
 * url/init out of each call fails to typecheck even though it works at
 * runtime. */
function fetchMockOf(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
): ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>> {
  return vi.fn(impl);
}

describe('QueueBulkActionBar — bar shell + count + spacer', () => {
  it('renders a role=toolbar with the visible count (no aria-live — I-1 review fix) and a ResizeObserver spacer', () => {
    const { container } = render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={['b1', 'b2']}
          onClear={vi.fn()}
          readOnly={false}
          recipientByIdRows={[]}
        />
      </Provider>,
    );
    const bar = screen.getByRole('toolbar');
    expect(bar).toHaveClass('fixed', 'bottom-0');
    // I-1 (PR2 whole-branch review, both opus reviewers) — this span must NOT
    // carry `aria-live`. The permanent `role="status"` announcer in
    // `queue-table-client.tsx` is the sole live region for the selection
    // count; duplicating it here caused a double announcement on every
    // count change ("2 selected. 2 selected."). See
    // `queue-table-client-a11y.test.tsx` for that announcer's own coverage.
    const countSpan = within(bar).getByText('2 selected');
    expect(countSpan).not.toHaveAttribute('aria-live');

    act(() => roCb?.([{ borderBoxSize: [{ blockSize: 68 }] }]));
    const spacer = container.querySelector('[aria-hidden="true"][data-testid="queue-bulk-spacer"]');
    expect(spacer).toHaveStyle({ height: '68px' });
  });

  it('rounds a fractional measured height UP', () => {
    const { container } = render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={['b1']}
          onClear={vi.fn()}
          readOnly={false}
          recipientByIdRows={[]}
        />
      </Provider>,
    );
    act(() => roCb?.([{ borderBoxSize: [{ blockSize: 68.4 }] }]));
    const spacer = container.querySelector('[data-testid="queue-bulk-spacer"]') as HTMLElement;
    expect(spacer.style.height).toBe('69px');
  });

  it('falls back to offsetHeight when the entry has no borderBoxSize', () => {
    const { container } = render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={['b1']}
          onClear={vi.fn()}
          readOnly={false}
          recipientByIdRows={[]}
        />
      </Provider>,
    );
    const bar = screen.getByRole('toolbar');
    Object.defineProperty(bar, 'offsetHeight', { value: 96, configurable: true });
    act(() => roCb?.([{}]));
    const spacer = container.querySelector('[data-testid="queue-bulk-spacer"]') as HTMLElement;
    expect(spacer.style.height).toBe('96px');
  });

  it('disconnects the observer on unmount', () => {
    const { unmount } = render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={['b1']}
          onClear={vi.fn()}
          readOnly={false}
          recipientByIdRows={[]}
        />
      </Provider>,
    );
    expect(disconnectCount).toBe(0);
    unmount();
    expect(disconnectCount).toBe(1);
  });
});

describe('QueueBulkActionBar — BULK_CAP over-cap alert', () => {
  it('shows an over-cap alert past BULK_CAP', () => {
    render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={Array.from({ length: 120 }, (_, i) => `b${i}`)}
          onClear={vi.fn()}
          readOnly={false}
          recipientByIdRows={[]}
        />
      </Provider>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/Selection limited to 100/);
  });

  it('does not show the over-cap alert at or under BULK_CAP', () => {
    render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={Array.from({ length: BULK_CAP }, (_, i) => `b${i}`)}
          onClear={vi.fn()}
          readOnly={false}
          recipientByIdRows={[]}
        />
      </Provider>,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('QueueBulkActionBar — recipientByIdRows', () => {
  it('sums recipientCount over the capped selection', () => {
    render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={['b1', 'b2']}
          readOnly={false}
          onClear={vi.fn()}
          recipientByIdRows={[
            { broadcastId: 'b1', recipientCount: 10 },
            { broadcastId: 'b2', recipientCount: 5 },
          ]}
        />
      </Provider>,
    );
    // The total is surfaced when the confirm dialog opens (Task 4) — here we
    // only assert the prop typechecks and the bar still renders the toolbar.
    expect(screen.getByRole('toolbar')).toBeInTheDocument();
  });

  it('the confirm dialog shows the CORRECT sum over the capped set — 10 + 5 = 15 across 2 broadcasts', async () => {
    render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={['b1', 'b2']}
          readOnly={false}
          onClear={vi.fn()}
          recipientByIdRows={[
            { broadcastId: 'b1', recipientCount: 10 },
            { broadcastId: 'b2', recipientCount: 5 },
          ]}
        />
      </Provider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve selected' }));
    expect(
      await screen.findByText(/Reaches ~15 recipients across 2 broadcasts/),
    ).toBeInTheDocument();
  });
});

describe('QueueBulkActionBar — hidden states', () => {
  it('renders nothing when selectedIds is empty', () => {
    const { container } = render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={[]}
          onClear={vi.fn()}
          readOnly={false}
          recipientByIdRows={[]}
        />
      </Provider>,
    );
    expect(container.querySelector('[role="toolbar"]')).toBeNull();
  });

  it('renders nothing when readOnly is true, even with a selection', () => {
    const { container } = render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={['b1']}
          onClear={vi.fn()}
          readOnly
          recipientByIdRows={[]}
        />
      </Provider>,
    );
    expect(container.querySelector('[role="toolbar"]')).toBeNull();
  });
});

describe('QueueBulkActionBar — bulk-approve confirm gate', () => {
  it('opens the confirm dialog instead of approving immediately', async () => {
    const fetchMock = fetchMockOf(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={['b1']}
          onClear={vi.fn()}
          readOnly={false}
          recipientByIdRows={[]}
        />
      </Provider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Approve selected' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled(); // no POST before confirm
  });

  it('send-now confirm posts exactly {decision:"send_now"} — NO recipient/total field (tamper-safety)', async () => {
    const fetchMock = fetchMockOf(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={['b1']}
          onClear={vi.fn()}
          readOnly={false}
          recipientByIdRows={[{ broadcastId: 'b1', recipientCount: 99 }]}
        />
      </Provider>,
    );

    await approveViaSendNowConfirm();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    // Tamper-safety: the fan-out body must carry ONLY `decision` — never a
    // recipient count or total, no matter how large `recipientByIdRows`
    // says the true audience is.
    expect(body).toEqual({ decision: 'send_now' });
  });

  it('schedule confirm posts {decision:"schedule", scheduledFor:<Bangkok-resolved ISO>}', async () => {
    const fetchMock = fetchMockOf(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={['b1']}
          onClear={vi.fn()}
          readOnly={false}
          recipientByIdRows={[]}
        />
      </Provider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Approve selected' }));
    await userEvent.click(await screen.findByRole('radio', { name: /Schedule/ }));
    fireEvent.change(screen.getByLabelText(/Send at/), {
      target: { value: '2099-01-01T09:00' },
    });
    await userEvent.click(screen.getByRole('button', { name: /Approve & schedule/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body).toEqual({
      decision: 'schedule',
      scheduledFor: '2099-01-01T02:00:00.000Z',
    });
  });
});

describe('QueueBulkActionBar — bulk-approve fan-out', () => {
  it('POSTs {decision: send_now} to the approve endpoint for every selected id, clears selection, and refreshes on full success', async () => {
    const fetchMock = fetchMockOf(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const onClear = vi.fn();

    render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={['b1', 'b2']}
          onClear={onClear}
          readOnly={false}
          recipientByIdRows={[]}
        />
      </Provider>,
    );

    await approveViaSendNowConfirm();

    await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1));

    const calls = fetchMock.mock.calls;
    expect(calls).toHaveLength(2);
    for (const [url, init] of calls) {
      expect(String(url)).toMatch(/^\/api\/admin\/broadcasts\/b[12]\/approve$/);
      expect(init).toMatchObject({
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(JSON.parse(init?.body as string)).toEqual({ decision: 'send_now' });
    }
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('only fans out over the first BULK_CAP ids, never the ones past the cap', async () => {
    const fetchMock = fetchMockOf(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={Array.from({ length: 120 }, (_, i) => `b${i}`)}
          onClear={vi.fn()}
          readOnly={false}
          recipientByIdRows={[]}
        />
      </Provider>,
    );

    await approveViaSendNowConfirm();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(BULK_CAP));
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls).not.toContain('/api/admin/broadcasts/b100/approve');
    expect(urls).toContain('/api/admin/broadcasts/b99/approve');
  });

  it('on a full failure, toasts failureAll and does NOT clear the selection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'boom' } }, 500)));
    const onClear = vi.fn();

    render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={['b1']}
          onClear={onClear}
          readOnly={false}
          recipientByIdRows={[]}
        />
      </Provider>,
    );

    await approveViaSendNowConfirm();

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(onClear).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('on a partial failure, toasts partial with ok/fail counts and does NOT clear the selection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('b2')
          ? jsonResponse({ error: { code: 'broadcast_concurrent_action_blocked' } }, 409)
          : jsonResponse({ ok: true }),
      ),
    );
    const onClear = vi.fn();

    render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={['b1', 'b2']}
          onClear={onClear}
          readOnly={false}
          recipientByIdRows={[]}
        />
      </Provider>,
    );

    await approveViaSendNowConfirm();

    await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1));
    expect(toastWarning).toHaveBeenCalledWith('1 approved, 1 failed.');
    expect(onClear).not.toHaveBeenCalled();
  });

  it('clicking Clear calls onClear without hitting the network', () => {
    const onClear = vi.fn();
    render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={['b1']}
          onClear={onClear}
          readOnly={false}
          recipientByIdRows={[]}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('QueueBulkActionBar — in-flight progress announcement (Task 7, 2026-08-02-broadcast-review-queue-pr3)', () => {
  it('is a PERMANENTLY-mounted role="status" region whose TEXT toggles empty → "Approving…" → empty across the fan-out (fix round 1 — NVDA/JAWS only announce mutations on an already-mounted region, not a region that appears with content already populated)', async () => {
    let resolveFetch: ((res: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(() => pending));

    render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={['b1']}
          onClear={vi.fn()}
          readOnly={false}
          recipientByIdRows={[]}
        />
      </Provider>,
    );

    // Before the fan-out starts, the region already EXISTS (permanent —
    // not conditionally mounted), but is silent (empty text).
    const statusBefore = screen.getByRole('status');
    expect(statusBefore.textContent).toBe('');

    await approveViaSendNowConfirm();

    // The fan-out is now in-flight — `fetch` hasn't resolved yet. The SAME
    // node (not a newly-mounted one — `toBe` proves node identity) must now
    // carry the "Approving…" text, which is the mutation NVDA/JAWS actually
    // announce.
    const statusDuring = screen.getByRole('status');
    expect(statusDuring).toBe(statusBefore);
    await waitFor(() => expect(statusDuring.textContent).toBe('Approving…'));
    expect(statusDuring).toHaveTextContent('Approving…');

    // Resolve the pending fetch; the fan-out completes and `executing`
    // flips back to false — the SAME node goes silent again (empty text),
    // it does NOT unmount.
    resolveFetch?.(jsonResponse({ ok: true }));
    await waitFor(() => expect(statusDuring.textContent).toBe(''));
    expect(screen.getByRole('status')).toBe(statusBefore);
  });
});

describe('QueueBulkActionBar — 60s send-now Undo toast (Task 5, 2026-08-02-broadcast-review-queue-pr3)', () => {
  it('after an all-success send-now confirm, shows an Undo toast whose action cancels every approved id with the canned reason', async () => {
    const cancelMock = vi.fn(async () => jsonResponse({ status: 'cancelled' }));
    const fetchMock = fetchMockOf(async (url) =>
      String(url).endsWith('/cancel') ? cancelMock() : jsonResponse({ ok: true }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={['b1', 'b2']}
          onClear={vi.fn()}
          readOnly={false}
          recipientByIdRows={[]}
        />
      </Provider>,
    );

    await approveViaSendNowConfirm();

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1)); // the pre-existing successAll toast
    // The new bare `toast(...)` call is the Undo toast, IN ADDITION to
    // the successAll toast above.
    expect(toastFn).toHaveBeenCalledTimes(1);
    const [message, opts] = toastFn.mock.calls[0] as [
      string,
      { duration?: number; action?: { label: string; onClick: () => Promise<void> } },
    ];
    expect(message).toBe('Sending 2 broadcasts in 60s.');
    expect(opts.duration).toBe(60_000);
    expect(opts.action?.label).toBe('Undo');

    await opts.action!.onClick();

    expect(cancelMock).toHaveBeenCalledTimes(2);
    const cancelFetchCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).endsWith('/cancel'),
    );
    expect(cancelFetchCalls).toHaveLength(2);
    for (const [url, init] of cancelFetchCalls) {
      expect(String(url)).toMatch(/^\/api\/admin\/broadcasts\/b[12]\/cancel$/);
      expect(JSON.parse(init?.body as string)).toEqual({
        cancellationReason: 'Undone by admin from the review queue',
      });
    }
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Cancelled 2 broadcasts.'),
    );
  });

  it('a schedule confirm shows NO Undo toast', async () => {
    vi.stubGlobal('fetch', fetchMockOf(async () => jsonResponse({ ok: true })));

    render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={['b1']}
          onClear={vi.fn()}
          readOnly={false}
          recipientByIdRows={[]}
        />
      </Provider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Approve selected' }));
    await userEvent.click(await screen.findByRole('radio', { name: /Schedule/ }));
    fireEvent.change(screen.getByLabelText(/Send at/), {
      target: { value: '2099-01-01T09:00' },
    });
    await userEvent.click(screen.getByRole('button', { name: /Approve & schedule/ }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    // Negative assertion — a scheduled broadcast hasn't been dispatched at
    // all yet, so it's already cancellable via the normal per-row action;
    // Undo is specifically the "sent now" escape.
    expect(toastFn).not.toHaveBeenCalled();
  });

  it('on a partial failure, still shows the Undo toast scoped to ONLY the approved ids', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('b2') && String(url).endsWith('/approve')
          ? jsonResponse({ error: { code: 'broadcast_concurrent_action_blocked' } }, 409)
          : jsonResponse({ ok: true }),
      ),
    );

    render(
      <Provider>
        <QueueBulkActionBar
          selectedIds={['b1', 'b2']}
          onClear={vi.fn()}
          readOnly={false}
          recipientByIdRows={[]}
        />
      </Provider>,
    );

    await approveViaSendNowConfirm();

    await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1)); // partial toast
    expect(toastFn).toHaveBeenCalledTimes(1);
    const [message] = toastFn.mock.calls[0] as [string];
    expect(message).toBe('Sending 1 broadcast in 60s.'); // only b1 succeeded
  });
});

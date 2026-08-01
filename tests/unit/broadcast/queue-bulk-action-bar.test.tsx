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
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within, act, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { BULK_CAP } from '@/lib/members-bulk-constants';
import { QueueBulkActionBar } from '@/components/broadcast/admin/queue-bulk-action-bar';

const routerRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: routerRefresh }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastWarning = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    warning: (...a: unknown[]) => toastWarning(...a),
  },
}));

type RoCallback = (entries: ReadonlyArray<Record<string, unknown>>) => void;
let roCb: RoCallback | undefined;
let disconnectCount = 0;

beforeEach(() => {
  vi.useRealTimers();
  roCb = undefined;
  disconnectCount = 0;
  routerRefresh.mockClear();
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

describe('QueueBulkActionBar — bar shell + aria-live count + spacer', () => {
  it('renders a role=toolbar with an aria-live count and a ResizeObserver spacer', () => {
    const { container } = render(
      <Provider>
        <QueueBulkActionBar selectedIds={['b1', 'b2']} onClear={vi.fn()} readOnly={false} />
      </Provider>,
    );
    const bar = screen.getByRole('toolbar');
    expect(bar).toHaveClass('fixed', 'bottom-0');
    expect(within(bar).getByText('2 selected')).toHaveAttribute('aria-live', 'polite');

    act(() => roCb?.([{ borderBoxSize: [{ blockSize: 68 }] }]));
    const spacer = container.querySelector('[aria-hidden="true"][data-testid="queue-bulk-spacer"]');
    expect(spacer).toHaveStyle({ height: '68px' });
  });

  it('rounds a fractional measured height UP', () => {
    const { container } = render(
      <Provider>
        <QueueBulkActionBar selectedIds={['b1']} onClear={vi.fn()} readOnly={false} />
      </Provider>,
    );
    act(() => roCb?.([{ borderBoxSize: [{ blockSize: 68.4 }] }]));
    const spacer = container.querySelector('[data-testid="queue-bulk-spacer"]') as HTMLElement;
    expect(spacer.style.height).toBe('69px');
  });

  it('falls back to offsetHeight when the entry has no borderBoxSize', () => {
    const { container } = render(
      <Provider>
        <QueueBulkActionBar selectedIds={['b1']} onClear={vi.fn()} readOnly={false} />
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
        <QueueBulkActionBar selectedIds={['b1']} onClear={vi.fn()} readOnly={false} />
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
        />
      </Provider>,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('QueueBulkActionBar — hidden states', () => {
  it('renders nothing when selectedIds is empty', () => {
    const { container } = render(
      <Provider>
        <QueueBulkActionBar selectedIds={[]} onClear={vi.fn()} readOnly={false} />
      </Provider>,
    );
    expect(container.querySelector('[role="toolbar"]')).toBeNull();
  });

  it('renders nothing when readOnly is true, even with a selection', () => {
    const { container } = render(
      <Provider>
        <QueueBulkActionBar selectedIds={['b1']} onClear={vi.fn()} readOnly />
      </Provider>,
    );
    expect(container.querySelector('[role="toolbar"]')).toBeNull();
  });
});

describe('QueueBulkActionBar — bulk-approve fan-out', () => {
  it('POSTs {decision: send_now} to the approve endpoint for every selected id, clears selection, and refreshes on full success', async () => {
    const fetchMock = fetchMockOf(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const onClear = vi.fn();

    render(
      <Provider>
        <QueueBulkActionBar selectedIds={['b1', 'b2']} onClear={onClear} readOnly={false} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }));

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
        />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }));

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
        <QueueBulkActionBar selectedIds={['b1']} onClear={onClear} readOnly={false} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }));

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
        <QueueBulkActionBar selectedIds={['b1', 'b2']} onClear={onClear} readOnly={false} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }));

    await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1));
    expect(toastWarning).toHaveBeenCalledWith('1 approved, 1 failed.');
    expect(onClear).not.toHaveBeenCalled();
  });

  it('clicking Clear calls onClear without hitting the network', () => {
    const onClear = vi.fn();
    render(
      <Provider>
        <QueueBulkActionBar selectedIds={['b1']} onClear={onClear} readOnly={false} />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

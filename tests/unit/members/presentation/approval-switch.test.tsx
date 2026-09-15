/**
 * F114 US6 (T096 / T099; FR-031, FR-032, FR-034, FR-036) — `<ApprovalSwitch>`,
 * the per-tenant "require approval for member changes" control on
 * `/admin/settings/member-changes`.
 *
 * Pinned:
 *   - switching ON → `PATCH /api/admin/settings/member-changes`
 *     `{ approvalEnabled: true }` (same-origin JSON), a success toast, and
 *     the `role="status"` state line announces the new state;
 *   - switching OFF with requests waiting → the platform confirmation
 *     dialog (plain tier, not destructive) whose confirm button states the
 *     count ("Switch off — 3 requests stay in the queue"); Cancel → no
 *     request, switch still on; Confirm → `{ approvalEnabled: false }`;
 *   - switching OFF with nothing waiting → no dialog, straight to PATCH;
 *   - a 503 read-only refusal → the inline `role="alert"` with the platform
 *     read-only copy, switch state unchanged; a 500 → the generic alert.
 *
 * Base UI Switch re-dispatches its click as a PointerEvent (jsdom lacks it) —
 * polyfill per `tests/unit/components/members/marketing-switch.test.tsx`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from 'sonner';
import en from '@/i18n/messages/en.json';
import { ApprovalSwitch } from '@/app/(staff)/admin/settings/member-changes/_components/approval-switch';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const t = en.admin.settings.memberChanges;

function renderSwitch(props: { initialEnabled: boolean; pendingCount: number }) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ApprovalSwitch {...props} />
    </NextIntlClientProvider>,
  );
}

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

type FetchCall = { url: string; init: RequestInit };
function calls(fn: ReturnType<typeof vi.fn>): FetchCall[] {
  return fn.mock.calls.map((c) => ({ url: String(c[0]), init: c[1] as RequestInit }));
}

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
  vi.useRealTimers();
  for (const fn of [toast.success, toast.info, toast.error]) {
    (fn as unknown as ReturnType<typeof vi.fn>).mockClear();
  }
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ApprovalSwitch (F114 US6)', () => {
  it('switching ON → PATCH { approvalEnabled: true }, success toast, status line announces ON', async () => {
    const fetchFn = stubFetch(200, { approvalEnabled: true, changedAt: '2026-09-15T10:00:00.000Z' });
    renderSwitch({ initialEnabled: false, pendingCount: 0 });

    const sw = screen.getByRole('switch', { name: t.switchLabel });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('status')).toHaveTextContent(t.state.off);

    fireEvent.click(sw);

    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    const [call] = calls(fetchFn);
    expect(call!.url).toBe('/api/admin/settings/member-changes');
    expect(call!.init.method).toBe('PATCH');
    expect(call!.init.credentials).toBe('same-origin');
    expect(new Headers(call!.init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(call!.init.body))).toEqual({ approvalEnabled: true });

    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
    expect(toast.success).toHaveBeenCalledWith(t.toast.on);
    expect(screen.getByRole('status')).toHaveTextContent(t.state.on);
    expect(screen.queryByRole('alert')).toBeNull();
    // the dialog is for switching OFF with a queue — never on the way ON
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('switching OFF with 3 waiting → the confirmation names the count; Cancel sends nothing', async () => {
    const fetchFn = stubFetch(200, { approvalEnabled: false, changedAt: '2026-09-15T10:00:00.000Z' });
    renderSwitch({ initialEnabled: true, pendingCount: 3 });

    const sw = screen.getByRole('switch', { name: t.switchLabel });
    fireEvent.click(sw);

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(t.confirm.title);
    expect(dialog).toHaveTextContent('3 pending requests stay in the queue');
    const confirm = screen.getByRole('button', { name: 'Switch off — 3 requests stay in the queue' });
    expect(confirm).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: t.confirm.cancel }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fetchFn).not.toHaveBeenCalled();
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  it('switching OFF with 3 waiting → Confirm sends PATCH { approvalEnabled: false } and announces OFF', async () => {
    const fetchFn = stubFetch(200, { approvalEnabled: false, changedAt: '2026-09-15T10:00:00.000Z' });
    renderSwitch({ initialEnabled: true, pendingCount: 3 });

    fireEvent.click(screen.getByRole('switch', { name: t.switchLabel }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Switch off — 3 requests stay in the queue' }));

    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(calls(fetchFn)[0]!.init.body))).toEqual({ approvalEnabled: false });
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: t.switchLabel })).toHaveAttribute('aria-checked', 'false'),
    );
    expect(toast.success).toHaveBeenCalledWith(t.toast.off);
    expect(screen.getByRole('status')).toHaveTextContent(t.state.off);
  });

  it('switching OFF with nothing waiting → no dialog; a 503 read-only refusal → inline alert, state unchanged', async () => {
    const fetchFn = stubFetch(503, { error: { code: 'read_only_mode', message: 'maintenance' } });
    renderSwitch({ initialEnabled: true, pendingCount: 0 });

    const sw = screen.getByRole('switch', { name: t.switchLabel });
    fireEvent.click(sw);

    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(en.errors.readOnlyMode);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(t.state.on);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('a 500 → the generic inline alert, state unchanged', async () => {
    stubFetch(500, { type: 'https://chamber-os.example/errors/server_error', title: 'Could not change the setting', status: 500 });
    renderSwitch({ initialEnabled: false, pendingCount: 0 });

    const sw = screen.getByRole('switch', { name: t.switchLabel });
    fireEvent.click(sw);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(t.errors.generic);
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });
});

/**
 * F114 US6 (T096 / T099; FR-031, FR-032, FR-034, FR-036) — `<ApprovalSwitch>`,
 * the per-tenant "require approval for member changes" control on
 * `/admin/settings/member-changes`.
 *
 * Pinned:
 *   - switching ON → `PATCH /api/admin/settings/member-changes`
 *     `{ approvalEnabled: true }` (same-origin JSON), ONE success toast, and
 *     the visible state line follows — it is NOT a live region (UX M3: the
 *     toast already announces; two polite regions read the same news twice);
 *   - the `role="switch"` element itself carries the accessible name via
 *     `aria-labelledby` (Base UI puts the caller `id` on its hidden checkbox
 *     on purpose — `useLabelableId` — so the visible `<label for>` is the
 *     POINTER path: clicking the label text toggles the switch, UX M1
 *     re-read against the primitive; the house idiom of
 *     `renewal-reminders-toggle.tsx`);
 *   - switching OFF with requests waiting → the platform confirmation
 *     dialog (plain tier, not destructive) whose confirm button is the short
 *     count-bearing "Switch off (3)" (UX H1: the full consequence sentence is
 *     the body, and a 41-char button overflowed the 320 px footer); Cancel →
 *     no request, switch still on; Confirm → `{ approvalEnabled: false }`;
 *   - the pending-count note is rendered whenever requests are waiting, in
 *     BOTH setting states, with the count as an underlined link to the queue
 *     (UX H2: it used to vanish in exactly the FR-032 state); absent at 0;
 *   - switching OFF with nothing waiting → no dialog, straight to PATCH;
 *   - a 503 read-only refusal → the inline `role="alert"` with the
 *     setting-specific read-only copy (UX M5), switch state unchanged; a 500
 *     → the generic alert.
 *
 * Base UI Switch re-dispatches its click as a PointerEvent (jsdom lacks it) —
 * polyfill per `tests/unit/components/members/marketing-switch.test.tsx`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  it('switching ON → PATCH { approvalEnabled: true }, ONE success toast, the state line follows without a live region', async () => {
    const fetchFn = stubFetch(200, { approvalEnabled: true, changedAt: '2026-09-15T10:00:00.000Z' });
    renderSwitch({ initialEnabled: false, pendingCount: 0 });

    const sw = screen.getByRole('switch', { name: t.switchLabel });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(t.state.off)).toBeInTheDocument();
    // UX M3 — the toast is the one announcement; the state line is plain text.
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText(t.state.off)).not.toHaveAttribute('aria-live');

    fireEvent.click(sw);

    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    const [call] = calls(fetchFn);
    expect(call!.url).toBe('/api/admin/settings/member-changes');
    expect(call!.init.method).toBe('PATCH');
    expect(call!.init.credentials).toBe('same-origin');
    expect(new Headers(call!.init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(call!.init.body))).toEqual({ approvalEnabled: true });

    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(t.toast.on);
    expect(screen.getByText(t.state.on)).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // the dialog is for switching OFF with a queue — never on the way ON
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // nothing waiting → no pending note either
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('the switch element itself is named through aria-labelledby, and clicking the visible label toggles it (UX M1)', async () => {
    const fetchFn = stubFetch(200, { approvalEnabled: true, changedAt: '2026-09-15T10:00:00.000Z' });
    const { container } = renderSwitch({ initialEnabled: false, pendingCount: 0 });
    const sw = screen.getByRole('switch', { name: t.switchLabel });
    const labelId = sw.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    const label = document.getElementById(labelId!)!;
    expect(label).toHaveTextContent(t.switchLabel);
    expect(label.closest('[aria-hidden="true"]')).toBeNull();
    // The `for` target is Base UI's hidden checkbox (by design) — the pointer
    // path: a click on the label text activates it and the switch toggles.
    const forId = label.getAttribute('for');
    expect(forId).toBeTruthy();
    const target = container.querySelector(`#${CSS.escape(forId!)}`);
    expect(target).toBeInstanceOf(HTMLInputElement);
    fireEvent.click(label);
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(calls(fetchFn)[0]!.init.body))).toEqual({ approvalEnabled: true });
  });

  it('switching OFF with 3 waiting → the confirmation names the count; Cancel sends nothing', async () => {
    const fetchFn = stubFetch(200, { approvalEnabled: false, changedAt: '2026-09-15T10:00:00.000Z' });
    renderSwitch({ initialEnabled: true, pendingCount: 3 });

    const sw = screen.getByRole('switch', { name: t.switchLabel });
    fireEvent.click(sw);

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(t.confirm.title);
    expect(dialog).toHaveTextContent('3 pending requests stay in the queue');
    // UX H1 — short, count-bearing; the consequence sentence is the body.
    const confirm = screen.getByRole('button', { name: 'Switch off (3)' });
    expect(confirm).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: t.confirm.cancel }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fetchFn).not.toHaveBeenCalled();
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  it('switching OFF with 3 waiting → Confirm sends PATCH { approvalEnabled: false } and the state line follows', async () => {
    const fetchFn = stubFetch(200, { approvalEnabled: false, changedAt: '2026-09-15T10:00:00.000Z' });
    renderSwitch({ initialEnabled: true, pendingCount: 3 });

    fireEvent.click(screen.getByRole('switch', { name: t.switchLabel }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Switch off (3)' }));

    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(calls(fetchFn)[0]!.init.body))).toEqual({ approvalEnabled: false });
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: t.switchLabel })).toHaveAttribute('aria-checked', 'false'),
    );
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(t.toast.off);
    expect(screen.getByText(t.state.off)).toBeInTheDocument();
  });

  it('pending note (UX H2): rendered in the ON state with the count as an underlined link to the queue', () => {
    renderSwitch({ initialEnabled: true, pendingCount: 3 });
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('3 requests are waiting for a decision.');
    const link = within(note).getByRole('link', { name: '3 requests' });
    expect(link).toHaveAttribute('href', '/admin/change-requests');
    expect(link.className).toMatch(/\bunderline\b/);
    expect(link.className).not.toMatch(/text-muted-foreground/);
  });

  it('pending note (UX H2): still rendered in the OFF state — the FR-032 copy — with the same link', () => {
    renderSwitch({ initialEnabled: false, pendingCount: 3 });
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('3 requests submitted earlier stay in the queue and can still be decided.');
    expect(within(note).getByRole('link', { name: '3 requests' })).toHaveAttribute('href', '/admin/change-requests');
  });

  it('pending note (UX H2): singular copy at 1; absent at 0 in both states', () => {
    const { unmount } = renderSwitch({ initialEnabled: false, pendingCount: 1 });
    expect(screen.getByRole('note')).toHaveTextContent('1 request submitted earlier stays in the queue');
    expect(within(screen.getByRole('note')).getByRole('link', { name: '1 request' })).toBeInTheDocument();
    unmount();
    renderSwitch({ initialEnabled: true, pendingCount: 0 });
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('switching OFF with nothing waiting → no dialog; a 503 read-only refusal → inline alert with the setting-specific copy (UX M5), state unchanged', async () => {
    const fetchFn = stubFetch(503, { error: { code: 'read_only_mode', message: 'maintenance' } });
    renderSwitch({ initialEnabled: true, pendingCount: 0 });

    const sw = screen.getByRole('switch', { name: t.switchLabel });
    fireEvent.click(sw);

    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(t.errors.readOnly);
    expect(alert).not.toHaveTextContent(en.errors.readOnlyMode);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(t.state.on)).toBeInTheDocument();
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

/**
 * PR-3 review (reliability R-L5) — the server answers `changedAt: null` when
 * the stored value already matched (an idempotent upsert, no audit row). A
 * success toast on that path claims a change that did not happen: two admins
 * on the same card, or a double-click, both read "Approval switched on" for
 * an operation the audit trail does not record. The visible state line already
 * carries the value, so the no-op needs no announcement.
 */
describe('ApprovalSwitch — the unchanged no-op is not announced (R-L5)', () => {
  it('changedAt null → no toast; the state line still shows the stored value', async () => {
    const fetchFn = stubFetch(200, { approvalEnabled: true, changedAt: null });
    renderSwitch({ initialEnabled: true, pendingCount: 0 });

    // a stale second tab flipping "on" onto an already-on tenant
    fireEvent.click(screen.getByRole('switch', { name: t.switchLabel }));

    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('switch', { name: t.switchLabel })).toHaveAttribute('aria-checked', 'true'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByText(t.state.on)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a real change (changedAt set) still toasts exactly once — the guard is the no-op, not the toast', async () => {
    stubFetch(200, { approvalEnabled: false, changedAt: '2026-09-15T10:00:00.000Z' });
    renderSwitch({ initialEnabled: true, pendingCount: 0 });

    fireEvent.click(screen.getByRole('switch', { name: t.switchLabel }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith(t.toast.off);
  });
});

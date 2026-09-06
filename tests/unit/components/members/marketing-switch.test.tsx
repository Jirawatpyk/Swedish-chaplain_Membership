/**
 * 108 PR-D T056 (FR-030b, FR-030c, FR-031a, FR-051) — `MarketingSwitch`.
 *
 * The staff toggle control shared by the member page and the Marketing
 * audience page. Pinned here:
 *   - every request — the Undo included — carries its OWN fresh
 *     `Idempotency-Key` (a reused key would replay the stored "off" outcome
 *     and make Undo a silent no-op, FR-030b / FR-030c);
 *   - switching OFF offers a 10-second Undo toast; switching ON does not;
 *     no confirmation dialog either way;
 *   - `unchanged` is an info toast; 409 suppressed / 403 / 404 / 429 / 5xx
 *     each map to a localized error toast;
 *   - "status unavailable" renders the switch disabled (a blind change could
 *     override an unsubscribe nobody could verify);
 *   - the accessible name carries the contact's name and the state.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { toast } from 'sonner';
import { MarketingSwitch } from '@/components/members/marketing-switch';
import type { MarketingState } from '@/modules/members';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
const refreshSpy = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));

const t = en.shared.marketing.switch;
const CONTACT = 'aaaaaaaa-bbbb-4ccc-8ddd-111111111111';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function renderSwitch(state: MarketingState) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MarketingSwitch contactId={CONTACT} contactName="Jane Doe" state={state} />
    </NextIntlClientProvider>,
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

type FetchCall = { url: string; init: RequestInit };
function fetchCalls(): FetchCall[] {
  return (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
    (c) => ({ url: String(c[0]), init: c[1] as RequestInit }),
  );
}
function keyOf(call: FetchCall): string {
  return new Headers(call.init.headers).get('idempotency-key') ?? '';
}

// Base UI Switch re-dispatches the click on its hidden input as a
// PointerEvent, which jsdom does not implement — polyfill copied from
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
  vi.useRealTimers();
  refreshSpy.mockClear();
  for (const fn of [toast.success, toast.info, toast.error]) {
    (fn as unknown as ReturnType<typeof vi.fn>).mockClear();
  }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useFakeTimers();
});

describe('MarketingSwitch — rendering', () => {
  it('is a checked switch named for the contact when marketing is on', () => {
    renderSwitch('on');
    const sw = screen.getByRole('switch', { name: /Jane Doe/ });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(sw).toHaveAccessibleName(t.ariaLabel.replace('{name}', 'Jane Doe').replace('{state}', en.shared.marketing.state.on));
  });

  it('off_by_staff → unchecked switch (staff may switch it back on)', () => {
    renderSwitch('off_by_staff');
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it.each(['off_by_contact', 'unsubscribed'] as const)(
    '%s → NO control: the person\'s own objection is not something staff can lift (FR-025 amendment)',
    (state) => {
      renderSwitch(state);
      expect(screen.queryByRole('switch')).toBeNull();
    },
  );

  it('"status unavailable" → disabled; a click sends nothing', async () => {
    vi.spyOn(globalThis, 'fetch');
    renderSwitch('unavailable');
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-disabled') === 'true' || (sw as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(sw);
    await new Promise((r) => setTimeout(r, 0));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('MarketingSwitch — switching off (with Undo)', () => {
  it('POSTs { state: off } with a fresh Idempotency-Key, toasts a 10-s Undo, refreshes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, { outcome: 'changed', contact: { contact_id: CONTACT } }),
    );
    renderSwitch('on');
    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const [call] = fetchCalls();
    expect(call!.url).toBe(`/api/admin/contacts/${CONTACT}/marketing`);
    expect(call!.init.method).toBe('POST');
    expect(JSON.parse(String(call!.init.body))).toEqual({ state: 'off' });
    expect(keyOf(call!)).toMatch(UUID_RE);

    const [msg, opts] = (toast.success as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { duration: number; action: { label: string; onClick: () => void } },
    ];
    expect(msg).toBe(t.switchedOff.replace('{name}', 'Jane Doe'));
    expect(opts.duration).toBe(10_000);
    expect(opts.action.label).toBe(t.undo);
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('Undo POSTs { state: on } under a DIFFERENT Idempotency-Key (never the "off" key)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, { outcome: 'changed', contact: { contact_id: CONTACT } }),
    );
    renderSwitch('on');
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));

    const opts = (toast.success as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      action: { onClick: () => void | Promise<void> };
    };
    await opts.action.onClick();
    await waitFor(() => expect(fetchCalls()).toHaveLength(2));

    const [off, undo] = fetchCalls();
    expect(JSON.parse(String(undo!.init.body))).toEqual({ state: 'on' });
    expect(keyOf(undo!)).toMatch(UUID_RE);
    expect(keyOf(undo!)).not.toBe(keyOf(off!));
    // The Undo's own success toast has no further Undo.
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2));
    const undoOpts = (toast.success as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1];
    expect(undoOpts?.action).toBeUndefined();
  });

  it('ignores a second click while the first request is in flight', async () => {
    let resolve!: (r: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    renderSwitch('on');
    const sw = screen.getByRole('switch');
    fireEvent.click(sw);
    fireEvent.click(sw);
    resolve(jsonResponse(200, { outcome: 'changed', contact: {} }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(fetchCalls()).toHaveLength(1);
  });
});

describe('MarketingSwitch — switching on and the error map', () => {
  it('on → POST { state: on }, plain success toast (no Undo), refresh', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, { outcome: 'changed', contact: { contact_id: CONTACT } }),
    );
    renderSwitch('off_by_staff');
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchCalls()[0]!.init.body))).toEqual({ state: 'on' });
    const [msg, opts] = (toast.success as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(msg).toBe(t.switchedOn.replace('{name}', 'Jane Doe'));
    expect(opts).toBeUndefined();
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('unchanged → info toast, still refreshes (someone else got there first)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { outcome: 'unchanged' }));
    renderSwitch('on');
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(t.unchanged));
    expect(toast.success).not.toHaveBeenCalled();
    expect(refreshSpy).toHaveBeenCalled();
  });

  it.each([
    [409, { type: 'https://chamber-os.app/errors/suppressed' }, t.errors.suppressed],
    [409, { type: 'https://chamber-os.app/errors/idempotency_conflict' }, t.errors.generic],
    [403, {}, t.errors.forbidden],
    [404, {}, t.errors.notFound],
    [429, {}, t.errors.rateLimited],
    [503, { type: 'https://chamber-os.app/errors/suppression_unavailable' }, t.errors.unavailable],
    [500, {}, t.errors.generic],
  ] as const)('HTTP %s → localized error toast', async (status, body, expected) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(status, body));
    renderSwitch('off_by_staff');
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expected));
    expect(toast.success).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('a network failure → generic error toast', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    renderSwitch('on');
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t.errors.generic));
  });
});

/**
 * Review cycle 11 — UX H3 / H4, a11y 2 / 5.
 *   - the switch flips OPTIMISTICALLY on click and rolls back on refusal, so
 *     `aria-checked` (and the thumb) never lag one round-trip behind the toast;
 *   - under a state-filtered view (the FR-027a pre-flight preset) the row
 *     LEAVES the view on refresh — focus is handed to the next row's switch
 *     (or the count line) BEFORE the refresh, never dropped on <body>.
 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('MarketingSwitch — optimistic state (cycle 11)', () => {
  it('flips aria-checked at once on click, before the server answers', async () => {
    const d = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => d.promise));
    renderSwitch('on');
    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'));
    expect(refreshSpy).not.toHaveBeenCalled();
    d.resolve(jsonResponse(200, { outcome: 'changed', contact: {} }));
    await waitFor(() => expect(refreshSpy).toHaveBeenCalled());
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  it('rolls back on a refusal (409) and toasts the reason', async () => {
    const d = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => d.promise));
    renderSwitch('off_by_staff');
    const sw = screen.getByRole('switch');
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
    d.resolve(jsonResponse(409, { type: 'https://chamber-os.app/errors/suppressed' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t.errors.suppressed));
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('rolls back on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    renderSwitch('on');
    const sw = screen.getByRole('switch');
    fireEvent.click(sw);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t.errors.generic));
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });
});

describe('MarketingSwitch — focus hand-off when the row leaves the view (cycle 11)', () => {
  function renderTwoRows(leavesView: boolean) {
    return render(
      <NextIntlClientProvider locale="en" messages={en}>
        <p id="audience-count" tabIndex={-1}>2 contacts</p>
        <table>
          <tbody>
            <tr>
              <td>
                <MarketingSwitch contactId={CONTACT} contactName="Jane Doe" state="on" leavesView={leavesView} />
              </td>
            </tr>
            <tr>
              <td>
                <MarketingSwitch
                  contactId="bbbbbbbb-bbbb-4ccc-8ddd-222222222222"
                  contactName="John Roe"
                  state="on"
                  leavesView={leavesView}
                />
              </td>
            </tr>
          </tbody>
        </table>
      </NextIntlClientProvider>,
    );
  }

  it('leavesView: focus moves to the next-row switch before the refresh; the toast says the row left the view', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { outcome: 'changed', contact: {} })));
    renderTwoRows(true);
    const [first, second] = screen.getAllByRole('switch');
    first!.focus();
    fireEvent.click(first!);
    await waitFor(() => expect(refreshSpy).toHaveBeenCalled());
    expect(document.activeElement).toBe(second);
    expect(toast.success).toHaveBeenCalledWith(
      t.switchedOff.replace('{name}', 'Jane Doe'),
      expect.objectContaining({ description: t.leftView }),
    );
  });

  it('leavesView, last row: focus falls back to the count line (never <body>)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { outcome: 'changed', contact: {} })));
    renderTwoRows(true);
    const [, second] = screen.getAllByRole('switch');
    second!.focus();
    fireEvent.click(second!);
    await waitFor(() => expect(refreshSpy).toHaveBeenCalled());
    expect(document.activeElement).toBe(document.getElementById('audience-count'));
  });

  it('without leavesView the row stays — focus stays on the switch, no "left view" note', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { outcome: 'changed', contact: {} })));
    renderTwoRows(false);
    const [first] = screen.getAllByRole('switch');
    first!.focus();
    fireEvent.click(first!);
    await waitFor(() => expect(refreshSpy).toHaveBeenCalled());
    expect(document.activeElement).toBe(first);
    const opts = (toast.success as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as
      | { description?: string }
      | undefined;
    expect(opts?.description).toBeUndefined();
  });
});

describe('MarketingSwitch — Undo under leavesView (cycle 13, whole-branch LOW-5)', () => {
  it('the Undo toast carries no "left the view" note — the row comes back', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { outcome: 'changed', contact: {} })));
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <MarketingSwitch contactId={CONTACT} contactName="Jane Doe" state="on" leavesView />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const first = (toast.success as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      description?: string;
      action: { onClick: () => void | Promise<void> };
    };
    expect(first.description).toBe(t.leftView);
    await first.action.onClick();
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2));
    const undo = (toast.success as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1] as
      | { description?: string }
      | undefined;
    expect(undo?.description).toBeUndefined();
  });
});

/**
 * 108 PR-D T064 (US6 — FR-032, FR-033, FR-051) — `PortalMarketingToggle`.
 *
 * The contact's own marketing control on /portal/profile: a switch for
 * on / off states (PATCH with a fresh Idempotency-Key, `{ optOut }`),
 * plain "unsubscribed" TEXT with no control when the person's own
 * unsubscribe is in force, a disabled switch when the state is unavailable,
 * and — for the primary contact — the note that invoices and payment emails
 * are unaffected (FR-033).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { toast } from 'sonner';
import { PortalMarketingToggle } from '@/components/members/portal-marketing-toggle';
import type { MarketingState } from '@/modules/members';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
const refreshSpy = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));

const t = en.portal.profile.marketing;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function renderToggle(state: MarketingState, isPrimary = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PortalMarketingToggle state={state} isPrimary={isPrimary} />
    </NextIntlClientProvider>,
  );
}
function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}
function lastFetch(): { url: string; init: RequestInit } {
  const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const c = calls[calls.length - 1]!;
  return { url: String(c[0]), init: c[1] as RequestInit };
}

beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom (Base UI Switch)
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

describe('PortalMarketingToggle — rendering per state', () => {
  it('on → checked switch labelled "Marketing" with the state text', () => {
    renderToggle('on');
    const sw = screen.getByRole('switch', { name: t.switchLabel });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(t.state.on)).toBeInTheDocument();
  });

  it.each(['off_by_contact', 'off_by_staff'] as const)('%s → unchecked switch (the contact may switch on)', (state) => {
    renderToggle(state);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(t.state[state])).toBeInTheDocument();
  });

  it('unsubscribed → text only, NO control (the person\'s own unsubscribe stands)', () => {
    renderToggle('unsubscribed');
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText(t.state.unsubscribed)).toBeInTheDocument();
    expect(screen.getByText(t.unsubscribedHint)).toBeInTheDocument();
  });

  it('unavailable → disabled switch + explanation', () => {
    renderToggle('unavailable');
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-disabled') === 'true' || (sw as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(t.state.unavailable)).toBeInTheDocument();
  });

  it('primary contact → the FR-033 note that invoices and payment emails are unaffected', () => {
    renderToggle('on', true);
    expect(screen.getByText(t.primaryNote)).toBeInTheDocument();
  });

  it('secondary contact → no primary note', () => {
    renderToggle('on', false);
    expect(screen.queryByText(t.primaryNote)).toBeNull();
  });
});

describe('PortalMarketingToggle — switching', () => {
  it('off → PATCH { optOut: true } with a fresh Idempotency-Key, success toast, refresh', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, { outcome: 'changed', marketing: { state: 'off_by_contact' } }),
    );
    renderToggle('on');
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(t.toast.switchedOff));
    const { url, init } = lastFetch();
    expect(url).toBe('/api/portal/profile/marketing');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ optOut: true });
    expect(new Headers(init.headers).get('idempotency-key')).toMatch(UUID_RE);
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('on → PATCH { optOut: false }', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, { outcome: 'changed', marketing: { state: 'on' } }),
    );
    renderToggle('off_by_contact');
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(t.toast.switchedOn));
    expect(JSON.parse(String(lastFetch().init.body))).toEqual({ optOut: false });
  });

  it('unchanged → info toast', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, { outcome: 'unchanged', marketing: { state: 'on' } }),
    );
    renderToggle('off_by_staff');
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(t.toast.unchanged));
  });

  it.each([
    [409, t.toast.errors.suppressed],
    [429, t.toast.errors.rateLimited],
    [500, t.toast.errors.generic],
  ] as const)('HTTP %s → localized error toast', async (status, expected) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(status, { error: { code: 'x' } }));
    renderToggle('on');
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expected));
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('network failure → generic error toast', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    renderToggle('on');
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t.toast.errors.generic));
  });
});

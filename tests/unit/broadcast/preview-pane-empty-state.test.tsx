// @vitest-environment jsdom
/**
 * F119 T092 / T103 (US3-AS6, FR-043) — the inline preview.
 *
 * The behaviours pinned here are the ones that decide whether a member sees
 * the REAL email or a lie:
 *
 *   1. An empty message shows a translated line, never an empty box — the
 *      only state where "nothing rendered" is correct and must still say so.
 *   2. The pane renders the document the PREVIEW ROUTE returned, inside a
 *      sandboxed `<iframe srcdoc>`. It does NOT sanitise client-side and it
 *      does NOT inject with `dangerouslySetInnerHTML` (T014 — the third
 *      divergent DOMPurify config is deleted; it forbade `<img>`, so every
 *      uploaded image was invisible in the preview while being visible in
 *      the delivered email — audit finding #2).
 *   3. The render is debounced ~400 ms and coalesced: the route is capped at
 *      30 renders / minute per actor, so a keystroke-per-request pane would
 *      burn the budget in two seconds of typing.
 *   4. A 429 is a calm inline line naming the wait, never a toast per
 *      keystroke.
 *
 * Rendered under `NextIntlClientProvider` with the REAL `en.json`, so a
 * dangling `t()` reference fails here rather than shipping a raw key path
 * (next-intl does not throw on a missing key).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { PreviewPane } from '@/components/broadcast/preview-pane';
import { PREVIEW_PANE_FRAME_HEIGHT } from '@/components/broadcast/preview-frame-heights';

/** A full document as the route returns it: brand header, body, footer. */
const DOCUMENT_HTML =
  '<!DOCTYPE html><html lang="en"><body>' +
  '<header>Thai-Swedish Chamber of Commerce</header>' +
  '<h1>Spring update</h1><p>Hello members</p>' +
  '<footer>Unsubscribe</footer></body></html>';

type FetchMock = ReturnType<typeof vi.fn>;

function stubFetch(
  init: { status: number; body?: unknown; headers?: Record<string, string> } = {
    status: 200,
    body: { html: DOCUMENT_HTML },
  },
): FetchMock {
  const fn = vi.fn().mockResolvedValue({
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    headers: new Headers(init.headers ?? {}),
    json: async () => init.body ?? {},
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

type PaneProps = React.ComponentProps<typeof PreviewPane>;

const BASE: PaneProps = {
  endpoint: '/api/broadcasts/preview',
  locale: 'en',
  subject: 'Spring update',
  bodyHtml: '<p>Hello members</p>',
};

function renderPane(overrides: Partial<PaneProps> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PreviewPane {...BASE} {...overrides} />
    </NextIntlClientProvider>,
  );
}

function rerenderPane(
  rerender: (ui: React.ReactElement) => void,
  overrides: Partial<PaneProps>,
): void {
  rerender(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PreviewPane {...BASE} {...overrides} />
    </NextIntlClientProvider>,
  );
}

/** Push past the debounce window and let the fetch + `json()` settle. */
async function settle(ms = 400): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const frame = (): HTMLIFrameElement | null =>
  document.querySelector('iframe');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.useFakeTimers();
});

describe('T092 — an empty message renders the translated empty-state line, not an empty prose div', () => {
  it('an empty body says so and never calls the route', async () => {
    const fetchMock = stubFetch();
    renderPane({ bodyHtml: '' });

    expect(
      screen.getByText(/your message preview appears here/i),
    ).toBeInTheDocument();
    expect(frame()).toBeNull();

    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Tiptap's empty document (`<p></p>`) is empty too", async () => {
    const fetchMock = stubFetch();
    renderPane({ bodyHtml: '<p></p>' });
    expect(
      screen.getByText(/your message preview appears here/i),
    ).toBeInTheDocument();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a body that is only an image is NOT empty — it renders', async () => {
    const fetchMock = stubFetch();
    renderPane({ bodyHtml: '<p><img src="https://cdn.test/a.png" alt="A chart"></p>' });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText(/your message preview appears here/i),
    ).toBeNull();
  });
});

describe("T103 — the pane renders the ROUTE's document in a sandboxed srcdoc iframe", () => {
  it('posts the subject, body and locale to the given endpoint', async () => {
    const fetchMock = stubFetch();
    renderPane({ endpoint: '/api/admin/broadcasts/preview', locale: 'th' });
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/broadcasts/preview');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(String(init.body))).toEqual({
      subject: 'Spring update',
      bodyHtml: '<p>Hello members</p>',
      locale: 'th',
    });
  });

  it('puts the returned document in `srcdoc`, sandboxed, with no `src`', async () => {
    stubFetch();
    renderPane();
    await settle();

    const iframe = frame();
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute('srcdoc')).toBe(DOCUMENT_HTML);
    // DO NOT RELAX THIS — security review F1-1 (2026-09-22). The design-block
    // renderer's output is never re-sanitised by design, so the empty
    // sandbox allow-list is the last barrier between it and this origin. See
    // `tests/unit/broadcasts/infrastructure/sanitizer-design-block-splice.test.ts`.
    expect(iframe!.getAttribute('sandbox')).toBe('');
    expect(iframe!.hasAttribute('src')).toBe(false);
    expect(iframe!.getAttribute('title')).toBeTruthy();
  });

  it('does not inject the document into the page itself (no dangerouslySetInnerHTML)', async () => {
    stubFetch();
    const { container } = renderPane();
    await settle();

    // The message must never become a node of THIS page — that is exactly
    // what the deleted `dangerouslySetInnerHTML` did with the bare body.
    expect(container.textContent ?? '').not.toContain('Hello members');
    expect(container.querySelector('h1')).toBeNull();
    expect(screen.queryByText(/unsubscribe/i)).toBeNull();
    // It lives in the frame's `srcdoc` attribute and nowhere else.
    expect(frame()!.getAttribute('srcdoc')).toContain('Unsubscribe');
  });

  it('shows a shimmer skeleton while the first render is in flight', () => {
    stubFetch();
    const { container } = renderPane();
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });
});

describe('T103 — debounce: the 30/min route budget is not burnt by typing', () => {
  it('three edits inside 200 ms issue ONE request, for the LAST body', async () => {
    const fetchMock = stubFetch();
    const { rerender } = renderPane({ bodyHtml: '<p>a</p>' });

    await act(async () => {
      vi.advanceTimersByTime(80);
    });
    rerenderPane(rerender, { bodyHtml: '<p>ab</p>' });
    await act(async () => {
      vi.advanceTimersByTime(80);
    });
    rerenderPane(rerender, { bodyHtml: '<p>abc</p>' });
    expect(fetchMock).not.toHaveBeenCalled();

    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).bodyHtml).toBe('<p>abc</p>');
  });
});

describe('T103 — refusal states are calm and inline', () => {
  it('429 shows the paused line naming the Retry-After seconds', async () => {
    stubFetch({
      status: 429,
      headers: { 'Retry-After': '23' },
      body: {
        error: {
          code: 'broadcast_rate_limit_exceeded',
          details: { retryAfterSeconds: 23 },
        },
      },
    });
    renderPane();
    await settle();

    const paused = screen.getByText(/preview paused/i);
    expect(paused).toBeInTheDocument();
    expect(paused.textContent).toContain('23');
    expect(frame()).toBeNull();
  });

  it('a 500 shows the unavailable alert', async () => {
    stubFetch({ status: 500, body: { error: { code: 'internal_error' } } });
    renderPane();
    await settle();

    const alert = screen.getByRole('alert');
    expect(alert.textContent ?? '').toMatch(/temporarily unavailable/i);
  });

  it('a network failure shows the unavailable alert too', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fn);
    renderPane();
    await settle();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

/**
 * T156 measurement 2 / T155 finding U7 — the reservation was 16 px SHORT of
 * the ready height, every time. `py-2` sat on the same border-box that carried
 * `minHeight: PREVIEW_PANE_FRAME_HEIGHT`, so the reservation INCLUDED the
 * padding while the ready state was a full-height iframe PLUS it. Today the
 * shift is contained only by DOM ordering; the moment anything renders after
 * the pane it becomes visible movement.
 *
 * jsdom lays nothing out, so the pin is structural: the box that reserves must
 * carry no vertical padding of its own, and the frame handed to the ready
 * state must be the same number it reserves.
 */
describe('U7 — the reservation equals the ready height', () => {
  const reservedBox = (): HTMLElement =>
    screen.getByTestId('preview-pane-frame-reservation');

  it('the reserving box carries the frame height and NO vertical padding', async () => {
    stubFetch();
    renderPane({ bodyHtml: '' });

    const box = reservedBox();
    expect(box.style.minHeight).toBe(`${PREVIEW_PANE_FRAME_HEIGHT}px`);
    // Padding on the reserving border-box is exactly the U7 bug.
    expect(box.className).not.toMatch(/\b(py|pt|pb)-/);
  });

  it('the ready iframe is the height that was reserved — same box, same number', async () => {
    stubFetch();
    renderPane();
    const emptyMinHeight = reservedBox().style.minHeight;

    await settle();

    expect(frame()!.style.height).toBe(`${PREVIEW_PANE_FRAME_HEIGHT}px`);
    // The container the member sees did not change its reservation between
    // the two states.
    expect(reservedBox().style.minHeight).toBe(emptyMinHeight);
  });
});

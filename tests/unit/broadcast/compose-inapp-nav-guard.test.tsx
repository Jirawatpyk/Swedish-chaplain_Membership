/**
 * F119 portal live walk U27 (US6-AS9, FR-045, SC-012 — the in-app arm).
 *
 * The unsaved-changes guard covered `beforeunload` only, which the browser
 * fires for a close, a reload or an EXTERNAL navigation. It does not fire for
 * an in-app `<Link>` — and the member shell puts four header links directly
 * above the compose form and five fixed bottom-tab links directly below it, so
 * the unguarded exit is the near one. Measured live 2026-09-22: a dirty form
 * lost its draft, silently, on a click of "Dashboard".
 *
 * Asserted through the real `<ComposeForm>` plus a shell-like anchor beside it,
 * because the interception is a document-level capture listener: what is under
 * test is whether a click on an ordinary link is stopped, not a hook's return
 * value.
 *
 * Rendered under `NextIntlClientProvider` with the REAL `en.json` so a dangling
 * `t()` reference fails here rather than shipping a raw key path (next-intl
 * does not throw on a missing key).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ComposeForm } from '@/components/broadcast/compose-form';

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/components/broadcast/recipient-count', () => ({
  useRecipientCount: () => ({ status: 'idle' }),
  RecipientCountLine: () => null,
}));
vi.mock('@/components/broadcast/preview-pane', () => ({
  PreviewPane: () => <section aria-label="Preview" />,
}));

vi.mock('@/components/ui/tiptap-loader', () => ({
  loadTiptapEditor: () =>
    function TiptapStub(props: {
      initialHtml: string;
      onChange: (html: string) => void;
    }): React.ReactElement {
      return (
        <textarea
          aria-label="Message body"
          defaultValue={props.initialHtml}
          onChange={(e) => props.onChange(e.target.value)}
        />
      );
    },
}));

/**
 * The shell links the walk measured, as plain anchors. `preventDefault` on the
 * anchor's OWN handler only silences jsdom's unimplemented navigation: the
 * guard listens in the CAPTURE phase on `document`, so it decides before this
 * bubble-phase handler has run.
 */
function renderFormWithShellLinks(): void {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {/* The portal `[...unknown]` catch-all makes every `/portal/*` href a
          page to this rule; the anchor is a stand-in for the `<a>` a shell
          `<Link>` renders, which is exactly what the guard listens for. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/portal/dashboard" onClick={(e) => e.preventDefault()}>
        Dashboard
      </a>
      <a href="/portal/dashboard" target="_blank" rel="noreferrer" onClick={(e) => e.preventDefault()}>
        Dashboard in a new tab
      </a>
      <a href="https://example.com/elsewhere" onClick={(e) => e.preventDefault()}>
        Somewhere else
      </a>
      <ComposeForm audienceCeiling={5000} audienceMode="primary_only" />
    </NextIntlClientProvider>,
  );
}

const subjectInput = (): HTMLInputElement =>
  screen.getByLabelText('Subject') as HTMLInputElement;

beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom (Base UI dispatches these)
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
  // The shared setup installs fake timers; userEvent schedules its inter-key
  // delay on them and never resolves under them.
  vi.useRealTimers();
  pushMock.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('U27 — a dirty compose form guards IN-APP navigation, not only unload', () => {
  it('a dirty form intercepts a shell link click and asks before navigating', async () => {
    const user = userEvent.setup();
    renderFormWithShellLinks();

    await user.type(subjectInput(), 'Half-written subject');

    await user.click(screen.getByRole('link', { name: 'Dashboard' }));

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('cancel keeps the text and does not navigate', async () => {
    const user = userEvent.setup();
    renderFormWithShellLinks();

    await user.type(subjectInput(), 'Half-written subject');
    await user.click(screen.getByRole('link', { name: 'Dashboard' }));
    await screen.findByRole('alertdialog');

    await user.click(screen.getByRole('button', { name: 'Stay on this page' }));

    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    );
    expect(pushMock).not.toHaveBeenCalled();
    expect(subjectInput().value).toBe('Half-written subject');
  });

  it('confirm navigates', async () => {
    const user = userEvent.setup();
    renderFormWithShellLinks();

    await user.type(subjectInput(), 'Half-written subject');
    await user.click(screen.getByRole('link', { name: 'Dashboard' }));
    await screen.findByRole('alertdialog');

    await user.click(screen.getByRole('button', { name: 'Leave the page' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/portal/dashboard'));
  });

  it('a clean form does not intercept', async () => {
    const user = userEvent.setup();
    renderFormWithShellLinks();

    await user.click(screen.getByRole('link', { name: 'Dashboard' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('cmd/ctrl-click, target=_blank and an external origin are never intercepted', async () => {
    const user = userEvent.setup();
    renderFormWithShellLinks();

    await user.type(subjectInput(), 'Half-written subject');

    fireEvent.click(screen.getByRole('link', { name: 'Dashboard' }), {
      ctrlKey: true,
    });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Dashboard' }), {
      metaKey: true,
    });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Dashboard' }), {
      shiftKey: true,
    });
    fireEvent.click(screen.getByRole('link', { name: 'Dashboard' }), {
      altKey: true,
    });
    fireEvent.click(screen.getByRole('link', { name: 'Dashboard' }), {
      button: 1,
    });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('link', { name: 'Dashboard in a new tab' }),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Somewhere else' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('a click on a same-origin CTA inside the editor places the cursor, it is not a navigation', async () => {
    // The CTA block serialises as `<a data-eb="cta" href>` with NO `target`
    // (unlike a Link mark, which renders `_blank`), so a CTA pointing back at
    // the portal is a same-origin anchor. Inside the contenteditable the click
    // only moves the caret; intercepting it offered "Leave" off the draft.
    const user = userEvent.setup();
    let seenDefaultPrevented: boolean | null = null;
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <div
          contentEditable
          suppressContentEditableWarning
          onClick={(e) => {
            seenDefaultPrevented = e.defaultPrevented;
            e.preventDefault();
          }}
        >
          <a data-eb="cta" href={`${window.location.origin}/portal/events`}>
            Register now
          </a>
        </div>
        <ComposeForm audienceCeiling={5000} audienceMode="primary_only" />
      </NextIntlClientProvider>,
    );

    await user.type(subjectInput(), 'Half-written subject');
    fireEvent.click(screen.getByText('Register now'));

    // Reached the editor's own handler (not stopped), with default intact.
    expect(seenDefaultPrevented).toBe(false);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

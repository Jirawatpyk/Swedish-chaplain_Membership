// @vitest-environment jsdom
/**
 * F119 T093 / T104 (US3-AS7, FR-043) — the Preview dialog.
 *
 * FR-043 asks for "the complete email as a recipient receives it … in the
 * recipient's likely widths (desktop 600 px and phone 375 px)". The document
 * is the SAME bytes at both widths — only the viewport around it changes, so
 * what the member approves is what is delivered. The control returns focus to
 * the Preview button on close (WCAG 2.1 AA SC 2.4.3) and inherits the shared
 * Dialog's reduced-motion handling.
 *
 * Rendered under `NextIntlClientProvider` with the REAL `en.json` — a dangling
 * `t()` reference fails here rather than shipping a raw key path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { PreviewDialog } from '@/components/broadcast/preview-dialog';
import type { PreviewState } from '@/components/broadcast/use-preview-html';

const DOCUMENT_HTML =
  '<!DOCTYPE html><html lang="en"><body>' +
  '<header>Thai-Swedish Chamber of Commerce</header>' +
  '<h1>Spring update</h1><p>Hello members</p>' +
  '<footer>You can <a href="https://example.test/u">unsubscribe</a> at any time.</footer>' +
  '</body></html>';

const READY: PreviewState = { status: 'ready', html: DOCUMENT_HTML };

function renderDialog(state: PreviewState = READY) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PreviewDialog state={state} />
    </NextIntlClientProvider>,
  );
}

const trigger = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /^preview$/i }) as HTMLButtonElement;

const frame = (): HTMLIFrameElement =>
  document.querySelector('iframe') as HTMLIFrameElement;

// The shared setup installs FAKE timers; `userEvent` schedules its inter-event
// delay on them, so without this every interaction case dies on the timeout.
beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('T093 — the dialog shows the complete email at both recipient widths', () => {
  it('opens on the Preview button and shows header, body and the unsubscribe footer', async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(document.querySelector('iframe')).toBeNull();

    await user.click(trigger());

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading')).toBeInTheDocument();
    const srcdoc = frame().getAttribute('srcdoc') ?? '';
    expect(srcdoc).toBe(DOCUMENT_HTML);
    expect(srcdoc).toContain('Thai-Swedish Chamber of Commerce');
    expect(srcdoc).toContain('Hello members');
    expect(srcdoc).toContain('unsubscribe');
    // Sandboxed, no network from inside, and never injected into this page.
    //
    // DO NOT RELAX THIS. Security review F1-1 (2026-09-22): the design-block
    // renderer's output is deliberately never re-sanitised (Outlook needs the
    // platform's `bgcolor` + inline styles), so `sandbox=""` — the EMPTY
    // allow-list, no scripts, no forms, no navigation — is the last barrier
    // between that markup and this origin. See
    // `tests/unit/broadcasts/infrastructure/sanitizer-design-block-splice.test.ts`.
    expect(frame().getAttribute('sandbox')).toBe('');
    expect(frame().hasAttribute('src')).toBe(false);
    expect(dialog.querySelector('h1')).toBeNull();
  });

  it('starts at desktop 600 px and switches to phone 375 px with the SAME bytes', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(trigger());

    const desktop = screen.getByRole('button', { name: /desktop/i });
    const phone = screen.getByRole('button', { name: /phone/i });
    expect(desktop).toHaveAttribute('aria-pressed', 'true');
    expect(phone).toHaveAttribute('aria-pressed', 'false');
    expect(frame().style.width).toBe('600px');
    const before = frame().getAttribute('srcdoc');

    await user.click(phone);

    expect(phone).toHaveAttribute('aria-pressed', 'true');
    expect(desktop).toHaveAttribute('aria-pressed', 'false');
    expect(frame().style.width).toBe('375px');
    expect(frame().getAttribute('srcdoc')).toBe(before);

    await user.click(desktop);
    expect(frame().style.width).toBe('600px');
  });

  it('the width control is a labelled group, not two unrelated buttons', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(trigger());
    const group = screen.getByRole('group', { name: /preview width/i });
    expect(within(group).getAllByRole('button')).toHaveLength(2);
  });
});

describe('T093 — focus returns to the Preview button, and motion is reduced-motion aware', () => {
  it('closing the dialog lands focus back on the trigger, not on whatever had focus before', async () => {
    const user = userEvent.setup();
    // Base UI's DEFAULT is "restore focus to the element that had it before
    // the dialog opened". A `user.click()` on the trigger makes that element
    // the trigger anyway, so the default and `finalFocus` are
    // indistinguishable — the assertion would pass with the prop deleted
    // (verified by mutation). Open it the way a programmatic open behaves:
    // focus lives ELSEWHERE, and only `finalFocus` can name the trigger.
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <button type="button">Elsewhere</button>
        <PreviewDialog state={READY} />
      </NextIntlClientProvider>,
    );
    const elsewhere = screen.getByRole('button', { name: /elsewhere/i });
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    fireEvent.click(trigger()); // does NOT move focus
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger());
    });
  });

  it('the dialog surface carries the shared reduced-motion duration token', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(trigger());
    const dialog = await screen.findByRole('dialog');
    expect(dialog.className).toContain('motion-reduce:duration-0');
  });
});

describe('T104 — a preview that is not ready yet still opens honestly', () => {
  it('a paused (429) state names the wait instead of showing a stale document', async () => {
    const user = userEvent.setup();
    renderDialog({ status: 'paused', retryAfterSeconds: 23 });
    await user.click(trigger());
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/preview paused/i).textContent).toContain('23');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('an empty message says so rather than opening an empty frame', async () => {
    const user = userEvent.setup();
    renderDialog({ status: 'empty' });
    await user.click(trigger());
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/your message preview appears here/i),
    ).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });
});

/**
 * F119 T095 (US6-AS9, FR-045, SC-012 — the draft-saving arm).
 *
 * The unsaved-changes guard must compare against what was last SAVED, not
 * against the props the page mounted with. Today `compose-form.tsx:203-217`
 * compares `subject`/`bodyHtml` to the immutable `initialSubject`/
 * `initialBodyHtml` props, so a member who saved a draft and touched nothing
 * since is still warned on the way out — and learns to ignore the warning.
 *
 * `beforeunload` is asserted the way the browser decides whether to prompt:
 * dispatch a cancelable `beforeunload` and read `defaultPrevented`.
 *
 * Rendered under `NextIntlClientProvider` with the REAL `en.json` so a dangling
 * `t()` reference fails here rather than shipping a raw key path.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ComposeForm } from '@/components/broadcast/compose-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
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

/** True when the browser would show the "leave site?" prompt. */
function beforeUnloadWouldPrompt(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function renderForm(): void {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComposeForm audienceCeiling={5000} audienceMode="primary_only" />
    </NextIntlClientProvider>,
  );
}

const subjectInput = (): HTMLInputElement =>
  screen.getByLabelText('Subject') as HTMLInputElement;

const saveDraftButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /Save as draft/ }) as HTMLButtonElement;

/** One draft-save round trip that succeeds. */
function stubDraftSaveOk(): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ broadcastId: '11111111-1111-4111-8111-111111111111' }),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
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
  stubDraftSaveOk();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('T095 — the dirty guard tracks the SAVED snapshot', () => {
  it('after a successful draft save with no further edit, no beforeunload warning fires', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(subjectInput(), 'Spring mixer');
    // Precondition: unsaved typing DOES warn — otherwise the assertion below
    // would pass against a guard that never arms at all.
    expect(beforeUnloadWouldPrompt()).toBe(true);

    await user.click(saveDraftButton());
    await waitFor(() => expect(saveDraftButton()).not.toBeDisabled());

    expect(beforeUnloadWouldPrompt()).toBe(false);
  });

  it('an edit after the save warns again', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(subjectInput(), 'Spring mixer');
    await user.click(saveDraftButton());
    await waitFor(() => expect(saveDraftButton()).not.toBeDisabled());
    expect(beforeUnloadWouldPrompt()).toBe(false);

    await user.type(subjectInput(), '!');

    expect(beforeUnloadWouldPrompt()).toBe(true);
  });

  it('shows a busy state on the save control while the draft is in flight', async () => {
    const user = userEvent.setup();
    let release: (value: unknown) => void = () => {};
    const inFlight = new Promise((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        await inFlight;
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );
    renderForm();

    await user.type(subjectInput(), 'Spring mixer');
    await user.click(saveDraftButton());

    await waitFor(() => expect(saveDraftButton()).toHaveAttribute('aria-busy', 'true'));

    release(undefined);
    await waitFor(() =>
      expect(saveDraftButton()).not.toHaveAttribute('aria-busy', 'true'),
    );
  });

  it('shows a "Saved at HH:MM" indicator once the draft is saved', async () => {
    const user = userEvent.setup();
    renderForm();

    expect(screen.queryByTestId('compose-saved-at')).not.toBeInTheDocument();

    await user.type(subjectInput(), 'Spring mixer');
    await user.click(saveDraftButton());

    const indicator = await screen.findByTestId('compose-saved-at');
    // Locale-aware time, not a hand-rolled string: a real clock time is
    // present, and the label is the translated one.
    expect(indicator.textContent ?? '').toMatch(/\d{1,2}[:.]\d{2}/);
    expect(indicator.textContent ?? '').toMatch(/Saved at/);
  });
});

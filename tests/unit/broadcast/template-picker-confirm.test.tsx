/**
 * F119 T133 (US6-AS1, FR-046, SC-012 — the template-selection arm).
 *
 * Picking a template while the subject or the message is non-empty must ask
 * first, and a "no" must leave every character where it was. Today the picker
 * `router.push(?template=…)`es and `new/page.tsx` remounts `<ComposeForm>` via
 * `key=`, so the typed text is gone before the member knows a choice was made.
 *
 * The combobox popup itself is NOT opened here: Base UI / cmdk popovers
 * deadlock under jsdom + React 19 (documented in `member-picker.test.tsx` and
 * `tests/unit/broadcasts/components/approve-reject-final-focus.test.ts`), so
 * `ComposeTemplatePicker` is replaced by a plain-button double that calls the
 * SAME `onSelect(id)` contract the real picker calls. What is under test is the
 * confirm-and-re-seed wiring above the picker, not the popup.
 *
 * Rendered under `NextIntlClientProvider` with the REAL `en.json` so a dangling
 * `t()` reference fails here instead of shipping a raw key path (next-intl does
 * not throw on a missing key).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ComposeForm } from '@/components/broadcast/compose-form';
import type { ComposeTemplateOption } from '@/components/broadcast/compose/template-picker-field';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// The live count and the preview each own a debounced fetch; neither is the
// subject of this suite and both would otherwise land state updates after the
// assertions.
vi.mock('@/components/broadcast/recipient-count', () => ({
  useRecipientCount: () => ({ status: 'idle' }),
  RecipientCountLine: () => null,
}));
vi.mock('@/components/broadcast/preview-pane', () => ({
  PreviewPane: () => <section aria-label="Preview" />,
}));

/** The picker double — the real popup is untestable in jsdom (see the header). */
vi.mock('@/components/broadcast/compose/template-picker', () => ({
  ComposeTemplatePicker: ({
    templates,
    onSelect,
  }: {
    templates: readonly { id: string; name: string }[];
    onSelect: (id: string | null) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onSelect(null)}>
        pick-blank
      </button>
      {templates.map((tpl) => (
        <button key={tpl.id} type="button" onClick={() => onSelect(tpl.id)}>
          {`pick-${tpl.id}`}
        </button>
      ))}
    </div>
  ),
}));

/**
 * Tiptap needs browser DOM and is dynamic-imported through the loader; the
 * double exposes the props the form hands it so "re-seeded in place" is
 * observable, and a textarea so the body can be typed into.
 */
vi.mock('@/components/ui/tiptap-loader', () => ({
  loadTiptapEditor: () =>
    function TiptapStub(props: {
      initialHtml: string;
      onChange: (html: string) => void;
      describedById?: string;
      invalid?: boolean;
    }): React.ReactElement {
      return (
        <div
          data-testid="tiptap-editor"
          data-initial-html={props.initialHtml}
          data-invalid={props.invalid === true ? 'true' : 'false'}
          data-describedby={props.describedById ?? ''}
        >
          <textarea
            aria-label="Message body"
            defaultValue={props.initialHtml}
            onChange={(e) => props.onChange(e.target.value)}
          />
        </div>
      );
    },
}));

const TEMPLATE: ComposeTemplateOption = {
  id: 't1',
  name: 'Welcome',
  locale: 'en',
  isSeeded: false,
  subject: 'Template subject',
  bodyHtml: '<p>Template body</p>',
};

function renderForm(): void {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComposeForm
        audienceCeiling={5000}
        audienceMode="primary_only"
        templates={[TEMPLATE]}
      />
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
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('T133 — template selection never destroys typed content', () => {
  it('with typed content, selecting a template opens a confirmation and cancelling leaves the text intact', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(subjectInput(), 'My own subject');
    await user.type(screen.getByLabelText('Message body'), '<p>My own body</p>');

    await user.click(screen.getByRole('button', { name: 'pick-t1' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Keep my message' }));

    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    );
    expect(subjectInput().value).toBe('My own subject');
    expect(
      (screen.getByLabelText('Message body') as HTMLTextAreaElement).value,
    ).toContain('My own body');
  });

  it('confirming re-seeds the subject and the message in place, without remounting the form', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(subjectInput(), 'My own subject');
    const inputBefore = subjectInput();

    await user.click(screen.getByRole('button', { name: 'pick-t1' }));
    await screen.findByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: 'Use the template' }));

    await waitFor(() => expect(subjectInput().value).toBe('Template subject'));
    // Re-seeded IN PLACE: the same subject <input> node survived, so nothing
    // else the member had entered (segment, schedule, custom list) was thrown
    // away by a remount.
    expect(subjectInput()).toBe(inputBefore);
    expect(screen.getByTestId('tiptap-editor')).toHaveAttribute(
      'data-initial-html',
      '<p>Template body</p>',
    );
  });

  it('with an empty subject and message, selecting a template applies it with no confirmation', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'pick-t1' }));

    await waitFor(() => expect(subjectInput().value).toBe('Template subject'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

/**
 * F119 T099 (FR-040) — the alt-text GATE, asserted against the real editor.
 *
 * Senior-tester review BLOCKER: `src/components/broadcast/tiptap-editor.tsx`
 * was mounted by ZERO tests. Every compose suite stubs it
 * (`compose-dirty-state`, `compose-body-error-announced`,
 * `proxy-compose-parity`, `template-picker-confirm`,
 * `proxy-compose-missing-email`), so the one piece of logic that file owns —
 * the two-half handshake between the description dialog and the uploader —
 * had no coverage at all. The surviving mutation that proved it:
 *
 *   onInsertImage={() => openAltDialog('inline')}
 *     →  onInsertImage={() => uploaderRef.current?.openPicker()}
 *
 * ships undescribed images (FR-040 violated, WCAG 1.1.1) with every test
 * green. `case (a)` below is what kills it.
 *
 * What is REAL here: the default export, a real `@tiptap/core` editor built
 * from `makeBroadcastEditorExtensions` (the way `tiptap-toolbar-a11y.test.tsx`
 * builds one), the real `TiptapToolbar`, and the real `ImageAltDialog` under
 * `NextIntlClientProvider` with the REAL `en.json`. Only two collaborators are
 * doubled, and neither carries gate logic: the uploader (a file input + a
 * `fetch` to the upload route — the test needs to SEE `openPicker` and to
 * drive `onUploaded` by hand) and the ClamAV banner (a 30 s `fetch` poll).
 *
 * The three paths, and the mutation each one kills:
 *   (a) toolbar-first  — describe, THEN pick a file. Kills the mutation above.
 *   (b) uploader-first — upload, THEN describe; nothing is inserted until the
 *       description is in hand. Kills `handleUploaded` inserting on a null
 *       pending entry.
 *   (c) cancel         — an abandoned description is not inherited by the next
 *       upload: the author is asked again, and the image that lands carries
 *       the NEW description.
 *   (d) dismissed picker — describe, Insert, then close the file picker with no
 *       file: the next upload through the uploader's own button is asked for
 *       its own description (the stale `{ kind, alt }` was being attached).
 *       Its second case runs the REAL uploader, since the stub cannot prove
 *       the input's native `cancel` event is wired; its third proves the
 *       uploader's own button reports the dismissal too (browsers without the
 *       event), while `openPicker()` — the alt-first hand-off — does not.
 *   (a) also kills clearing `pendingImageRef` UNCONDITIONALLY on close (`if
 *       (!next)`): the confirmed description must survive the dialog's own
 *       close render, or the upload that follows finds nothing to attach and
 *       re-asks. Verified by mutation.
 *
 * Measured and recorded rather than claimed: the CONVERSE mutation — never
 * clearing (`if (false)`) — SURVIVES all four cases. `handleUploaded` and
 * `openAltDialog` both overwrite the pending entry on every path a cancel can
 * reach, so a stale `{ kind }` with no `alt` is unobservable from this seam.
 * The clear is defence-in-depth, not behaviour; (c) pins the behaviour that IS
 * observable (no image without its own description) and does not pretend to
 * kill that mutant.
 */
import { useImperativeHandle } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import TiptapEditor from '@/components/broadcast/tiptap-editor';

const mocks = vi.hoisted(() => ({
  openPicker: vi.fn<() => void>(),
  /** The editor's own `handleUploaded`, captured so the test can drive it. */
  onUploaded: { current: null as ((blobUrl: string) => void) | null },
  /** The editor's picker-cancel handler, captured so the test can dismiss the picker. */
  onPickerCancel: { current: null as (() => void) | null },
}));

vi.mock('@/components/broadcast/clamav-unreachable-banner', () => ({
  ClamavUnreachableBanner: (): null => null,
}));

vi.mock('@/components/broadcast/compose-inline-image-uploader', () => ({
  ComposeInlineImageUploader: (props: {
    readonly onUploaded: (blobUrl: string) => void;
    readonly onPickerCancel?: () => void;
    readonly ref?: React.Ref<{ openPicker(): void }>;
  }): React.ReactElement => {
    mocks.onUploaded.current = props.onUploaded;
    mocks.onPickerCancel.current = props.onPickerCancel ?? null;
    useImperativeHandle(props.ref, () => ({ openPicker: mocks.openPicker }), []);
    return <span data-testid="uploader-stub" />;
  },
}));

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const DRAFT_ID = '11111111-1111-1111-1111-111111111111';
const BLOB_URL = 'https://assets.swecham.example/broadcasts/images/a1b2.png';

async function renderEditor(): Promise<void> {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TiptapEditor
        initialHtml="<p>hello</p>"
        onChange={() => {}}
        imagesEnabled
        draftId={DRAFT_ID}
      />
    </NextIntlClientProvider>,
  );
  // `immediatelyRender: false` — the editor is created in an effect, so the
  // first paint is the placeholder and the toolbar arrives a tick later.
  await screen.findByRole('toolbar');
}

/** Images actually committed into the document — the thing FR-040 gates. */
function insertedImages(): HTMLImageElement[] {
  const shell = screen.getByTestId('tiptap-editor');
  return [...shell.querySelectorAll('img')];
}

const imageControl = (): HTMLElement => screen.getByRole('button', { name: 'Image' });
const altField = (): HTMLElement => screen.getByLabelText(/image description/i);
const insertControl = (): HTMLElement =>
  screen.getByRole('button', { name: 'Insert image' });

/**
 * Inserting a node makes ProseMirror scroll the selection into view, and its
 * `singleRect` calls `Range.getClientRects()` — which jsdom does not
 * implement, so the insert throws asynchronously and Vitest reports an
 * unhandled error while the test itself still passes. A single zero-sized rect
 * is enough: nothing here asserts geometry.
 */
beforeAll(() => {
  const zero = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 };
  const rects = Object.assign([zero], { item: () => zero }) as unknown as DOMRectList;
  if (typeof Range.prototype.getClientRects !== 'function') {
    Range.prototype.getClientRects = () => rects;
  }
  if (typeof Range.prototype.getBoundingClientRect !== 'function') {
    Range.prototype.getBoundingClientRect = () => zero as DOMRect;
  }
});

// The shared `tests/setup.ts` installs FAKE timers; `userEvent` schedules its
// inter-event delay on them, so every interaction would die on the timeout.
beforeEach(() => {
  vi.useRealTimers();
  mocks.openPicker.mockClear();
  mocks.onUploaded.current = null;
  mocks.onPickerCancel.current = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('T099 (a) — toolbar first: the description is collected BEFORE the file picker', () => {
  it('opens the description dialog and does not reach the file picker until Insert', async () => {
    const user = userEvent.setup();
    await renderEditor();

    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(imageControl());

    // The gate: a dialog, not a file picker.
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(altField()).toBeInTheDocument();
    expect(
      mocks.openPicker,
      'the file picker must not open until a description exists (FR-040)',
    ).not.toHaveBeenCalled();
    expect(insertedImages()).toHaveLength(0);

    await user.type(altField(), 'Chart of member growth');
    await user.click(insertControl());

    expect(mocks.openPicker).toHaveBeenCalledTimes(1);
  });

  it('the confirmed description survives the close and lands on the uploaded image', async () => {
    const user = userEvent.setup();
    await renderEditor();

    await user.click(imageControl());
    await screen.findByRole('dialog');
    await user.type(altField(), 'Chart of member growth');
    await user.click(insertControl());
    expect(mocks.openPicker).toHaveBeenCalledTimes(1);

    // The upload resolves after the dialog has closed — the half already in
    // hand has to survive that render, or the author is asked twice.
    act(() => mocks.onUploaded.current!(BLOB_URL));

    await waitFor(() => expect(insertedImages()).toHaveLength(1));
    const img = insertedImages()[0]!;
    expect(img.getAttribute('src')).toBe(BLOB_URL);
    expect(img.getAttribute('alt')).toBe('Chart of member growth');
    // …and it did NOT re-ask.
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('T099 (b) — uploader first: nothing is inserted before a description exists', () => {
  it('an upload with no pending description opens the dialog with the document still image-free', async () => {
    const user = userEvent.setup();
    await renderEditor();

    act(() => mocks.onUploaded.current!(BLOB_URL));

    await screen.findByRole('dialog');
    expect(
      insertedImages(),
      'the node must not exist before its description does (FR-040)',
    ).toHaveLength(0);

    await user.type(altField(), 'Chamber logo');
    await user.click(insertControl());

    await waitFor(() => expect(insertedImages()).toHaveLength(1));
    expect(insertedImages()[0]!.getAttribute('alt')).toBe('Chamber logo');
    expect(insertedImages()[0]!.getAttribute('src')).toBe(BLOB_URL);
    // The picker is never opened on this leg — the file is already in.
    expect(mocks.openPicker).not.toHaveBeenCalled();
  });
});

describe('T099 (c) — Cancel abandons the insert; the next upload does not inherit it', () => {
  it('a cancelled description is not attached to whatever is uploaded next', async () => {
    const user = userEvent.setup();
    await renderEditor();

    await user.click(imageControl());
    await screen.findByRole('dialog');
    await user.type(altField(), 'Abandoned description');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.openPicker).not.toHaveBeenCalled();
    expect(insertedImages()).toHaveLength(0);

    // A later upload must be asked for its OWN description…
    act(() => mocks.onUploaded.current!(BLOB_URL));
    await screen.findByRole('dialog');
    expect(insertedImages()).toHaveLength(0);

    await user.type(altField(), 'The real description');
    await user.click(insertControl());

    await waitFor(() => expect(insertedImages()).toHaveLength(1));
    expect(insertedImages()[0]!.getAttribute('alt')).toBe('The real description');
  });
});

describe('T099 (d) — a DISMISSED file picker abandons the described insert', () => {
  it('cancel the picker, then upload through the uploader: the author is asked again', async () => {
    const user = userEvent.setup();
    await renderEditor();

    await user.click(imageControl());
    await screen.findByRole('dialog');
    await user.type(altField(), 'Stale description');
    await user.click(insertControl());
    expect(mocks.openPicker).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // The author closes the OS file picker without choosing a file.
    act(() => mocks.onPickerCancel.current?.());

    // A later upload through the uploader's own button must not inherit the
    // abandoned description (or kind) — it is asked for its own.
    act(() => mocks.onUploaded.current!(BLOB_URL));
    await screen.findByRole('dialog');
    expect(insertedImages()).toHaveLength(0);

    await user.type(altField(), 'Fresh description');
    await user.click(insertControl());
    await waitFor(() => expect(insertedImages()).toHaveLength(1));
    expect(insertedImages()[0]!.getAttribute('alt')).toBe('Fresh description');
  });

  it('the real uploader reports a dismissed picker (the file input `cancel` event)', async () => {
    const { ComposeInlineImageUploader } = await vi.importActual<
      typeof import('@/components/broadcast/compose-inline-image-uploader')
    >('@/components/broadcast/compose-inline-image-uploader');
    const onPickerCancel = vi.fn();
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ComposeInlineImageUploader
          draftId={DRAFT_ID}
          onUploaded={() => {}}
          onPickerCancel={onPickerCancel}
        />
      </NextIntlClientProvider>,
    );
    const input = container.querySelector('input[type="file"]')!;

    act(() => {
      input.dispatchEvent(new Event('cancel'));
    });

    expect(onPickerCancel).toHaveBeenCalledTimes(1);
  });

  // Browsers without the input `cancel` event (Safari < 16.4) never report the
  // dismissal. The uploader's OWN button is the other guard: when it can be
  // clicked, no picker the description opened is still open, so the pending
  // description is abandoned. `openPicker()` (the alt-first flow) must not.
  it('the uploader’s own button reports the abandoned picker; openPicker (alt-first) does not', async () => {
    const { ComposeInlineImageUploader } = await vi.importActual<
      typeof import('@/components/broadcast/compose-inline-image-uploader')
    >('@/components/broadcast/compose-inline-image-uploader');
    const onPickerCancel = vi.fn();
    const handle: { current: { openPicker(): void } | null } = { current: null };
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ComposeInlineImageUploader
          ref={handle}
          draftId={DRAFT_ID}
          onUploaded={() => {}}
          onPickerCancel={onPickerCancel}
        />
      </NextIntlClientProvider>,
    );

    act(() => handle.current!.openPicker());
    expect(onPickerCancel).not.toHaveBeenCalled();

    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', {
        name: enMessages.portal.broadcasts.compose.imageUpload.uploadButton,
      }),
    );
    expect(onPickerCancel).toHaveBeenCalledTimes(1);
  });
});

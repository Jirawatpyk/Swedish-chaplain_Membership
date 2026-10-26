/**
 * Spec 122 US12d-2, round 3 — the findings of the UX and mobile-a11y reviews
 * of round 2 (PR #655), against the real editor, toolbar and dialogs.
 *
 *  B1  `setEditable` emitted an update, so the host's `onChange` ran when
 *      `disabled` flipped back after a refused submit and wiped the server's
 *      error (and the disallowed-image list) the author needed.
 *  The rest: the button block reads as a button to a screen reader and Enter
 *  edits it (no longer deletes it); the toolbar names its edit mode; the
 *  placeholder is announced only while the message is empty; the hidden file
 *  input is out of reach; one channel per insert; repeated and history
 *  announcements; focus after a saved description; the link hint matches
 *  what a blank field does; an email address is told it needs `mailto:`; a
 *  button can be removed from its dialog; selected words keep their spaces;
 *  the sticky toolbar gives way on short screens and the caret stays clear
 *  of it; the ClamAV probe is aborted on unmount.
 */
import { useImperativeHandle } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { Editor } from '@tiptap/core';
import enMessages from '@/i18n/messages/en.json';
import { toast } from '@/lib/toast';

const uploaderMocks = vi.hoisted(() => ({
  real: { current: true },
  props: { current: null as null | { readonly onUploaded: (blobUrl: string) => void } },
}));

vi.mock('@/lib/toast', () => ({
  toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/components/broadcast/compose-inline-image-uploader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/broadcast/compose-inline-image-uploader')>();
  return {
    ...actual,
    ComposeInlineImageUploader: (props: React.ComponentProps<typeof actual.ComposeInlineImageUploader>) => {
      if (uploaderMocks.real.current) return <actual.ComposeInlineImageUploader {...props} />;
      uploaderMocks.props.current = props;
      // eslint-disable-next-line react-hooks/rules-of-hooks -- a stub rendered on one branch per test
      useImperativeHandle(props.ref, () => ({ openPicker: () => {} }), []);
      return <span data-testid="uploader-stub" />;
    },
  };
});

const { default: TiptapEditor } = await import('@/components/broadcast/tiptap-editor');
const { TiptapToolbar } = await import('@/components/broadcast/tiptap-toolbar');
const { makeBroadcastEditorExtensions } = await import('@/components/broadcast/broadcast-editor-extensions');
const { ComposeInlineImageUploader } = await import('@/components/broadcast/compose-inline-image-uploader');
const { ClamavUnreachableBanner } = await import('@/components/broadcast/clamav-unreachable-banner');
const { loadTiptapEditor } = await import('@/components/shell/tiptap-loader');

const DRAFT = '11111111-1111-1111-1111-111111111111';
const CTA_HTML = '<p>Join us. <a data-eb="cta" href="https://swecham.example/register">Register now</a></p>';
const IMG_HTML = '<img src="https://assets.swecham.example/a.png" alt="Old words"><p>x</p>';

beforeAll(() => {
  const zero = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 };
  const rects = Object.assign([zero], { item: () => zero }) as unknown as DOMRectList;
  if (typeof Range.prototype.getClientRects !== 'function') Range.prototype.getClientRects = () => rects;
  if (typeof Range.prototype.getBoundingClientRect !== 'function') {
    Range.prototype.getBoundingClientRect = () => zero as DOMRect;
  }
});

const editors: Editor[] = [];

beforeEach(() => {
  vi.useRealTimers();
  uploaderMocks.real.current = true;
  uploaderMocks.props.current = null;
});

afterEach(() => {
  cleanup();
  for (const e of editors.splice(0)) e.destroy();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const wrap = (node: React.ReactNode): React.ReactElement => (
  <NextIntlClientProvider locale="en" messages={enMessages}>
    {node}
  </NextIntlClientProvider>
);

async function renderEditor(
  html: string,
  extra: Partial<React.ComponentProps<typeof TiptapEditor>> = {},
): Promise<{ container: HTMLElement; ed: Editor; rerender: (ui: React.ReactElement) => void }> {
  const props = { initialHtml: html, onChange: () => {}, imagesEnabled: true, draftId: DRAFT, ...extra };
  const { container, rerender } = render(wrap(<TiptapEditor {...props} />));
  await screen.findByRole('toolbar');
  const ed = (container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor;
  return { container, ed, rerender };
}

function mountToolbar(html: string): Editor {
  const ed = new Editor({
    element: document.createElement('div'),
    extensions: makeBroadcastEditorExtensions({ images: false }),
    content: html,
  });
  editors.push(ed);
  render(wrap(<TiptapToolbar editor={ed} onAnnounce={() => {}} />));
  return ed;
}

function posOfNode(ed: Editor, typeName: string): number {
  let found = -1;
  ed.state.doc.descendants((node, pos) => {
    if (found === -1 && node.type.name === typeName) found = pos;
  });
  return found;
}

const toolbar = (): HTMLElement => screen.getByRole('toolbar');
const control = (name: string | RegExp): HTMLElement => within(toolbar()).getByRole('button', { name });

describe('B1 — disabled flipping never reports a change', () => {
  it('does not call onChange when disabled turns on and off', async () => {
    const onChange = vi.fn();
    const Host = ({ disabled }: { readonly disabled: boolean }): React.ReactElement =>
      wrap(<TiptapEditor initialHtml="<p>hello</p>" onChange={onChange} disabled={disabled} />);
    const { rerender } = render(<Host disabled={false} />);
    await screen.findByRole('toolbar');
    rerender(<Host disabled />);
    rerender(<Host disabled={false} />);
    await waitFor(() => expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'true'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('the button block for keyboard and screen reader', () => {
  it('reads as a button with its address, and Enter opens "Edit button" instead of deleting it', async () => {
    const { ed } = await renderEditor(CTA_HTML);
    const block = ed.view.dom.querySelector('[data-eb="cta"]')!;
    expect(block.textContent).toContain('button, links to https://swecham.example/register');
    act(() => {
      ed.commands.setNodeSelection(posOfNode(ed, 'ctaButton'));
    });
    const before = ed.getHTML();
    act(() => {
      ed.view.someProp('handleKeyDown', (f) => f(ed.view, new KeyboardEvent('keydown', { key: 'Enter' })));
    });
    expect(ed.getHTML()).toBe(before);
    expect(within(screen.getByRole('dialog')).getByRole('heading', { name: 'Edit button' })).toBeInTheDocument();
  });

  it('names the edit mode: Button reads "Edit button" while a button is selected', () => {
    const ed = mountToolbar(CTA_HTML);
    act(() => {
      ed.commands.setNodeSelection(posOfNode(ed, 'ctaButton'));
    });
    expect(control('Edit button')).toBeInTheDocument();
  });

  it('the edit dialog can remove the button', () => {
    const ed = mountToolbar(CTA_HTML);
    act(() => {
      ed.commands.setNodeSelection(posOfNode(ed, 'ctaButton'));
    });
    fireEvent.click(control('Edit button'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove button' }));
    expect(ed.getHTML()).not.toContain('data-eb="cta"');
  });

  it('selected words keep the spaces around them when they become a button', () => {
    const ed = mountToolbar('<p>Join Register now today</p>');
    ed.commands.setTextSelection({ from: 5, to: 19 });
    fireEvent.click(control('Button'));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/button link/i), { target: { value: 'https://swecham.example/r' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Insert button' }));
    expect(ed.getHTML()).toBe('<p>Join <a data-eb="cta" href="https://swecham.example/r">Register now</a> today</p>');
  });
});

describe('images: edit mode, focus, one announcement', () => {
  it('Image reads "Edit image description" on a selected image; Banner does not edit an inline image', async () => {
    uploaderMocks.real.current = false;
    const { ed } = await renderEditor(IMG_HTML);
    act(() => {
      ed.commands.setNodeSelection(posOfNode(ed, 'image'));
    });
    expect(control('Edit image description')).toBeInTheDocument();
    fireEvent.click(control('Banner image'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Describe this banner' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/image description/i)).toHaveValue('');
  });

  it('saving a description returns focus to the text, titled "Edit image description"', async () => {
    uploaderMocks.real.current = false;
    const { ed, container } = await renderEditor(IMG_HTML);
    act(() => {
      ed.commands.setNodeSelection(posOfNode(ed, 'image'));
    });
    fireEvent.click(control('Edit image description'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Edit image description' })).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/image description/i), { target: { value: 'New words' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save description' }));
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector('.ProseMirror')));
  });

  it('an inserted image is said once: the toast "Image added.", not the live region too', async () => {
    uploaderMocks.real.current = false;
    const { container } = await renderEditor('<p>x</p>');
    act(() => uploaderMocks.props.current?.onUploaded('https://assets.swecham.example/b.png'));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/image description/i), { target: { value: 'The 2026 gala' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Insert image' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Image added.'));
    expect(within(container).getByTestId('tiptap-aria-live')).toHaveTextContent('');
  });
});

describe('placeholder, announcements and history', () => {
  it('aria-placeholder is there only while the message is empty', async () => {
    const { ed, container } = await renderEditor('');
    const area = container.querySelector('.ProseMirror')!;
    expect(area).toHaveAttribute('aria-placeholder', enMessages.broadcast.editor.placeholder);
    act(() => {
      ed.commands.insertContent('Dear members');
    });
    await waitFor(() => expect(area).not.toHaveAttribute('aria-placeholder'));
  });

  it('Undo is announced and carries its shortcut', async () => {
    const { ed, container } = await renderEditor('<p>hello</p>');
    act(() => {
      ed.commands.insertContentAt(1, 'well ');
    });
    expect(control('Undo')).toHaveAttribute('aria-keyshortcuts', 'Control+Z Meta+Z');
    fireEvent.click(control('Undo'));
    await waitFor(() => expect(within(container).getByTestId('tiptap-aria-live')).toHaveTextContent('Undone'));
  });

  it('the same announcement twice in a row is announced again', async () => {
    const { container } = await renderEditor('<p>hello</p>');
    const live = within(container).getByTestId('tiptap-aria-live');
    fireEvent.click(control('Divider'));
    await waitFor(() => expect(live).toHaveTextContent('Divider added'));
    const changes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => changes.push(...records));
    observer.observe(live, { childList: true, characterData: true, subtree: true });
    fireEvent.click(control('Divider'));
    await waitFor(() => expect(changes.length).toBeGreaterThan(0));
    await waitFor(() => expect(live).toHaveTextContent('Divider added'));
    observer.disconnect();
  });
});

describe('the link dialog', () => {
  it('says a blank text keeps the current words when there are some', () => {
    const ed = mountToolbar('<p>Read <a href="https://a.example">our report</a></p>');
    ed.commands.setTextSelection(9);
    fireEvent.click(control('Link'));
    expect(within(screen.getByRole('dialog')).getByText('Leave blank to keep the current words.')).toBeInTheDocument();
  });

  it('tells an email address it needs mailto:', async () => {
    mountToolbar('<p>Write to </p>');
    fireEvent.click(control('Link'));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/link address/i), { target: { value: 'info@swecham.example' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save link/i }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('mailto:info@swecham.example');
  });
});

describe('the uploader’s hidden input', () => {
  it('is hidden from assistive technology and disabled while the host is busy', () => {
    const { container } = render(wrap(<ComposeInlineImageUploader draftId={DRAFT} onUploaded={() => {}} disabled />));
    const input = container.querySelector('input[type="file"]')!;
    expect(input).toHaveAttribute('aria-hidden', 'true');
    expect(input).toBeDisabled();
  });

  it('a refusal stays described on the button after the toast is gone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'unknown' }), { status: 500 })));
    const { container } = render(wrap(<ComposeInlineImageUploader draftId={DRAFT} onUploaded={() => {}} />));
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    const message = await screen.findByText(enMessages.portal.broadcasts.compose.imageUpload.errors.unknown);
    const alertBox = message.closest('.aura-alert')!;
    const button = screen.getByRole('button', { name: enMessages.portal.broadcasts.compose.imageUpload.uploadButton });
    expect(button.getAttribute('aria-describedby')?.split(' ')).toContain(alertBox.id);
  });
});

describe('the sticky toolbar on short screens', () => {
  it('gives way below 30rem of height and sits under the portal header', async () => {
    await renderEditor('<p>x</p>');
    expect(toolbar()).toHaveClass('[@media(max-height:30rem)]:static', 'z-[5]');
  });

  it('keeps the caret clear of the toolbar (scroll margin)', async () => {
    const { ed } = await renderEditor('<p>x</p>');
    const margin = ed.view.someProp('scrollMargin');
    expect(typeof margin === 'object' ? margin.top : margin).toBeGreaterThan(8);
  });
});

describe('the loading skeleton', () => {
  it('is named by its own text (read once) and reserves the touch toolbar height', () => {
    const Loading = loadTiptapEditor<Record<string, never>>(
      () => new Promise<{ default: React.ComponentType<Record<string, never>> }>(() => {}),
    );
    render(wrap(<Loading />));
    const status = screen.getByTestId('tiptap-loading');
    expect(status).not.toHaveAttribute('aria-label');
    expect(status).toHaveAccessibleName(enMessages.shell.editorLoading);
    // Phones 104px (the boards' eight controls, two rows at 320px), touch
    // screens from 640px 104px (two rows), a mouse from 640px 40px (one row).
    expect(status.querySelector('[data-slot="skeleton-block"]')).toHaveClass(
      'h-[104px]',
      'sm:[@media(pointer:fine)]:h-10',
    );
  });
});

describe('the ClamAV probe', () => {
  it('aborts a probe still running when the banner unmounts', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Promise<Response>(() => {});
      }),
    );
    const { unmount } = render(wrap(<ClamavUnreachableBanner healthEndpoint="/api/test/clamav" />));
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal!.aborted).toBe(true);
  });
});

/**
 * Spec 122 US12d-2, round 2 (#6; the maintainer chose to fix it in this PR):
 * an inserted button or image can be edited.
 *
 * Before, a button block could only be deleted and rebuilt (its link had no
 * way back into the dialog), while its words were typeable in place, so an
 * author could empty it or run it past 60 characters and learn only at submit
 * (`validateBlocks` `cta_text_length`). An image's description could not be
 * changed after the insert. Now the button is one unit in the editor whose
 * words and link change through its dialog, and Image / Banner on a selected
 * image edits its description. The HTML the editor saves is unchanged.
 */
import { useImperativeHandle } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import enMessages from '@/i18n/messages/en.json';
import TiptapEditor from '@/components/broadcast/tiptap-editor';
import { TiptapToolbar } from '@/components/broadcast/tiptap-toolbar';
import { makeBroadcastEditorExtensions } from '@/components/broadcast/broadcast-editor-extensions';
import { broadcastCtaButtonExtension } from '@/lib/broadcast-editor-extensions';
import { findBlockMarkers, validateBlocks } from '@/modules/broadcasts/domain/design-blocks/block-markers';

vi.mock('@/components/broadcast/clamav-unreachable-banner', () => ({
  ClamavUnreachableBanner: (): null => null,
}));
vi.mock('@/components/broadcast/compose-inline-image-uploader', () => ({
  ComposeInlineImageUploader: (props: { readonly ref?: React.Ref<{ openPicker(): void }> }): React.ReactElement => {
    useImperativeHandle(props.ref, () => ({ openPicker: () => {} }), []);
    return <span data-testid="uploader-stub" />;
  },
}));
vi.mock('@/lib/toast', () => ({
  toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

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
});

afterEach(() => {
  cleanup();
  for (const e of editors.splice(0)) e.destroy();
});

const CTA_HTML = '<p>Join us. <a data-eb="cta" href="https://swecham.example/register">Register now</a></p>';

function mountToolbar(html: string): Editor {
  const ed = new Editor({
    element: document.createElement('div'),
    extensions: makeBroadcastEditorExtensions({ images: false }),
    content: html,
  });
  editors.push(ed);
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TiptapToolbar editor={ed} onAnnounce={() => {}} />
    </NextIntlClientProvider>,
  );
  return ed;
}

function posOfNode(ed: Editor, typeName: string): number {
  let found = -1;
  ed.state.doc.descendants((node, pos) => {
    if (found === -1 && node.type.name === typeName) found = pos;
  });
  return found;
}

describe('the button block is one unit in the editor', () => {
  it('saves the same HTML as the plain server-side node', () => {
    const plain = new Editor({ extensions: [StarterKit, broadcastCtaButtonExtension], content: CTA_HTML });
    editors.push(plain);
    const ed = mountToolbar(CTA_HTML);
    expect(ed.getHTML()).toBe(plain.getHTML());
    expect(validateBlocks(findBlockMarkers(ed.getHTML()).map((s) => s.block))).toEqual([]);
  });

  it('cannot be typed into: its words are not editable in place', () => {
    const ed = mountToolbar(CTA_HTML);
    expect(ed.schema.nodes['ctaButton']!.isAtom).toBe(true);
    const block = ed.view.dom.querySelector('[data-eb="cta"]');
    expect(block).toHaveAttribute('contenteditable', 'false');
    expect(block).toHaveTextContent('Register now');
  });

  // A non-editable `<a href>` inside the editor is a real link to the browser:
  // a click followed it and navigated away from the unsaved message (found in
  // a browser check of round 2). The editor draws the block without a link.
  it('is not a link a click could follow', () => {
    const ed = mountToolbar(CTA_HTML);
    const block = ed.view.dom.querySelector('[data-eb="cta"]');
    expect(block?.tagName).not.toBe('A');
    expect(block).not.toHaveAttribute('href');
    expect(block).toHaveAttribute('title', 'https://swecham.example/register');
  });

  it('Button on a selected button edits its words and link', () => {
    const ed = mountToolbar(CTA_HTML);
    act(() => {
      ed.commands.setNodeSelection(posOfNode(ed, 'ctaButton'));
    });
    expect(ed.state.selection).toBeInstanceOf(NodeSelection);
    // Named for its edit mode while a button is selected (round 3).
    fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: 'Edit button' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Edit button' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/button text/i)).toHaveValue('Register now');
    expect(within(dialog).getByLabelText(/button link/i)).toHaveValue('https://swecham.example/register');
    fireEvent.change(within(dialog).getByLabelText(/button text/i), { target: { value: 'Book a seat' } });
    fireEvent.change(within(dialog).getByLabelText(/button link/i), { target: { value: 'swecham.example/book' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save button' }));
    const out = ed.getHTML();
    expect(out).toContain('href="https://swecham.example/book"');
    expect(out).toContain('>Book a seat</a>');
    expect(out.match(/data-eb="cta"/g)).toHaveLength(1);
  });

  it('selected words pre-fill a new button and become it', () => {
    const ed = mountToolbar('<p>Register now</p>');
    ed.commands.setTextSelection({ from: 1, to: 13 });
    fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: 'Button' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText(/button text/i)).toHaveValue('Register now');
    fireEvent.change(within(dialog).getByLabelText(/button link/i), { target: { value: 'https://swecham.example/r' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Insert button' }));
    expect(ed.getHTML()).toBe('<p><a data-eb="cta" href="https://swecham.example/r">Register now</a></p>');
  });
});

describe('an inserted image keeps an editable description', () => {
  it('Image on a selected image edits its description', async () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TiptapEditor
          initialHtml='<img src="https://assets.swecham.example/a.png" alt="Old words"><p>x</p>'
          onChange={() => {}}
          imagesEnabled
          draftId="11111111-1111-1111-1111-111111111111"
        />
      </NextIntlClientProvider>,
    );
    await screen.findByRole('toolbar');
    const ed = (container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor;
    act(() => {
      ed.commands.setNodeSelection(posOfNode(ed, 'image'));
    });
    fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: 'Edit image description' }));
    const dialog = screen.getByRole('dialog');
    const field = within(dialog).getByLabelText(/image description/i);
    expect(field).toHaveValue('Old words');
    fireEvent.change(field, { target: { value: 'Members at the 2026 gala' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save description' }));
    expect(ed.getHTML()).toContain('alt="Members at the 2026 gala"');
    expect(ed.getHTML().match(/<img/g)).toHaveLength(1);
  });
});

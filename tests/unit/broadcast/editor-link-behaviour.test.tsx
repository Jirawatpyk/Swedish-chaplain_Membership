/**
 * Spec 122 US12d-2, round 2 (the maintainer: "fix the old problems too") —
 * how the E-Blast editor treats links, against a real Tiptap editor and the
 * real toolbar and link dialog.
 *
 *  #1 A click in a link must place the caret, not open the page: Tiptap's
 *     Link defaults to `openOnClick: true`, so an author clicking a link (or
 *     tapping the button block) to edit it got a new tab instead.
 *  #2 Editing only a link's address kept its words: with the caret inside a
 *     link (no selection) the dialog opened with an empty text field, and
 *     Save replaced "our 2026 report" with the URL.
 *  #8 Typing after a link inserted from the dialog no longer joins the link.
 *  #9 A selection across paragraphs is linked, never flattened into one line
 *     (the text field is read-only there).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { Editor } from '@tiptap/core';
import enMessages from '@/i18n/messages/en.json';
import { TiptapToolbar } from '@/components/broadcast/tiptap-toolbar';
import { makeBroadcastEditorExtensions } from '@/components/broadcast/broadcast-editor-extensions';

let editor: Editor | null = null;

function mount(html: string): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: makeBroadcastEditorExtensions({ images: false }),
    content: html,
  });
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TiptapToolbar editor={editor} onAnnounce={() => {}} />
    </NextIntlClientProvider>,
  );
  return editor;
}

function openLinkDialog(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: /^link$/i }));
  return screen.getByRole('dialog');
}

/** Position of the first character of `text` in the doc. */
function posOf(ed: Editor, text: string): number {
  let found = -1;
  ed.state.doc.descendants((node, pos) => {
    if (found === -1 && node.isText && node.text?.includes(text)) {
      found = pos + node.text.indexOf(text);
    }
  });
  return found;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
});

describe('#1 — a click in a link places the caret', () => {
  it('the Link mark is configured not to open on click, and to select the link', () => {
    const ed = mount('<p>x</p>');
    const link = ed.extensionManager.extensions.find((e) => e.name === 'link');
    expect(link?.options.openOnClick).toBe(false);
    expect(link?.options.enableClickSelection).toBe(true);
  });
});

describe('#2 — editing a link from inside it', () => {
  const html = '<p>Read <a href="https://a.example/report">our 2026 report</a> today.</p>';

  it('pre-fills the link text from the whole link under the caret, titled "Edit link"', () => {
    const ed = mount(html);
    ed.commands.setTextSelection(posOf(ed, '2026'));
    const dialog = openLinkDialog();
    expect(within(dialog).getByRole('heading', { name: 'Edit link' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/link text/i)).toHaveValue('our 2026 report');
    expect(within(dialog).getByLabelText(/link address/i)).toHaveValue('https://a.example/report');
  });

  it('changing only the address keeps the words', () => {
    const ed = mount(html);
    ed.commands.setTextSelection(posOf(ed, '2026'));
    const dialog = openLinkDialog();
    fireEvent.change(within(dialog).getByLabelText(/link address/i), { target: { value: 'https://b.example/report' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save link/i }));
    const out = ed.getHTML();
    expect(out).toContain('href="https://b.example/report"');
    expect(out).toContain('>our 2026 report</a>');
    expect(out).toContain('Read ');
    expect(out).toContain(' today.');
  });
});

describe('#8 — typing after an inserted link is not linked', () => {
  it('the next character typed after a new link has no link mark', () => {
    const ed = mount('<p>Visit </p>');
    ed.commands.setTextSelection(ed.state.doc.content.size - 1);
    const dialog = openLinkDialog();
    fireEvent.change(within(dialog).getByLabelText(/link address/i), { target: { value: 'https://swecham.example' } });
    fireEvent.change(within(dialog).getByLabelText(/link text/i), { target: { value: 'our site' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save link/i }));
    ed.view.dispatch(ed.state.tr.insertText('!'));
    expect(ed.getHTML()).toContain('>our site</a>!');
  });
});

describe('#9 — a selection across paragraphs', () => {
  it('keeps both paragraphs, links them, and offers the text read-only', () => {
    const ed = mount('<p>First line</p><p>Second line</p>');
    ed.commands.setTextSelection({ from: 1, to: ed.state.doc.content.size - 1 });
    const dialog = openLinkDialog();
    expect(within(dialog).getByLabelText(/link text/i)).toHaveAttribute('readonly');
    fireEvent.change(within(dialog).getByLabelText(/link address/i), { target: { value: 'https://swecham.example' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save link/i }));
    const out = ed.getHTML();
    expect(out.match(/<p>/g)).toHaveLength(2);
    expect(out).toContain('>First line</a>');
    expect(out).toContain('>Second line</a>');
  });
});

describe('#19 — a bare address gets https://', () => {
  it('swecham.example/events is saved as https://swecham.example/events', () => {
    const ed = mount('<p>Visit </p>');
    ed.commands.setTextSelection(ed.state.doc.content.size - 1);
    const dialog = openLinkDialog();
    expect(within(dialog).getByRole('heading', { name: 'Add a link' })).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/link address/i), { target: { value: 'swecham.example/events' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save link/i }));
    expect(ed.getHTML()).toContain('href="https://swecham.example/events"');
  });
});

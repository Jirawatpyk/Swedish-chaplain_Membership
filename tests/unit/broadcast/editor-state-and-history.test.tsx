/**
 * Spec 122 US12d-2, round 2 (the maintainer: "fix the old problems too") —
 * the editor's state, against the real editor and toolbar.
 *
 *  #3  `disabled` turning on AFTER mount (every host passes
 *      `submitting`/`isPending`) left the editor typeable and the toolbar live:
 *      Tiptap reads `editable` once and keeps it on every re-render.
 *  #7  The toolbar's pressed states were read at render time only, so moving
 *      the caret into bold text, or Ctrl+B, left "Bold" reported off.
 *  #16 There was no visible Undo or Redo: on a phone, a deleted banner or
 *      button could not be brought back.
 *  #11 The toolbar scrolled away with a long message (sticky now).
 *  #18 After saving a link, focus went back to the toolbar, not the text.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { Editor } from '@tiptap/core';
import enMessages from '@/i18n/messages/en.json';
import TiptapEditor from '@/components/broadcast/tiptap-editor';
import { TiptapToolbar } from '@/components/broadcast/tiptap-toolbar';
import { makeBroadcastEditorExtensions } from '@/components/broadcast/broadcast-editor-extensions';

vi.mock('@/components/broadcast/clamav-unreachable-banner', () => ({
  ClamavUnreachableBanner: (): null => null,
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

let editor: Editor | null = null;

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
});

function mountToolbar(html: string): Editor {
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

const control = (name: string): HTMLElement =>
  within(screen.getByRole('toolbar')).getByRole('button', { name });

describe('#3 — disabled after mount', () => {
  function Host({ disabled }: { readonly disabled: boolean }): React.ReactElement {
    return (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TiptapEditor initialHtml="<p>hello</p>" onChange={() => {}} disabled={disabled} />
      </NextIntlClientProvider>
    );
  }

  it('locks the text and every control once disabled turns on, and frees them after', async () => {
    const { rerender, container } = render(<Host disabled={false} />);
    await screen.findByRole('toolbar');
    const area = container.querySelector('.ProseMirror')!;
    expect(area).toHaveAttribute('contenteditable', 'true');

    rerender(<Host disabled />);
    await waitFor(() => expect(area).toHaveAttribute('contenteditable', 'false'));
    expect(area).toHaveAttribute('aria-readonly', 'true');
    for (const b of within(screen.getByRole('toolbar')).getAllByRole('button')) {
      expect(b).toHaveAttribute('aria-disabled', 'true');
    }

    rerender(<Host disabled={false} />);
    await waitFor(() => expect(area).toHaveAttribute('contenteditable', 'true'));
    expect(control('Bold')).not.toHaveAttribute('aria-disabled');
  });
});

describe('#7 — pressed states follow the caret', () => {
  it('Bold reads pressed once the caret moves into bold text', () => {
    const ed = mountToolbar('<p>plain <strong>bold</strong></p>');
    expect(control('Bold')).toHaveAttribute('aria-pressed', 'false');
    act(() => {
      ed.commands.setTextSelection(10);
    });
    expect(control('Bold')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('#16 — Undo and Redo', () => {
  it('are at the end of the toolbar, unavailable until there is something to undo', () => {
    const ed = mountToolbar('<p>hello</p>');
    const buttons = within(screen.getByRole('toolbar')).getAllByRole('button');
    expect(buttons.slice(-2).map((b) => b.getAttribute('aria-label'))).toEqual(['Undo', 'Redo']);
    expect(control('Undo')).toHaveAttribute('aria-disabled', 'true');
    expect(control('Redo')).toHaveAttribute('aria-disabled', 'true');

    act(() => {
      ed.commands.insertContentAt(1, 'well ');
    });
    expect(control('Undo')).not.toHaveAttribute('aria-disabled');
    fireEvent.click(control('Undo'));
    expect(ed.getHTML()).toBe('<p>hello</p>');
    expect(control('Redo')).not.toHaveAttribute('aria-disabled');
    fireEvent.click(control('Redo'));
    expect(ed.getHTML()).toBe('<p>well hello</p>');
  });
});

describe('#11 — the toolbar stays in view', () => {
  it('is sticky below the shell bar, on the input fill', () => {
    mountToolbar('<p>x</p>');
    expect(screen.getByRole('toolbar')).toHaveClass('sticky', 'top-[var(--shell-bar-height,0px)]');
  });
});

describe('#18 — focus after a dialog', () => {
  it('returns to the text after Save link, and to the Link control after Cancel', async () => {
    const ed = mountToolbar('<p>Visit </p>');
    document.body.appendChild(ed.view.dom);
    ed.commands.setTextSelection(ed.state.doc.content.size - 1);

    fireEvent.click(control('Link'));
    let dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/link address/i), { target: { value: 'https://swecham.example' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save link/i }));
    await waitFor(() => expect(document.activeElement).toBe(ed.view.dom));

    fireEvent.click(control('Link'));
    dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(document.activeElement).toBe(control('Link')));
    ed.view.dom.remove();
  });
});

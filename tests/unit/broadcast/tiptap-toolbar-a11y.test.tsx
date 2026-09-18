/**
 * F119 T098 (FR-048) — the toolbar follows the APG toolbar pattern.
 *
 * Today the toolbar is `role="toolbar"` with one tab stop PER control (7+),
 * so a keyboard user Tabbing from the subject field walks through every
 * formatting button before reaching the message body. APG says a toolbar is
 * ONE tab stop and the arrow keys move within it — plus Home/End to the ends,
 * and a visible focus state.
 *
 * At 320 px the toolbar WRAPS onto further rows (`flex-wrap`); it never hides
 * controls behind an overflow menu (FR-048, contracts § Page contracts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { Editor } from '@tiptap/core';
import enMessages from '@/i18n/messages/en.json';
import { TiptapToolbar } from '@/components/broadcast/tiptap-toolbar';
import { makeBroadcastEditorExtensions } from '@/components/broadcast/broadcast-editor-extensions';

let editor: Editor | null = null;

function renderToolbar(): { toolbar: HTMLElement; buttons: HTMLElement[] } {
  editor = new Editor({
    extensions: makeBroadcastEditorExtensions({ images: true }),
    content: '<p>hello</p>',
  });
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TiptapToolbar
        editor={editor}
        onAnnounce={() => {}}
        imagesEnabled
        imageInsertEnabled
        onInsertImage={() => {}}
        onInsertBanner={() => {}}
      />
    </NextIntlClientProvider>,
  );
  const toolbar = screen.getByRole('toolbar');
  return { toolbar, buttons: within(toolbar).getAllByRole('button') };
}

afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
});

describe('T098 — one tab stop; arrows move; Home/End jump to the ends', () => {
  it('exposes exactly ONE tab stop (roving tabindex)', () => {
    const { buttons } = renderToolbar();
    const tabbable = buttons.filter((b) => b.getAttribute('tabindex') === '0');
    expect(buttons.length).toBeGreaterThan(1);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(buttons[0]);
    // Every other control is reachable by arrow key, never by Tab.
    for (const b of buttons.slice(1)) {
      expect(b.getAttribute('tabindex')).toBe('-1');
    }
  });

  it('ArrowRight / ArrowLeft move focus one control at a time', () => {
    const { buttons } = renderToolbar();
    const first = buttons[0]!;
    const second = buttons[1]!;
    first.focus();
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(second);
    expect(second.getAttribute('tabindex')).toBe('0');
    expect(first.getAttribute('tabindex')).toBe('-1');

    fireEvent.keyDown(second, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(first);
  });

  it('Home and End jump to the ends', () => {
    const { buttons } = renderToolbar();
    const first = buttons[0]!;
    const last = buttons[buttons.length - 1]!;
    first.focus();

    fireEvent.keyDown(first, { key: 'End' });
    expect(document.activeElement).toBe(last);
    expect(last.getAttribute('tabindex')).toBe('0');

    fireEvent.keyDown(last, { key: 'Home' });
    expect(document.activeElement).toBe(first);
    expect(first.getAttribute('tabindex')).toBe('0');
  });

  it('wraps around at both ends rather than dead-ending', () => {
    const { buttons } = renderToolbar();
    const first = buttons[0]!;
    const last = buttons[buttons.length - 1]!;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(first);
  });
});

describe('T098 — visible focus state and 320 px wrapping', () => {
  it('every control carries a visible focus ring', () => {
    const { buttons } = renderToolbar();
    for (const b of buttons) {
      expect(b.className).toMatch(/focus-visible:ring/);
    }
  });

  it('wraps onto further rows with NO overflow menu', () => {
    const { toolbar, buttons } = renderToolbar();
    expect(toolbar.className).toMatch(/flex-wrap/);
    // No "More…" affordance, and nothing hidden behind a menu button.
    expect(within(toolbar).queryByRole('menu')).toBeNull();
    for (const b of buttons) {
      expect(b.getAttribute('aria-haspopup')).not.toBe('menu');
      expect((b.getAttribute('aria-label') ?? '').toLowerCase()).not.toContain('more');
    }
  });

  it('names itself for assistive technology', () => {
    const { toolbar } = renderToolbar();
    expect(toolbar).toHaveAttribute('aria-label');
    expect(toolbar.getAttribute('aria-label')).not.toBe('');
  });
});

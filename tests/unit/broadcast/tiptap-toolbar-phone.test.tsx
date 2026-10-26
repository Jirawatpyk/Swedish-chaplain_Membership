/**
 * Spec 122 US12d-2 follow-up (the maintainer, 26 Oct 2026) — on a phone the
 * toolbar is the staff boards' row on every host: Bold, Italic, Underline,
 * Link, "Lists and headings ▾", "Insert ▾", Undo, Redo. The two menus hold
 * the block and insert constructs; each item runs the desktop control's
 * command. Desktop keeps every control in one wrapping row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { Editor } from '@tiptap/core';
import enMessages from '@/i18n/messages/en.json';
import thMessages from '@/i18n/messages/th.json';
import { TiptapToolbar } from '@/components/broadcast/tiptap-toolbar';
import { makeBroadcastEditorExtensions } from '@/components/broadcast/broadcast-editor-extensions';

const bp = vi.hoisted(() => ({ current: 'base' as 'base' | 'lg' }));
vi.mock('@jirawatpyk/aura-react', async (orig) => ({
  ...(await orig<typeof import('@jirawatpyk/aura-react')>()),
  useBreakpoint: () => bp.current,
}));

const t = enMessages.broadcast.editor.toolbar;
let editor: Editor | null = null;

function renderToolbar(
  overrides: Partial<React.ComponentProps<typeof TiptapToolbar>> = {},
  locale: 'en' | 'th' = 'en',
): { toolbar: HTMLElement; controls: HTMLElement[] } {
  editor = new Editor({
    extensions: makeBroadcastEditorExtensions({ images: true }),
    content: '<p>hello</p>',
  });
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'th' ? thMessages : enMessages}>
      <TiptapToolbar
        editor={editor}
        onAnnounce={() => {}}
        imagesEnabled
        imageInsertEnabled
        onInsertImage={() => {}}
        onInsertBanner={() => {}}
        {...overrides}
      />
    </NextIntlClientProvider>,
  );
  const toolbar = screen.getByRole('toolbar');
  return { toolbar, controls: Array.from(toolbar.querySelectorAll<HTMLElement>('[data-toolbar-control]')) };
}

const openMenu = (toolbar: HTMLElement, name: string): HTMLElement => {
  fireEvent.click(within(toolbar).getByRole('button', { name }));
  return screen.getByRole('menu');
};

beforeEach(() => {
  bp.current = 'base';
});
afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
});

describe('phone toolbar — the staff boards\' row', () => {
  it('shows Bold, Italic, Underline, Link, the two menus, Undo and Redo, in that order', () => {
    const { controls } = renderToolbar();
    expect(controls.map((c) => c.getAttribute('aria-label'))).toEqual([
      t.bold, t.italic, t.underline, t.link, t.blocksMenu, t.insertMenu, t.undo, t.redo,
    ]);
  });

  it('the two menu triggers say they open a menu, and the row is still one tab stop', () => {
    const { controls } = renderToolbar();
    const menus = controls.filter((c) => c.getAttribute('aria-haspopup') === 'menu');
    expect(menus.map((c) => c.getAttribute('aria-label'))).toEqual([t.blocksMenu, t.insertMenu]);
    expect(controls.filter((c) => c.tabIndex === 0)).toHaveLength(1);
  });

  it('Lists and headings holds Heading, Subheading, the two lists and Quote; choosing one runs it', () => {
    const { toolbar } = renderToolbar();
    const menu = openMenu(toolbar, t.blocksMenu);
    const names = Array.from(menu.querySelectorAll('[role^=menuitem]')).map((i) => i.textContent?.trim());
    expect(names).toEqual([t.heading2, t.heading3, t.bulletList, t.orderedList, t.quote]);
    fireEvent.click(within(menu).getByText(t.heading2));
    expect(editor!.isActive('heading', { level: 2 })).toBe(true);
  });

  it('an active block is checked in its menu', () => {
    const { toolbar } = renderToolbar();
    editor!.chain().focus().toggleBulletList().run();
    const menu = openMenu(toolbar, t.blocksMenu);
    const item = within(menu).getByText(t.bulletList).closest('[role^=menuitem]');
    expect(item).toHaveAttribute('aria-checked', 'true');
  });

  it('Insert holds Divider, Button, Image and Banner image', () => {
    const { toolbar } = renderToolbar();
    const menu = openMenu(toolbar, t.insertMenu);
    const names = Array.from(menu.querySelectorAll('[role^=menuitem]')).map((i) => i.textContent?.trim());
    expect(names).toEqual([t.divider, t.cta, t.image, t.banner]);
  });

  it('before the draft is saved, Image and Banner are disabled in the menu with the reason', () => {
    const { toolbar } = renderToolbar({ imageInsertEnabled: false });
    const menu = openMenu(toolbar, t.insertMenu);
    for (const name of [t.image, t.banner]) {
      const item = within(menu).getByText(name).closest('[role^=menuitem]');
      expect(item).toHaveAttribute('aria-disabled', 'true');
    }
  });

  it('Image chosen from Insert starts from the menu button, so its dialog returns focus there (a11y H1)', () => {
    let focusAtInsert: Element | null = null;
    const { toolbar } = renderToolbar({ onInsertImage: () => { focusAtInsert = document.activeElement; } });
    const menu = openMenu(toolbar, t.insertMenu);
    fireEvent.click(within(menu).getByText(t.image));
    expect(focusAtInsert).toHaveAttribute('data-toolbar-control', 'insert');
  });

  it('while uploading, Image and Banner say to wait for the upload', () => {
    const { toolbar } = renderToolbar({ imageBusy: true });
    const menu = openMenu(toolbar, t.insertMenu);
    expect(within(menu).getAllByText(t.uploadWait)).toHaveLength(2);
  });

  it('the menu button shows when the caret is in one of its blocks (UX M2)', () => {
    const { toolbar } = renderToolbar();
    const trigger = within(toolbar).getByRole('button', { name: t.blocksMenu });
    expect(trigger.querySelector('[data-active-mark]')).toBeNull();
    act(() => {
      editor!.chain().focus().toggleHeading({ level: 2 }).run();
    });
    expect(within(toolbar).getByRole('button', { name: t.blocksMenu }).querySelector('[data-active-mark]')).not.toBeNull();
  });

  it('while the host saves, the menus do not open', () => {
    const { toolbar } = renderToolbar({ disabled: true });
    fireEvent.click(within(toolbar).getByRole('button', { name: t.insertMenu }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Thai has no Italic on the phone row either (FR-044)', () => {
    const { controls } = renderToolbar({}, 'th');
    expect(controls.map((c) => c.getAttribute('data-toolbar-control'))).toEqual([
      'bold', 'underline', 'link', 'blocks', 'insert', 'undo', 'redo',
    ]);
  });
});

describe('desktop toolbar — unchanged: every control, no menu', () => {
  it('keeps the fifteen controls and no menu trigger', () => {
    bp.current = 'lg';
    const { controls } = renderToolbar();
    expect(controls).toHaveLength(15);
    expect(controls.some((c) => c.getAttribute('aria-haspopup') === 'menu')).toBe(false);
  });
});

describe('the toolbar name and the board icons', () => {
  it('is named "Formatting" — the role already says "toolbar"', () => {
    const { toolbar } = renderToolbar();
    expect(toolbar).toHaveAttribute('aria-label', 'Formatting');
  });

  it('Button uses the rectangle and Banner image the image-plus icon', () => {
    bp.current = 'lg';
    const { controls } = renderToolbar();
    const icon = (key: string): string =>
      controls.find((c) => c.getAttribute('data-toolbar-control') === key)!.querySelector('svg')!.getAttribute('class') ?? '';
    expect(icon('cta')).toContain('lucide-rectangle-horizontal');
    expect(icon('banner')).toContain('lucide-image-plus');
  });
});

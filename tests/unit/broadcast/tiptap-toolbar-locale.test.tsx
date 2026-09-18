/**
 * F119 T094 (US3-AS8, FR-044) — italic is not OFFERED when the interface
 * language is Thai; italic CONTENT that arrives by paste or from a template is
 * kept as-is.
 *
 * Thai script has no italic form: sloped Thai is a synthetic transform that
 * degrades legibility, which is why the control is hidden. Hiding the control
 * is the whole of the rule — removing the `italic` MARK from the schema would
 * silently drop `<em>` a member pasted or a template carried, which is exactly
 * the "stripped between editor and delivered email" class SC-011 forbids.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { Editor } from '@tiptap/core';
import enMessages from '@/i18n/messages/en.json';
import thMessages from '@/i18n/messages/th.json';
import svMessages from '@/i18n/messages/sv.json';
import { TiptapToolbar } from '@/components/broadcast/tiptap-toolbar';
import { makeBroadcastEditorExtensions } from '@/components/broadcast/broadcast-editor-extensions';

const MESSAGES = {
  en: enMessages,
  th: thMessages,
  sv: svMessages,
} as const;

/** The three toolbar labels for italic, pinned so a copy change is deliberate. */
const ITALIC_LABEL = {
  en: 'Italic',
  th: 'ตัวเอียง',
  sv: 'Kursiv',
} as const;

let editor: Editor | null = null;

function renderToolbar(locale: 'en' | 'th' | 'sv'): HTMLElement {
  editor = new Editor({
    extensions: makeBroadcastEditorExtensions({ images: true }),
    content: '<p>hello</p>',
  });
  render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
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
  return screen.getByRole('toolbar');
}

afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
});

describe('T094 — the italic control is absent under `th`', () => {
  it('renders no italic control when the interface language is Thai', () => {
    const toolbar = renderToolbar('th');
    expect(within(toolbar).queryByLabelText(ITALIC_LABEL.th)).toBeNull();
    // Positive control — the rest of the toolbar is intact (13 − italic = 12).
    expect(within(toolbar).getAllByRole('button')).toHaveLength(12);
  });

  it('offers italic under `en` and `sv`', () => {
    for (const locale of ['en', 'sv'] as const) {
      const toolbar = renderToolbar(locale);
      expect(
        within(toolbar).getByLabelText(ITALIC_LABEL[locale]),
      ).toBeInTheDocument();
      expect(within(toolbar).getAllByRole('button')).toHaveLength(13);
      cleanup();
      editor?.destroy();
      editor = null;
    }
  });
});

describe('T094 — `<em>` in the body survives the Thai render unchanged', () => {
  it('keeps pasted / template italic content in the document', () => {
    editor = new Editor({
      extensions: makeBroadcastEditorExtensions({ images: true }),
      content: '<p>สวัสดี <em>ยินดีต้อนรับ</em></p>',
    });
    const html = editor.getHTML();
    expect(html).toContain('<em>');
    expect(html).toContain('ยินดีต้อนรับ');
    // The mark is still part of the schema — the locale gate is presentational.
    expect(editor.schema.marks['italic']).toBeDefined();
  });
});

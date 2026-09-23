/**
 * F119 T088 (US3-AS1, FR-038) — the writing tool offers a visible control for
 * every construct the shared content policy keeps, and NOTHING typeable by
 * shortcut or paste can produce a node the server sanitiser later removes.
 *
 * Two halves, because the guarantee has two halves:
 *
 *   1. The toolbar's control set is EXACTLY the policy's set — H2, H3, quote,
 *      divider, bulleted + numbered list, bold, italic, underline, link,
 *      image, CTA, banner — in that order, and no more. (Italic is in the set
 *      under `en`; FR-044 hides only the CONTROL under `th`, which is
 *      `tiptap-toolbar-locale.test.tsx`.) H1 is never offered: the subject is
 *      the email's title.
 *   2. The editor SCHEMA cannot hold what the sanitiser strips. An input rule
 *      can only produce a node the schema has, so disabling `code`,
 *      `codeBlock` and `strike` and pinning heading levels to [2, 3] is what
 *      makes "` ``` `", "~~strike~~" and "# " structurally unable to create
 *      content that disappears between the editor and the delivered email
 *      (SC-011). The round-trip assertions below prove it on the real editor
 *      rather than on the option object.
 *
 * Rendered under `NextIntlClientProvider` with the REAL `en.json`, so a
 * dangling `t()` reference fails here instead of shipping a raw key path
 * (next-intl does not throw on a missing key).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { Editor } from '@tiptap/core';
import enMessages from '@/i18n/messages/en.json';
import { TiptapToolbar } from '@/components/broadcast/tiptap-toolbar';
import { makeBroadcastEditorExtensions } from '@/components/broadcast/broadcast-editor-extensions';

/** The policy's construct list, in toolbar order — the contract of this test. */
const EXPECTED_CONTROLS = [
  'Heading',
  'Subheading',
  'Quote',
  'Divider',
  'Bulleted list',
  'Numbered list',
  'Bold',
  'Italic',
  'Underline',
  'Link',
  'Image',
  'Button',
  'Banner image',
] as const;

const editors: Editor[] = [];

function makeEditor(content = '<p>hello</p>', images = true): Editor {
  const editor = new Editor({
    extensions: makeBroadcastEditorExtensions({ images }),
    content,
  });
  editors.push(editor);
  return editor;
}

function renderToolbar(opts: { imagesEnabled?: boolean } = {}) {
  const editor = makeEditor('<p>hello</p>', opts.imagesEnabled ?? true);
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TiptapToolbar
        editor={editor}
        onAnnounce={() => {}}
        imagesEnabled={opts.imagesEnabled ?? true}
        imageInsertEnabled
        onInsertImage={() => {}}
        onInsertBanner={() => {}}
      />
    </NextIntlClientProvider>,
  );
  return screen.getByRole('toolbar');
}

function controlNames(toolbar: HTMLElement): string[] {
  return within(toolbar)
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
}

afterEach(() => {
  cleanup();
  while (editors.length > 0) editors.pop()?.destroy();
});

describe('T088 — the toolbar offers exactly the constructs the shared policy keeps', () => {
  it('lists H2, H3, quote, divider, bullet, ordered, bold, italic, underline, link, image, CTA, banner — and no more', () => {
    const toolbar = renderToolbar();
    expect(controlNames(toolbar)).toEqual([...EXPECTED_CONTROLS]);
  });

  it('never offers H1, strikethrough, code or an alignment/colour control', () => {
    const toolbar = renderToolbar();
    const names = controlNames(toolbar).join(' | ').toLowerCase();
    for (const forbidden of [
      'heading 1',
      'h1',
      'title',
      'strike',
      'code',
      'align',
      'colour',
      'color',
      'font',
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('drops the image and banner controls when the image flag is off', () => {
    const toolbar = renderToolbar({ imagesEnabled: false });
    const names = controlNames(toolbar);
    expect(names).not.toContain('Image');
    expect(names).not.toContain('Banner image');
    // Everything else still there — the flag removes two controls, not eleven.
    expect(names).toEqual(
      EXPECTED_CONTROLS.filter((c) => c !== 'Image' && c !== 'Banner image'),
    );
  });
});

describe('T088 — shortcuts and pastes cannot produce a node the sanitiser removes', () => {
  it('`# `, ` ``` `, `~~strike~~` and inline code have no node/mark in the schema', () => {
    const editor = makeEditor('<p></p>');
    expect(editor.schema.nodes['codeBlock']).toBeUndefined();
    expect(editor.schema.marks['code']).toBeUndefined();
    expect(editor.schema.marks['strike']).toBeUndefined();

    const heading = editor.extensionManager.extensions.find(
      (e) => e.name === 'heading',
    );
    expect((heading?.options as { levels?: number[] } | undefined)?.levels).toEqual([2, 3]);
  });

  it('content carrying those constructs round-trips WITHOUT them', () => {
    const editor = makeEditor('<p></p>');
    editor.commands.setContent(
      '<h1>Title</h1><pre><code>let x = 1</code></pre>' +
        '<p><s>struck</s> and <code>inline</code></p>',
    );
    const html = editor.getHTML();
    expect(html).not.toMatch(/<h1[\s>]/);
    expect(html).not.toMatch(/<pre[\s>]/);
    expect(html).not.toMatch(/<code[\s>]/);
    expect(html).not.toMatch(/<(s|del|strike)[\s>]/);
    // KEEP_CONTENT semantics: the words survive, only the markup is gone.
    expect(html).toContain('Title');
    expect(html).toContain('struck');
  });

  it('keeps every construct the policy DOES allow — including `<em>` from a paste', () => {
    const editor = makeEditor('<p></p>');
    editor.commands.setContent(
      '<h2>Two</h2><h3>Three</h3><blockquote><p>q</p></blockquote><hr>' +
        '<ul><li>a</li></ul><ol><li>b</li></ol>' +
        '<p><strong>s</strong><em>e</em><u>u</u></p>',
    );
    const html = editor.getHTML();
    for (const kept of [
      '<h2>',
      '<h3>',
      '<blockquote>',
      '<hr>',
      '<ul>',
      '<ol>',
      '<strong>',
      '<em>',
      '<u>',
    ]) {
      expect(html).toContain(kept);
    }
    // The italic MARK stays registered even where the control is hidden —
    // FR-044 hides the control, never the content.
    expect(editor.schema.marks['italic']).toBeDefined();
  });
});

/**
 * F119 T102 (FR-041) — the two system-controlled design blocks as Tiptap
 * nodes on `@tiptap/core` (no new package).
 *
 *   CTA button  → `<a data-eb="cta" href="…">text</a>`
 *   Banner      → `<img data-eb="banner" src="…" alt="…">`
 *
 * The marker shape is not decoration: `findBlockMarkers` in the Domain
 * (`design-blocks/block-markers.ts`) is what the email renderer reads to turn
 * these back into a styled button and a full-width image. So the round-trip
 * asserted here is `editor.getHTML()` → the DOMAIN parser, not a string
 * comparison that would pass while the renderer saw nothing.
 *
 * The user supplies `href` + text, or `src` + `alt`, and NOTHING else —
 * colours, fonts and sizes come from the platform and the chamber's brand
 * settings (FR-041), and the shared sanitiser allows no other attribute
 * anyway.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { broadcastCtaButtonExtension } from '@/modules/broadcasts/infrastructure/tiptap-cta-button-config';
import { broadcastBannerImageExtension } from '@/modules/broadcasts/infrastructure/tiptap-banner-image-config';
import { broadcastImageExtension } from '@/modules/broadcasts/infrastructure/tiptap-image-extension-config';
import { findBlockMarkers } from '@/modules/broadcasts/domain/design-blocks/block-markers';

let editor: Editor | null = null;

function makeEditor(content = '<p></p>'): Editor {
  editor = new Editor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] }, code: false, codeBlock: false, strike: false }),
      broadcastImageExtension,
      broadcastCtaButtonExtension,
      broadcastBannerImageExtension,
    ],
    content,
  });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('T102 — getHTML serialises exactly the marker shape and parses it back', () => {
  it('round-trips a CTA button through the Domain marker parser', () => {
    const ed = makeEditor(
      '<p><a data-eb="cta" href="https://swecham.example/join">Join us</a></p>',
    );
    const html = ed.getHTML();
    expect(html).toContain('data-eb="cta"');
    expect(html).toContain('href="https://swecham.example/join"');
    expect(html).toContain('Join us');

    expect(findBlockMarkers(html).map((s) => s.block)).toEqual([
      { kind: 'cta', href: 'https://swecham.example/join', text: 'Join us' },
    ]);
  });

  it('round-trips a banner image through the Domain marker parser', () => {
    const ed = makeEditor(
      '<img data-eb="banner" src="https://x.example/banner.png" alt="Members at the 2026 gala">',
    );
    const html = ed.getHTML();
    expect(html).toContain('data-eb="banner"');

    expect(findBlockMarkers(html).map((s) => s.block)).toEqual([
      {
        kind: 'banner',
        src: 'https://x.example/banner.png',
        alt: 'Members at the 2026 gala',
      },
    ]);
  });

  it('inserts both blocks through their commands', () => {
    const ed = makeEditor('<p>intro</p>');
    ed.commands.setCtaButton({ href: 'mailto:info@swecham.example', text: 'Email us' });
    ed.commands.setBannerImage({ src: 'https://x.example/b.png', alt: 'A banner' });

    const blocks = findBlockMarkers(ed.getHTML()).map((s) => s.block);
    expect(blocks).toContainEqual({
      kind: 'cta',
      href: 'mailto:info@swecham.example',
      text: 'Email us',
    });
    expect(blocks).toContainEqual({
      kind: 'banner',
      src: 'https://x.example/b.png',
      alt: 'A banner',
    });
  });
});

describe('T102 — the marker is what makes a block; an unmarked element stays plain', () => {
  it('a plain link is NOT a CTA', () => {
    const ed = makeEditor('<p><a href="https://x.example">plain</a></p>');
    const html = ed.getHTML();
    expect(html).not.toContain('data-eb');
    expect(findBlockMarkers(html)).toHaveLength(0);
  });

  it('a plain image is NOT a banner', () => {
    const ed = makeEditor('<img src="https://x.example/a.png" alt="inline">');
    const html = ed.getHTML();
    expect(html).not.toContain('data-eb="banner"');
    expect(findBlockMarkers(html)).toHaveLength(0);
  });
});

describe('T102 — the user supplies nothing but the four values', () => {
  it('the CTA node carries exactly `href`', () => {
    const ed = makeEditor();
    const attrs = ed.schema.nodes['ctaButton']?.spec.attrs ?? {};
    expect(Object.keys(attrs)).toEqual(['href']);
  });

  it('the banner node carries exactly `src` and `alt`', () => {
    const ed = makeEditor();
    const attrs = ed.schema.nodes['bannerImage']?.spec.attrs ?? {};
    expect(Object.keys(attrs).sort()).toEqual(['alt', 'src']);
  });

  it('a style / class / width smuggled in the source does not survive', () => {
    const ed = makeEditor(
      '<p><a data-eb="cta" href="https://x.example" style="color:red" class="big" target="_self">Go</a></p>',
    );
    const html = ed.getHTML();
    expect(html).not.toContain('style=');
    expect(html).not.toContain('class="big"');
  });
});

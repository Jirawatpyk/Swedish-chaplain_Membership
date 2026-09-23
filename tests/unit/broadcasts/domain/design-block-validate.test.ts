/**
 * F119 T015 — `validateBlocks` (`domain/design-blocks/block-markers.ts`).
 *
 * FR-041: CTA text 1–60 characters, link on the scheme allow-list
 * (http / https / mailto), at most 3 CTAs per message; banner description
 * 1–125 characters. Each violation names the block it concerns so the
 * route can tell marketing which one.
 */
import { describe, expect, it } from 'vitest';
import {
  BANNER_ALT_MAX,
  CTA_MAX_PER_MESSAGE,
  CTA_TEXT_MAX,
  validateBlocks,
  type DesignBlock,
} from '@/modules/broadcasts/domain/design-blocks/block-markers';

const cta = (over: Partial<Extract<DesignBlock, { kind: 'cta' }>> = {}): DesignBlock => ({
  kind: 'cta',
  href: 'https://example.org/',
  text: 'Register now',
  ...over,
});
const banner = (over: Partial<Extract<DesignBlock, { kind: 'banner' }>> = {}): DesignBlock => ({
  kind: 'banner',
  src: 'https://cdn.example.org/b.png',
  alt: 'Autumn dinner banner',
  ...over,
});

describe('validateBlocks', () => {
  it('a valid set produces no violations', () => {
    expect(validateBlocks([cta(), banner(), cta({ href: 'mailto:info@example.org' })])).toEqual([]);
    expect(CTA_TEXT_MAX).toBe(60);
    expect(CTA_MAX_PER_MESSAGE).toBe(3);
    expect(BANNER_ALT_MAX).toBe(125);
  });

  it('4th CTA → too_many_cta, naming the fourth', () => {
    const v = validateBlocks([cta(), cta(), cta(), cta()]);
    expect(v).toEqual([{ code: 'too_many_cta', index: 3, max: 3 }]);
  });

  it('61-character text → cta_text_length; 60 is accepted; empty is refused', () => {
    expect(validateBlocks([cta({ text: 'x'.repeat(61) })])).toEqual([
      { code: 'cta_text_length', index: 0, min: 1, max: 60 },
    ]);
    expect(validateBlocks([cta({ text: 'x'.repeat(60) })])).toEqual([]);
    expect(validateBlocks([cta({ text: '' })])).toEqual([{ code: 'cta_text_length', index: 0, min: 1, max: 60 }]);
    // Whitespace-only text is empty text to a reader.
    expect(validateBlocks([cta({ text: '   ' })])).toEqual([{ code: 'cta_text_length', index: 0, min: 1, max: 60 }]);
  });

  it('a scheme outside http / https / mailto → cta_link_scheme (javascript:, ftp:, data:, empty)', () => {
    for (const href of ['javascript:alert(1)', 'ftp://x.example/', 'data:text/html,hi', '', 'JAVASCRIPT:x', '//x.example/']) {
      expect(validateBlocks([cta({ href })]), href).toEqual([{ code: 'cta_link_scheme', index: 0 }]);
    }
    expect(validateBlocks([cta({ href: 'HTTPS://X.EXAMPLE/' })])).toEqual([]);
  });

  it('a banner without a description → banner_alt_required; 126 chars is over; 125 is accepted', () => {
    expect(validateBlocks([banner({ alt: '' })])).toEqual([{ code: 'banner_alt_required', index: 0, min: 1, max: 125 }]);
    expect(validateBlocks([banner({ alt: '   ' })])).toEqual([{ code: 'banner_alt_required', index: 0, min: 1, max: 125 }]);
    expect(validateBlocks([banner({ alt: 'x'.repeat(126) })])).toEqual([{ code: 'banner_alt_required', index: 0, min: 1, max: 125 }]);
    expect(validateBlocks([banner({ alt: 'x'.repeat(125) })])).toEqual([]);
  });

  it('reports every violation, indexed by block position, in order', () => {
    const v = validateBlocks([banner({ alt: '' }), cta({ href: 'ftp://x/' }), cta({ text: '' })]);
    expect(v.map((x) => [x.code, x.index])).toEqual([
      ['banner_alt_required', 0],
      ['cta_link_scheme', 1],
      ['cta_text_length', 2],
    ]);
  });
});

describe('decodeHtmlEntities (the parser\'s attribute + text decoder)', () => {
  it('decodes named, decimal and hex entities; leaves an unknown name and an out-of-range code point as written', async () => {
    const { decodeHtmlEntities } = await import('@/modules/broadcasts/domain/design-blocks/block-markers');
    expect(decodeHtmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;&nbsp;f')).toBe('a & b <c> "d" \'e\' f');
    expect(decodeHtmlEntities('&#65;&#x42;&#X43;')).toBe('ABC');
    expect(decodeHtmlEntities('&#128512; &#x1F600;')).toBe('😀 😀');
    expect(decodeHtmlEntities('&bogus; &#9999999999; &#xFFFFFFFF;')).toBe('&bogus; &#9999999999; &#xFFFFFFFF;');
  });
});

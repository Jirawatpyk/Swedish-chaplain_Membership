/**
 * F119 T016 — `applyDesignBlocks` (`domain/design-blocks/render-blocks.ts`).
 *
 * Platform-owned markup generated AFTER sanitisation and never fed back
 * through DOMPurify (the panel carry-forward): a `bgcolor` table cell for the
 * CTA button, a full-width image cell for the banner. The pre-transform
 * markup IS the degradation path (FR-042): a client that cannot render the
 * table still shows the plain link and the plain image.
 */
import { describe, expect, it } from 'vitest';
import type { BrandHexColor } from '@/modules/broadcasts/domain/brand/brand-settings';
import { applyDesignBlocks } from '@/modules/broadcasts/domain/design-blocks/render-blocks';

const NO_BRAND = { primaryColor: null } as const;

describe('applyDesignBlocks — CTA', () => {
  const cta = '<p>Intro</p><a data-eb="cta" href="https://example.org/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">Register now</a><p>Outro</p>';

  it('renders with the brand colour and degrades to the same <a>', () => {
    const out = applyDesignBlocks(cta, { primaryColor: '#b04a00' as BrandHexColor });
    // The button cell carries the tenant colour as bgcolor AND inline background.
    expect(out).toContain('bgcolor="#b04a00"');
    expect(out).toMatch(/background(-color)?:#b04a00/);
    // The same anchor survives inside: same href, same text, white text on it.
    expect(out).toMatch(/<a [^>]*href="https:\/\/example\.org\/x\?a=1&amp;b=2"[^>]*>Register now<\/a>/);
    expect(out).toMatch(/<a [^>]*color:#ffffff/);
    // Surrounding content is untouched, the marker is consumed.
    expect(out.startsWith('<p>Intro</p>')).toBe(true);
    expect(out.endsWith('<p>Outro</p>')).toBe(true);
    expect(out).not.toContain('data-eb="cta"');
  });

  it('uses the platform default #10487a when no brand colour is set', () => {
    const out = applyDesignBlocks(cta, NO_BRAND);
    expect(out).toContain('bgcolor="#10487a"');
  });

  it('keeps the link hardening (target + rel) the sanitiser forced', () => {
    const out = applyDesignBlocks(cta, NO_BRAND);
    expect(out).toMatch(/<a [^>]*target="_blank"/);
    expect(out).toMatch(/<a [^>]*rel="noopener noreferrer nofollow"/);
  });

  it('is deterministic: the same input renders the same bytes', () => {
    expect(applyDesignBlocks(cta, NO_BRAND)).toBe(applyDesignBlocks(cta, NO_BRAND));
  });
});

describe('applyDesignBlocks — banner', () => {
  const banner = '<h2>Title</h2><img data-eb="banner" src="https://cdn.example.org/b.png" alt="Autumn &quot;dinner&quot;"><p>Body</p>';

  it('renders a full-width image cell and degrades to the same <img>', () => {
    const out = applyDesignBlocks(banner, NO_BRAND);
    expect(out).toMatch(/<table role="presentation" width="100%"/);
    expect(out).toMatch(/<img [^>]*src="https:\/\/cdn\.example\.org\/b\.png"[^>]*alt="Autumn &quot;dinner&quot;"/);
    expect(out).toMatch(/<img [^>]*width="600"/);
    expect(out).toMatch(/<img [^>]*style="[^"]*max-width:100%/);
    expect(out).not.toContain('data-eb="banner"');
  });
});

describe('applyDesignBlocks — fail-safe', () => {
  it('leaves a plain link, a plain image and an unknown data-eb value exactly as they are', () => {
    const html =
      '<p><a href="https://plain.example/">plain</a></p>' +
      '<p><img src="https://cdn.example/p.png" alt="p"></p>' +
      '<a data-eb="hero" href="https://x.example/">t</a>' +
      '<img data-eb="cta" src="https://c.example/i.png" alt="wrong element">';
    expect(applyDesignBlocks(html, NO_BRAND)).toBe(html);
  });

  it('never re-sanitises: the output is the input plus platform markup, nothing removed', () => {
    const html = '<p>Only text &amp; entities</p>';
    expect(applyDesignBlocks(html, NO_BRAND)).toBe(html);
  });

  it('a body without markers is returned as the identical string (the byte-identical guard)', () => {
    const html = '<h2>Q</h2><p>Hello <strong>x</strong></p><hr><ul><li>a</li></ul>';
    expect(applyDesignBlocks(html, { primaryColor: '#b04a00' as BrandHexColor })).toBe(html);
  });
});

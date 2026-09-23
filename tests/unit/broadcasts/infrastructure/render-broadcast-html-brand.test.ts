/**
 * F119 T031 (owner) · T090 · T091 — brand chrome in `renderBroadcastHtml`.
 *
 * FR-041a: the header shows the chamber's logo when one is on file and the
 * chamber name otherwise — automatically, never user-placed.
 * FR-041c: the footer shows the brand postal address when set (line breaks
 * kept), the chamber name only while unset; the CTA uses the brand colour,
 * the platform default `#10487a` when none is set. Brand chrome is read
 * LIVE at render time — it is an input to this function, never part of a
 * version. Every `no brand` case stays byte-identical to the baseline
 * (`render-broadcast-html-baseline.test.ts`, T007).
 */
import { describe, expect, it } from 'vitest';
import type { BrandHexColor } from '@/modules/broadcasts/domain/brand/brand-settings';
import { renderBroadcastHtml } from '@/modules/broadcasts/infrastructure/resend/email-template';

const BASE = {
  subject: 'Hello',
  bodyHtml: '<p>Body</p>',
  tenantDisplayName: 'Chamber & Co',
  locale: 'en' as const,
};
const NO_BRAND = { primaryColor: null, postalAddress: null, logoUrl: null };

function headerCell(html: string): string {
  const m = /<tr><td style="padding:24px 32px 16px 32px;border-bottom:1px solid #eee">([\s\S]*?)<\/td><\/tr>/.exec(html);
  expect(m).not.toBeNull();
  return m![1]!;
}

describe('header (FR-041a)', () => {
  it('logo present → the header carries the logo, named for the chamber', () => {
    const html = renderBroadcastHtml({
      ...BASE,
      brand: { ...NO_BRAND, logoUrl: 'https://blob.example/logos/abc.png?x=1&y=2' },
    });
    const header = headerCell(html);
    expect(header).toMatch(/<img [^>]*src="https:\/\/blob\.example\/logos\/abc\.png\?x=1&amp;y=2"/);
    expect(header).toMatch(/<img [^>]*alt="Chamber &amp; Co"/);
    expect(header).toMatch(/<img [^>]*style="[^"]*max-height:48px/);
    expect(header).not.toContain('<strong');
  });

  it('logo absent → the chamber name, exactly as before', () => {
    const withBrand = renderBroadcastHtml({ ...BASE, brand: NO_BRAND });
    const withoutBrand = renderBroadcastHtml(BASE);
    expect(headerCell(withBrand)).toBe('<strong style="font-size:14px;color:#666">Chamber &amp; Co</strong>');
    expect(withBrand).toBe(withoutBrand);
  });
});

describe('footer postal address (FR-041c)', () => {
  it('set → printed in the footer with line breaks kept and text escaped', () => {
    const html = renderBroadcastHtml({
      ...BASE,
      brand: { ...NO_BRAND, postalAddress: '12 Sukhumvit <Rd>\nBangkok & 10110' },
    });
    expect(html).toContain('<p style="margin:0">12 Sukhumvit &lt;Rd&gt;<br>Bangkok &amp; 10110</p>');
    expect(html).not.toContain('Sent by Chamber');
  });

  it('unset → the chamber name only, exactly as before', () => {
    const html = renderBroadcastHtml({ ...BASE, brand: NO_BRAND });
    expect(html).toContain('<p style="margin:0">Sent by Chamber &amp; Co.</p>');
  });
});

describe('design blocks are applied after sanitisation (T016 wiring)', () => {
  const cta = '<p>x</p><a data-eb="cta" href="https://e.example/">Go</a>';

  it('the CTA cell carries the tenant\'s brand_primary_color', () => {
    const html = renderBroadcastHtml({ ...BASE, bodyHtml: cta, brand: { ...NO_BRAND, primaryColor: '#b04a00' as BrandHexColor } });
    expect(html).toContain('bgcolor="#b04a00"');
    expect(html).not.toContain('data-eb="cta"');
  });

  it('and the platform default #10487a when none is set — brand given or not', () => {
    expect(renderBroadcastHtml({ ...BASE, bodyHtml: cta, brand: NO_BRAND })).toContain('bgcolor="#10487a"');
    expect(renderBroadcastHtml({ ...BASE, bodyHtml: cta })).toContain('bgcolor="#10487a"');
  });
});

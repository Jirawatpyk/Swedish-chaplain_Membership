/**
 * PR L (29 Oct 2026) — the E-Blast fits a phone screen.
 *
 * The card used to be `<table width="600">`: the attribute held it at 600px,
 * so a phone mail app shrank the whole email and the portal's phone preview
 * scrolled it sideways. A wide image in the body pushed it wider still
 * (measured: 1288px of document in a 358px frame with a 1200px image). Now:
 * - the card is fluid up to 600px, and Outlook desktop (which ignores
 *   `max-width`) keeps 600px through an MSO ghost table;
 * - a viewport meta lets phone clients lay it out at the screen's width;
 * - body images never outgrow the card, and phone side padding is 16px.
 * The header, body and footer cells are otherwise unchanged.
 */
import { describe, expect, it } from 'vitest';
import { renderBroadcastHtml } from '@/modules/broadcasts/infrastructure/resend/email-template';

const BASE = {
  subject: 'Hello',
  bodyHtml: '<p>Body</p><p><img src="https://cdn.example.org/wide.png" alt="Wide"></p>',
  tenantDisplayName: 'Chamber & Co',
  locale: 'en' as const,
};

function withoutMso(html: string): string {
  return html.replace(/<!--\[if mso\]>[\s\S]*?<!\[endif\]-->/g, '');
}

describe.each([
  ['no brand', BASE],
  [
    'with a brand',
    { ...BASE, brand: { primaryColor: null, postalAddress: 'Line 1\nLine 2', logoUrl: 'https://blob.example/l.png' } },
  ],
] as const)('%s', (_name, input) => {
  const html = renderBroadcastHtml(input);

  it('the card is fluid up to 600px: no fixed 600 width outside the Outlook ghost table', () => {
    expect(withoutMso(html)).not.toMatch(/<table[^>]*width="600"/);
    expect(html).toMatch(/<table role="presentation" class="eb-card" width="100%"[^>]*style="max-width:600px;/);
  });

  it('Outlook desktop keeps 600px through one balanced MSO ghost table', () => {
    const open = html.match(/<!--\[if mso\]><table[^>]*width="600"[^>]*><tr><td><!\[endif\]-->/g) ?? [];
    const close = html.match(/<!--\[if mso\]><\/td><\/tr><\/table><!\[endif\]-->/g) ?? [];
    expect(open).toHaveLength(1);
    expect(close).toHaveLength(1);
    expect(html.indexOf(open[0]!)).toBeLessThan(html.indexOf('class="eb-card"'));
    expect(html.indexOf(close[0]!)).toBeGreaterThan(html.indexOf('class="eb-card"'));
  });

  it('phone clients lay it out at the screen width', () => {
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
  });

  it('body images never outgrow the card, and phone side padding drops to 16px', () => {
    const style = /<head>[\s\S]*<style>([\s\S]*?)<\/style>[\s\S]*<\/head>/.exec(html)?.[1] ?? '';
    // Rows after the header: the logo keeps its own 240px cap.
    expect(style).toContain('.eb-card tr+tr img{max-width:100%!important;height:auto!important}');
    expect(style).toMatch(/@media \(max-width:480px\)\{\.eb-card td\{padding-left:16px!important;padding-right:16px!important\}\}/);
  });
});

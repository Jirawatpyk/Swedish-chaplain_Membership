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
    // The body cell only: the logo keeps its own 240px cap.
    expect(style).toContain('.eb-body img{max-width:100%!important;height:auto!important}');
    expect(style).toContain('@media (max-width:480px){.eb-cell{padding-left:16px!important;padding-right:16px!important}}');
  });

  it('a body image carries its own cap too, for a client that drops <style>', () => {
    expect(html).toContain('<img style="max-width:100%;height:auto" src="https://cdn.example.org/wide.png" alt="Wide">');
  });
});

// Review round 1 (PR L): a rule on every `td` in the card reached the design
// blocks' own cells and padded the CTA button and the banner on phones.
describe('design blocks keep their own cells', () => {
  const html = renderBroadcastHtml({
    ...BASE,
    bodyHtml:
      '<p>Intro</p><a data-eb="cta" href="https://example.org/r" target="_blank" rel="noopener noreferrer nofollow">Register</a>' +
      '<img data-eb="banner" src="https://cdn.example.org/b.png" alt="Banner">',
  });

  it('only the card\'s header, body and footer cells take the phone padding', () => {
    expect(html.match(/class="eb-cell[^"]*"/g)).toHaveLength(3);
    expect(html).toMatch(/<td bgcolor="[^"]+" style="border-radius:6px;background-color:[^"]+">/);
    expect(html).toContain('<tr><td style="padding:0"><img');
  });

  it('the banner image keeps its own style and gets no second one', () => {
    expect(html).toMatch(/<img src="https:\/\/cdn\.example\.org\/b\.png" alt="Banner" width="600" style="display:block;width:100%;max-width:100%;height:auto;border:0">/);
  });
});

// PR L follow-up (the maintainer, 29 Oct): the footer's grey #888 at 11px was
// 3.5:1 on white, under WCAG AA's 4.5:1, and small for Thai's stacked vowels;
// and on a screen of 300px or less the 240px logo outgrew the card.
describe('footer contrast and the logo on a very narrow screen', () => {
  const html = renderBroadcastHtml({
    ...BASE,
    brand: { primaryColor: null, postalAddress: null, logoUrl: 'https://blob.example/l.png' },
  });

  it('the footer is #6b6b6b (5.3:1 on white) at 12px', () => {
    expect(html).toMatch(/border-top:1px solid #eee;font-size:12px;line-height:1\.5;color:#6b6b6b" class="eb-cell">/);
    expect(html).not.toContain('color:#888');
  });

  it('the logo shrinks to the card at 300px and below, and keeps its 240px cap above', () => {
    expect(html).toMatch(/<img [^>]*class="eb-logo"[^>]*style="[^"]*max-width:240px/);
    expect(html).toContain('@media (max-width:300px){.eb-logo{max-width:100%!important;height:auto!important}}');
  });
});

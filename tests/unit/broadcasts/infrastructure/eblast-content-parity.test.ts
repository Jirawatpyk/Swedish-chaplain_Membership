/**
 * F119 T008 — SC-011 element-and-attribute parity across every stage
 * (research R9).
 *
 * "For every kind of content the tool offers, zero elements are stripped or
 * altered between the editor, the preview, the test copy and the delivered
 * email — verified by an automated element-by-element comparison." One
 * document carrying EVERY offered construct goes through:
 *
 *   1. the editor's paste sanitiser  — DOMPurify with the shared policy
 *      (`makeBroadcastSanitizerConfig`, what `tiptap-editor.tsx` runs)
 *   2. the server sanitiser          — `dompurifySanitizer` (Application port)
 *   3. the preview                   — `renderBroadcastPreview` use case
 *   4. the send-time render          — `renderBroadcastHtml` (the Resend body;
 *      the test copy goes through the identical function)
 *
 * Stages 1 and 2 must yield the identical element+attribute multiset; stages
 * 3 and 4 must be the same bytes and must contain every user element of
 * stage 2 (the design blocks add platform markup around them — they never
 * remove the user's `<a>` / `<img>`, FR-042).
 *
 * The positive control proves the comparison bites: dropping `blockquote`
 * from one config must fail it.
 *
 * Senior-tester review M5 — this file used to sit in `tests/integration/`
 * although it opens no connection and imports no schema: it cost a slot in the
 * ~40-minute live-Neon run and, worse, it only ran when someone remembered to
 * run that suite. Every collaborator here is the REAL one the route calls (the
 * shared policy, `dompurifySanitizer`, `renderBroadcastPreview`,
 * `renderBroadcastHtml`) — none of them is a fixture, and none of them needs a
 * database.
 */
import DOMPurify from 'isomorphic-dompurify';
import { describe, expect, it } from 'vitest';
import type { BrandHexColor } from '@/modules/broadcasts/domain/brand/brand-settings';
import { installBroadcastSanitizerHooks, makeBroadcastSanitizerConfig } from '@/lib/broadcast-content-policy';
import { dompurifySanitizer } from '@/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer';
import { renderBroadcastHtml } from '@/modules/broadcasts/infrastructure/resend/email-template';
import { renderBroadcastPreview } from '@/modules/broadcasts/application/use-cases/render-broadcast-preview';
import { emailTemplateRenderer } from '@/modules/broadcasts/infrastructure/resend/email-template-renderer';

// Every construct the toolbar offers (FR-038 + FR-041), each with every
// attribute the policy keeps. `class` and `style` appear ON PURPOSE so the
// test also proves they are dropped identically at every stage.
const EVERY_CONSTRUCT =
  '<h1>H1</h1><h2>H2</h2><h3>H3</h3><h4>H4</h4>' +
  '<p>Para <strong>bold</strong> <em>em</em> <u>under</u> line<br>break &amp; entity</p>' +
  '<p><a href="https://example.org/a?x=1&amp;y=2" target="_blank" rel="noopener noreferrer nofollow">link</a></p>' +
  '<p><a href="mailto:info@example.org">mail</a></p>' +
  '<ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>' +
  '<blockquote>quote</blockquote><hr>' +
  '<p><img src="https://cdn.example.org/i.png" alt="An image"></p>' +
  '<a data-eb="cta" href="https://example.org/go" target="_blank" rel="noopener noreferrer nofollow">Register</a>' +
  '<img data-eb="banner" src="https://cdn.example.org/b.png" alt="Banner">' +
  '<p class="x" style="color:red">styled</p><span>span text</span>' +
  // The two hook cases: a link without hardening attributes must GAIN them at
  // every stage; a data: image must LOSE its src at every stage (FR-014).
  '<p><a href="https://bare.example/">bare link</a></p>' +
  '<p><img src="data:image/png;base64,AAAA" alt="inlined"></p>';

type Element = { readonly tag: string; readonly attrs: ReadonlyMap<string, string> };

const TAG = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function elements(html: string): Element[] {
  const out: Element[] = [];
  for (const m of html.matchAll(TAG)) {
    const attrs = new Map<string, string>();
    for (const a of (m[2] ?? '').matchAll(ATTR)) {
      if (a[0].length === 0) continue;
      attrs.set(a[1]!.toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '');
    }
    out.push({ tag: m[1]!.toLowerCase(), attrs });
  }
  return out;
}

/** "tag|attr=value,…" with attributes sorted — the multiset key. */
function key(e: Element): string {
  const attrs = [...e.attrs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`);
  return `${e.tag}|${attrs.join(',')}`;
}

function multiset(html: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of elements(html)) m.set(key(e), (m.get(key(e)) ?? 0) + 1);
  return m;
}

function sortedEntries(m: Map<string, number>): [string, number][] {
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function editorSanitise(html: string, config = makeBroadcastSanitizerConfig({ images: true })): string {
  installBroadcastSanitizerHooks(DOMPurify);
  const out = DOMPurify.sanitize(html, config as unknown as Parameters<typeof DOMPurify.sanitize>[1]);
  return typeof out === 'string' ? out : '';
}

/** The user-content cell of the rendered email (between the header row and the footer row). */
function bodyCell(fullHtml: string): string {
  const start = fullHtml.indexOf('line-height:1.6;color:#1a1a1a">') + 'line-height:1.6;color:#1a1a1a">'.length;
  const end = fullHtml.indexOf('</td></tr><tr><td style="padding:16px 32px 24px 32px;border-top');
  expect(start).toBeGreaterThan(30);
  expect(end).toBeGreaterThan(start);
  return fullHtml.slice(start, end);
}

const TENANT = { tenantDisplayName: 'Parity Chamber', locale: 'en' as const, subject: 'Parity' };

describe('SC-011 — element+attribute multiset is identical at every stage', () => {
  it('editor paste sanitiser and server sanitiser agree on every element and attribute', () => {
    const editor = multiset(editorSanitise(EVERY_CONSTRUCT));
    const server = multiset(dompurifySanitizer.sanitize(EVERY_CONSTRUCT));
    expect(sortedEntries(server)).toEqual(sortedEntries(editor));
    // Sanity on the document itself: every offered construct survived.
    const tags = new Set(elements(dompurifySanitizer.sanitize(EVERY_CONSTRUCT)).map((e) => e.tag));
    for (const t of ['h1', 'h2', 'h3', 'h4', 'p', 'strong', 'em', 'u', 'br', 'a', 'ul', 'ol', 'li', 'blockquote', 'hr', 'img']) {
      expect(tags.has(t), t).toBe(true);
    }
    expect(tags.has('span')).toBe(false);
    // `class` / `style` are dropped by both; `data-eb` is kept by both.
    const server2 = dompurifySanitizer.sanitize(EVERY_CONSTRUCT);
    expect(server2).not.toMatch(/class=|style=/);
    expect(server2).toContain('data-eb="cta"');
    expect(server2).toContain('data-eb="banner"');
    // The hook ran on both sides: the bare link is hardened, the data: src is gone.
    for (const out of [server2, editorSanitise(EVERY_CONSTRUCT)]) {
      const bare = elements(out).find((e) => e.attrs.get('href') === 'https://bare.example/');
      expect(bare?.attrs.get('target')).toBe('_blank');
      expect(bare?.attrs.get('rel')).toBe('noopener noreferrer nofollow');
      expect(out).not.toContain('data:image');
      expect(out).toContain('alt="inlined"');
    }
  });

  it('the preview and the send-time render are the same bytes and keep every user element', async () => {
    const sanitised = dompurifySanitizer.sanitize(EVERY_CONSTRUCT);
    const brand = { primaryColor: null, postalAddress: null, logoUrl: null };
    const sent = renderBroadcastHtml({ ...TENANT, bodyHtml: sanitised, brand });
    const preview = await renderBroadcastPreview(
      { sanitizer: dompurifySanitizer, brand: { load: async () => brand }, renderer: emailTemplateRenderer },
      { ...TENANT, bodyHtml: EVERY_CONSTRUCT, tenantId: 'parity' as never, surface: 'member' },
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.html).toBe(sent);

    // Every user element of stage 2 is present in the rendered body cell —
    // same tag, every user attribute present with the same value (the
    // block renderer consumes `data-eb` and may add platform attributes).
    const rendered = elements(bodyCell(sent));
    const remaining = [...rendered];
    for (const user of elements(sanitised)) {
      const idx = remaining.findIndex(
        (r) =>
          r.tag === user.tag &&
          [...user.attrs.entries()].every(([k, v]) => k === 'data-eb' || r.attrs.get(k) === v),
      );
      expect(idx, `${key(user)} survived the render`).toBeGreaterThanOrEqual(0);
      remaining.splice(idx, 1);
    }
  });

  /**
   * Senior-tester review M4 — every parity case above ran with an ALL-NULL
   * brand, which is the one shape `renderBroadcastHtml` is documented to keep
   * byte-identical to the pre-F119 email. The brand chrome (FR-041a/c) is
   * therefore the half the parity claim never covered: a preview that dropped
   * the logo, the postal line or the CTA colour would have passed every
   * assertion here while showing the member something the recipient does not
   * get. The brand is read LIVE at render time by BOTH paths, so this asserts
   * the preview carries it AND that it is the same bytes as the send.
   */
  it('a non-null brand reaches the PREVIEW too — logo, postal line and CTA colour, byte-identical to the send', async () => {
    const brand = {
      primaryColor: '#b04a00' as BrandHexColor,
      postalAddress: '12 Sukhumvit <Rd>\nBangkok & 10110',
      logoUrl: 'https://blob.example/logos/abc.png?x=1&y=2',
    };
    // A CTA marker, so the brand COLOUR has somewhere to land.
    const body =
      '<p>Body</p><a data-eb="cta" href="https://example.org/go">Register</a>';

    const sent = renderBroadcastHtml({
      ...TENANT,
      bodyHtml: dompurifySanitizer.sanitize(body),
      brand,
    });
    const preview = await renderBroadcastPreview(
      {
        sanitizer: dompurifySanitizer,
        brand: { load: async () => brand },
        renderer: emailTemplateRenderer,
      },
      { ...TENANT, bodyHtml: body, tenantId: 'parity' as never, surface: 'member' },
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const html = preview.value.html;
    // The brand colour on the CTA cell (FR-041c) …
    expect(html).toContain('bgcolor="#b04a00"');
    expect(html).not.toContain('data-eb="cta"');
    // … the logo in the header, named for the chamber (FR-041a) …
    expect(html).toMatch(
      /<img [^>]*src="https:\/\/blob\.example\/logos\/abc\.png\?x=1&amp;y=2"/,
    );
    expect(html).toMatch(/<img [^>]*alt="Parity Chamber"/);
    // … and the postal address in the footer, escaped, line breaks kept.
    expect(html).toContain(
      '<p style="margin:0">12 Sukhumvit &lt;Rd&gt;<br>Bangkok &amp; 10110</p>',
    );
    expect(html).not.toContain('Sent by Parity Chamber');

    // The whole point: what the member approves is what the recipient gets.
    expect(html).toBe(sent);
    // …and it is genuinely different from the no-brand render, so the
    // assertions above cannot be passing on the platform default.
    expect(html).not.toBe(
      renderBroadcastHtml({
        ...TENANT,
        bodyHtml: dompurifySanitizer.sanitize(body),
        brand: { primaryColor: null, postalAddress: null, logoUrl: null },
      }),
    );
  });

  it('positive control: dropping `blockquote` from one config fails the comparison', () => {
    const base = makeBroadcastSanitizerConfig({ images: true });
    const narrowed = { ...base, ALLOWED_TAGS: base.ALLOWED_TAGS.filter((t) => t !== 'blockquote') };
    const editor = multiset(editorSanitise(EVERY_CONSTRUCT, narrowed as typeof base));
    const server = multiset(dompurifySanitizer.sanitize(EVERY_CONSTRUCT));
    expect(sortedEntries(server)).not.toEqual(sortedEntries(editor));
  });
});

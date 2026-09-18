/**
 * F119 T009 / T015 — design-block markers (`domain/design-blocks/block-markers.ts`).
 *
 * The editor serialises a CTA as `<a data-eb="cta" href="…">text</a>` and a
 * banner as `<img data-eb="banner" src="…" alt="…">`; the shared sanitiser
 * keeps `data-eb` and may reorder attributes; `parseBlockMarkers` must read
 * the same block set whatever the attribute order and whatever hostile text
 * the (already-escaped) content carries. An unknown `data-eb` value is NOT a
 * block — it is left as a plain element (research R10: unknown ⇒ no block ⇒
 * fail-safe; no `default: return _exhaustive` anywhere near it).
 *
 * Bounded matcher — no HTML parser, no jsdom, no new dependency.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  parseBlockMarkers,
  type DesignBlock,
} from '@/modules/broadcasts/domain/design-blocks/block-markers';

// Values as they arrive AFTER sanitisation: DOMPurify (via jsdom) serialises
// `"` as `&quot;`, `&` as `&amp;`, `<` as `&lt;`, `>` as `&gt;` — so the
// markup never carries a raw `"` inside a value or a raw `<` in text. The
// parser DECODES them: a block carries the real string the user typed.
const escapeAttr = (s: string): string =>
  s.replace(/[<>"&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' })[c]!);
const escapeText = (s: string): string =>
  s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
// Whitespace-normalised: the parser collapses runs and trims CTA text the way
// an email client renders it, so the generated text is already in that form.
const rawText = fc
  .string({ minLength: 1, maxLength: 60 })
  .filter((s) => s === s.replace(/\s+/g, ' ').trim() && s.length > 0);
const rawAttr = fc.string({ minLength: 1, maxLength: 40 });
const httpsUrl = fc.webUrl({ validSchemes: ['https'] });

function shuffle<T>(arr: readonly T[], seed: number): T[] {
  const out = [...arr];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function ctaHtml(href: string, text: string, seed: number, extra: readonly string[] = []): string {
  const attrs = shuffle([`data-eb="cta"`, `href="${escapeAttr(href)}"`, 'target="_blank"', 'rel="noopener noreferrer nofollow"', ...extra], seed);
  return `<a ${attrs.join(' ')}>${escapeText(text)}</a>`;
}

function bannerHtml(src: string, alt: string, seed: number): string {
  const attrs = shuffle([`data-eb="banner"`, `src="${escapeAttr(src)}"`, `alt="${escapeAttr(alt)}"`], seed);
  return `<img ${attrs.join(' ')}>`;
}

describe('parseBlockMarkers — property: any attribute order parses to the same DesignBlock', () => {
  it('a CTA parses to { cta, href, text } whatever the attribute order', () => {
    fc.assert(
      fc.property(httpsUrl, rawText, fc.nat(), fc.nat(), (href, text, seedA, seedB) => {
        const a = parseBlockMarkers(`<p>before</p>${ctaHtml(href, text, seedA)}<p>after</p>`);
        const b = parseBlockMarkers(`<p>before</p>${ctaHtml(href, text, seedB)}<p>after</p>`);
        const expected: DesignBlock = { kind: 'cta', href, text };
        expect(a).toEqual([expected]);
        expect(b).toEqual([expected]);
      }),
      { numRuns: 200 },
    );
  });

  it('a banner parses to { banner, src, alt } whatever the attribute order', () => {
    fc.assert(
      fc.property(httpsUrl, rawAttr, fc.nat(), (src, alt, seed) => {
        const blocks = parseBlockMarkers(`<h2>t</h2>${bannerHtml(src, alt, seed)}<p>x</p>`);
        expect(blocks).toEqual([{ kind: 'banner', src, alt }]);
      }),
      { numRuns: 200 },
    );
  });

  it('blocks are returned in document order, with plain links and images ignored', () => {
    const html =
      '<p><a href="https://plain.example/">plain</a></p>' +
      ctaHtml('https://one.example/', 'One', 1) +
      '<p><img src="https://cdn.example/plain.png" alt="plain"></p>' +
      bannerHtml('https://cdn.example/b.png', 'Banner', 2) +
      ctaHtml('https://two.example/', 'Two', 3);
    expect(parseBlockMarkers(html)).toEqual([
      { kind: 'cta', href: 'https://one.example/', text: 'One' },
      { kind: 'banner', src: 'https://cdn.example/b.png', alt: 'Banner' },
      { kind: 'cta', href: 'https://two.example/', text: 'Two' },
    ]);
  });

  it('CTA text is the anchor\'s text content: inline marks are stripped, entities decoded', () => {
    const html = '<a data-eb="cta" href="https://x.example/">Join <strong>us</strong> &amp; RSVP</a>';
    expect(parseBlockMarkers(html)).toEqual([{ kind: 'cta', href: 'https://x.example/', text: 'Join us & RSVP' }]);
  });

  it('`data-eb="anything"` renders as a plain element — it is not a block', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 12 }).filter((v) => v !== 'cta' && v !== 'banner' && !/["<>&]/.test(v)),
        (value) => {
          const html = `<a data-eb="${value}" href="https://x.example/">t</a><img data-eb="${value}" src="https://c.example/i.png" alt="a">`;
          expect(parseBlockMarkers(html)).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('a marker on the wrong element is not a block (`<img data-eb="cta">`, `<a data-eb="banner">`)', () => {
    const html = '<img data-eb="cta" src="https://c.example/i.png" alt="a"><a data-eb="banner" href="https://x.example/">t</a>';
    expect(parseBlockMarkers(html)).toEqual([]);
  });

  it('a missing href / src still yields the block so validation can name the violation', () => {
    expect(parseBlockMarkers('<a data-eb="cta">Go</a>')).toEqual([{ kind: 'cta', href: '', text: 'Go' }]);
    expect(parseBlockMarkers('<img data-eb="banner" src="https://c.example/i.png">')).toEqual([
      { kind: 'banner', src: 'https://c.example/i.png', alt: '' },
    ]);
  });

  it('is bounded: 10,000 markers parse without catastrophic backtracking', () => {
    const many = ctaHtml('https://x.example/', 'Go', 7).repeat(10_000);
    const started = Date.now();
    expect(parseBlockMarkers(many)).toHaveLength(10_000);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('parseBlockMarkers — parser edges', () => {
  it('reads single-quoted and bare attribute values, and a tag with no attributes at all', () => {
    expect(parseBlockMarkers("<a data-eb='cta' href=https://x.example/>Go</a>")).toEqual([
      { kind: 'cta', href: 'https://x.example/', text: 'Go' },
    ]);
    expect(parseBlockMarkers('<a>plain</a><img>')).toEqual([]);
    // A valueless marker attribute is the empty marker — not a block.
    expect(parseBlockMarkers('<a data-eb href="https://x.example/">t</a>')).toEqual([]);
  });

  it('an unterminated CTA anchor is not a block (nothing to render, nothing to validate)', () => {
    expect(parseBlockMarkers('<a data-eb="cta" href="https://x.example/">no close tag')).toEqual([]);
  });

  it('a banner without src yields an empty src so validation, not the parser, decides', () => {
    expect(parseBlockMarkers('<img data-eb="banner" alt="x">')).toEqual([{ kind: 'banner', src: '', alt: 'x' }]);
  });
});

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
  findBlockMarkers,
  parseBlockMarkers,
  type DesignBlock,
} from '@/modules/broadcasts/domain/design-blocks/block-markers';

// Values as they arrive AFTER sanitisation.
//
// Security review F1-1 (2026-09-22): this generator used to escape `<` and
// `>` inside ATTRIBUTE values too, which is FALSE — HTML attribute
// serialisation escapes only `&`, NBSP and `"`, so a raw `>` reaches the
// markup and `OPEN_TAG`'s `[^>]*` cuts the tag short. Escaping them here made
// the whole property suite blind to the splice that shipped. It now matches
// the real serialiser, and `rawAttr` deliberately SEEDS `<` / `>` so the
// property exercises the case. The sanitiser hook
// (`installBroadcastSanitizerHooks`) is what guarantees no such value reaches
// this parser in production; the parser stays sound either way.
const escapeAttr = (s: string): string =>
  s.replace(/["&]/g, (c) => ({ '"': '&quot;', '&': '&amp;' })[c]!);
const escapeText = (s: string): string =>
  s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
// Whitespace-normalised: the parser collapses runs and trims CTA text the way
// an email client renders it, so the generated text is already in that form.
const rawText = fc
  .string({ minLength: 1, maxLength: 60 })
  .filter((s) => s === s.replace(/\s+/g, ' ').trim() && s.length > 0);
const rawAttr = fc.oneof(
  fc.string({ minLength: 1, maxLength: 40 }),
  // Angle brackets seeded into the value — the F1-1 shape.
  fc
    .tuple(fc.string({ maxLength: 12 }), fc.constantFrom('<', '>', '><', '"><'), fc.string({ maxLength: 12 }))
    .map(([a, b, c]) => `${a}${b}${c}`),
);
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

  it('a banner parses to { banner, src, alt } whatever the attribute order — and a value that could break the tag is refused outright, never parsed short', () => {
    const PREFIX = '<h2>t</h2>';
    fc.assert(
      fc.property(httpsUrl, rawAttr, fc.nat(), (src, alt, seed) => {
        const element = bannerHtml(src, alt, seed);
        const spans = findBlockMarkers(`${PREFIX}${element}<p>x</p>`);
        // Security review F1-1: the span MUST cover the whole element or the
        // element must not be a block at all. A span that ends inside the
        // element is what let `applyDesignBlocks` emit the tail as raw markup.
        expect(spans.length).toBeLessThanOrEqual(1);
        if (spans.length === 1) {
          expect(spans[0]).toEqual({
            block: { kind: 'banner', src, alt },
            start: PREFIX.length,
            end: PREFIX.length + element.length,
          });
        }
        // Free of angle brackets — what the sanitiser hook guarantees in
        // production — it IS a block.
        if (!/[<>]/.test(src) && !/[<>]/.test(alt)) {
          expect(spans).toHaveLength(1);
        }
      }),
      { numRuns: 300 },
    );
  });

  /**
   * ROUND-2 T-5 (security sign-off). The banner arm got the angle-bracket
   * property after F1-1; the CTA arm did not, and it is the arm with a CLOSING
   * tag — so a value that cuts `OPEN_TAG` short there ends the span inside the
   * element just the same, and `applyDesignBlocks` re-emits the tail as raw
   * markup in the delivered email. Same invariant, same generator.
   */
  it('a CTA whose href seeds angle brackets is refused outright, never parsed short', () => {
    const PREFIX = '<h2>t</h2>';
    fc.assert(
      fc.property(rawAttr, fc.nat(), (href, seed) => {
        const element = ctaHtml(href, 'Go', seed);
        const spans = findBlockMarkers(`${PREFIX}${element}<p>x</p>`);
        expect(spans.length).toBeLessThanOrEqual(1);
        if (spans.length === 1) {
          // The span covers the WHOLE anchor, opening tag through `</a>`.
          expect(spans[0]!.start).toBe(PREFIX.length);
          expect(spans[0]!.end).toBe(PREFIX.length + element.length);
          expect(spans[0]!.block).toEqual({ kind: 'cta', href, text: 'Go' });
        }
        // Free of angle brackets — what the sanitiser hook guarantees in
        // production — it IS a block.
        if (!/[<>]/.test(href)) {
          expect(spans).toHaveLength(1);
        }
      }),
      { numRuns: 300 },
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

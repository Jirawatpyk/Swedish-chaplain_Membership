/**
 * F119 T015 — design-block markers (FR-041, research R10).
 *
 * The writing tool serialises the two system-controlled blocks as ordinary
 * allow-listed elements carrying one marker attribute the shared sanitiser
 * keeps (`data-eb`):
 *
 *   CTA button  → `<a data-eb="cta" href="…">text</a>`
 *   Banner      → `<img data-eb="banner" src="…" alt="…">`
 *
 * `parseBlockMarkers` reads them back from SANITISED HTML with a bounded,
 * attribute-order-independent matcher — no HTML parser, no jsdom, no new
 * dependency. An unknown `data-eb` value, or a marker on the wrong element,
 * is NOT a block: it stays a plain link / image (unknown ⇒ no block ⇒
 * fail-safe). There is deliberately no `default: return _exhaustive` arm
 * anywhere near this code.
 *
 * `validateBlocks` applies the FR-041 bounds and names the offending block.
 */

export const CTA_TEXT_MIN = 1 as const;
export const CTA_TEXT_MAX = 60 as const;
export const CTA_MAX_PER_MESSAGE = 3 as const;
export const BANNER_ALT_MIN = 1 as const;
export const BANNER_ALT_MAX = 125 as const;

/** The scheme allow-list shared with the link dialog and the sanitiser. */
const CTA_LINK_SCHEME = /^(?:https?:|mailto:)/i;

export type DesignBlock =
  | { readonly kind: 'cta'; readonly href: string; readonly text: string }
  | { readonly kind: 'banner'; readonly src: string; readonly alt: string };

export type DesignBlockMarker = DesignBlock['kind'];

export type BlockViolation =
  | { readonly code: 'cta_text_length'; readonly index: number; readonly min: typeof CTA_TEXT_MIN; readonly max: typeof CTA_TEXT_MAX }
  | { readonly code: 'cta_link_scheme'; readonly index: number }
  | { readonly code: 'too_many_cta'; readonly index: number; readonly max: typeof CTA_MAX_PER_MESSAGE }
  | { readonly code: 'banner_alt_required'; readonly index: number; readonly min: typeof BANNER_ALT_MIN; readonly max: typeof BANNER_ALT_MAX };

// One opening `<a …>` or `<img …>` tag. `[^>]*` cannot backtrack across `>`,
// so the scan is linear in the input length.
const OPEN_TAG = /<(a|img)\b([^>]*)>/gi;
// One attribute inside a tag: name, then an optional `=` and a quoted or
// bare value. Values never contain a raw `"` after sanitisation (jsdom
// serialises it as `&quot;`), which is what keeps this bounded.
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const MAX_CODE_POINT = 0x10ffff;

export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const cp = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      // The regex guarantees digits, so the only way this is not a code
      // point is being out of range — `String.fromCodePoint` would throw.
      return cp <= MAX_CODE_POINT ? String.fromCodePoint(cp) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function parseAttributes(raw: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  // `ATTR` always consumes at least the name character, so the global exec
  // loop cannot spin on a zero-length match.
  while ((m = ATTR.exec(raw)) !== null) {
    const name = m[1]!.toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (!out.has(name)) out.set(name, decodeHtmlEntities(value));
  }
  return out;
}

/** Anchor text as a reader sees it: inline marks stripped, entities decoded, whitespace collapsed. */
function anchorText(inner: string): string {
  return decodeHtmlEntities(inner.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

export interface MarkerSpan {
  readonly block: DesignBlock;
  /** Offsets of the whole element (open tag … close tag) in the source HTML. */
  readonly start: number;
  readonly end: number;
}

/**
 * Locate every block marker with its source span — the renderer replaces
 * exactly these spans and touches nothing else.
 */
export function findBlockMarkers(sanitisedHtml: string): readonly MarkerSpan[] {
  const spans: MarkerSpan[] = [];
  OPEN_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OPEN_TAG.exec(sanitisedHtml)) !== null) {
    const tag = m[1]!.toLowerCase();
    // Group 2 always participates (`[^>]*` matches the empty string).
    const rawAttrs = m[2]!;
    // Defence in depth (security review F1-1, 2026-09-22). `[^>]*` cannot
    // cross a `>`, so a `>` sitting INSIDE a quoted attribute value ends this
    // match early and the span would stop inside the element — which is how
    // `applyDesignBlocks` came to re-emit the remainder as raw markup. After
    // sanitisation a value never carries a raw `"` (serialised `&quot;`) nor,
    // since the sanitiser hook, a raw `<`/`>`; so in a well-formed tag the
    // quotes pair up. An ODD count proves the match was cut mid-value: the
    // element is not well-formed here, therefore it is NOT a block (unknown ⇒
    // no block ⇒ fail-safe, the same principle as an unknown marker value).
    let quotes = 0;
    for (let i = 0; i < rawAttrs.length; i += 1) if (rawAttrs[i] === '"') quotes += 1;
    if (quotes % 2 !== 0) continue;
    const attrs = parseAttributes(rawAttrs);
    const marker = attrs.get('data-eb');
    if (marker === undefined) continue;
    if (tag === 'a' && marker === 'cta') {
      const close = sanitisedHtml.indexOf('</a>', OPEN_TAG.lastIndex);
      if (close === -1) continue;
      const inner = sanitisedHtml.slice(OPEN_TAG.lastIndex, close);
      spans.push({
        block: { kind: 'cta', href: attrs.get('href') ?? '', text: anchorText(inner) },
        start: m.index,
        end: close + '</a>'.length,
      });
      OPEN_TAG.lastIndex = close + '</a>'.length;
      continue;
    }
    if (tag === 'img' && marker === 'banner') {
      spans.push({
        block: { kind: 'banner', src: attrs.get('src') ?? '', alt: attrs.get('alt') ?? '' },
        start: m.index,
        end: m.index + m[0].length,
      });
    }
    // Any other (tag, marker) pair is not a block — left as a plain element.
  }
  return spans;
}

export function parseBlockMarkers(sanitisedHtml: string): readonly DesignBlock[] {
  return findBlockMarkers(sanitisedHtml).map((s) => s.block);
}

export function validateBlocks(blocks: readonly DesignBlock[]): readonly BlockViolation[] {
  const violations: BlockViolation[] = [];
  let ctaCount = 0;
  blocks.forEach((block, index) => {
    switch (block.kind) {
      case 'cta': {
        ctaCount += 1;
        if (ctaCount > CTA_MAX_PER_MESSAGE) {
          violations.push({ code: 'too_many_cta', index, max: CTA_MAX_PER_MESSAGE });
          return;
        }
        const text = block.text.trim();
        if (text.length < CTA_TEXT_MIN || text.length > CTA_TEXT_MAX) {
          violations.push({ code: 'cta_text_length', index, min: CTA_TEXT_MIN, max: CTA_TEXT_MAX });
        }
        if (!CTA_LINK_SCHEME.test(block.href)) {
          violations.push({ code: 'cta_link_scheme', index });
        }
        return;
      }
      case 'banner': {
        const alt = block.alt.trim();
        if (alt.length < BANNER_ALT_MIN || alt.length > BANNER_ALT_MAX) {
          violations.push({ code: 'banner_alt_required', index, min: BANNER_ALT_MIN, max: BANNER_ALT_MAX });
        }
        return;
      }
    }
  });
  return violations;
}

/**
 * At least one violation — the shape a `content_rules` refusal carries. Typed
 * non-empty so the 422 mapping reads the first code without an "empty list"
 * fallback that no caller could reach.
 */
export type BlockViolations = readonly [BlockViolation, ...BlockViolation[]];

/** Narrows `validateBlocks`' result: true iff the body broke at least one rule. */
export function hasBlockViolations(violations: readonly BlockViolation[]): violations is BlockViolations {
  return violations.length > 0;
}

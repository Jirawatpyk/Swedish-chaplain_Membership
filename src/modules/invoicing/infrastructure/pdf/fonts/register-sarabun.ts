/**
 * T042 — Sarabun font registration for @react-pdf/renderer (F4).
 *
 * Runs at module-load time. Registering the same family twice is
 * harmless (idempotent in the library).
 *
 * Thai-shaping fix (2026-04-19 Thai-RD review finding):
 *   @react-pdf/renderer's default hyphenation callback splits words
 *   by character for line-breaking. On Thai text this destroys the
 *   complex-script shaping chain: the engine draws each code point in
 *   isolation, which visually reorders post-base vowels (e.g. "สวีเดน"
 *   renders as "สวเดนี") and decomposes sara-am (ำ, U+0E33) into its
 *   canonical components ํ + า (visible as "กำา" instead of "กำ").
 *
 *   Registering a callback that returns the word whole-unit keeps the
 *   shaping chain intact. This is the canonical workaround documented
 *   across multiple @react-pdf/renderer Thai-language issues.
 *
 *   Secondary fallback: `shapeThai()` normalises Thai strings to NFC
 *   before they reach the engine. Useful when upstream data may arrive
 *   in NFD form (decomposed from legacy systems).
 */
import path from 'node:path';
import { Font } from '@react-pdf/renderer';

const FONT_DIR = path.join(process.cwd(), 'public', 'fonts', 'sarabun');

let registered = false;

export function registerSarabun(): void {
  if (registered) return;
  registered = true;
  Font.register({
    family: 'Sarabun',
    fonts: [
      { src: path.join(FONT_DIR, 'Sarabun-Regular.ttf'), fontWeight: 400 },
      { src: path.join(FONT_DIR, 'Sarabun-Medium.ttf'), fontWeight: 500 },
      { src: path.join(FONT_DIR, 'Sarabun-Bold.ttf'), fontWeight: 700 },
    ],
  });

  // CRITICAL — fontkit's default hyphenation splits every word per
  // character for line-breaking. On Thai that destroys shaping. But
  // Thai also has no inter-word whitespace — returning `[word]`
  // unconditionally means a long Thai string ("บริษัท ... จำกัด
  // (มหาชน) แผนกสมาชิก...") is ONE atomic word and never breaks,
  // overflowing the container.
  //
  // Hybrid callback:
  //   - Non-Thai word  → `[word]` (fontkit default for whitespace-
  //                      delimited scripts is fine)
  //   - Thai word, short → `[word]` (no need to break)
  //   - Thai word, long  → segment via `Intl.Segmenter('th')` then
  //                        return the segments so the layout has
  //                        break points. Each segment is a proper
  //                        Thai word/cluster so shaping stays intact
  //                        within each piece.
  Font.registerHyphenationCallback((word: string) => {
    const hasThai = THAI_RANGE.test(word);
    if (!hasThai) return [word];
    if (word.length <= 20) return [word];
    try {
      const seg = new Intl.Segmenter('th', { granularity: 'word' });
      const parts = [...seg.segment(word)].map((s) => s.segment);
      // Drop empty segments that Intl.Segmenter occasionally emits.
      const cleaned = parts.filter((p) => p.length > 0);
      return cleaned.length > 0 ? cleaned : [word];
    } catch {
      return [word];
    }
  });
}

const THAI_RANGE = /[\u0E00-\u0E7F]/;

/**
 * Pre-shape a Thai string for @react-pdf/renderer / fontkit.
 *
 * Why: fontkit's Thai handling has two bugs that cause trailing
 * characters to be clipped at the end of lines:
 *   (1) Sara-am ำ (U+0E33) is decomposed internally to ◌ํ + า
 *       (U+0E4D + U+0E32) at shape time, but the **advance-width**
 *       for the enclosing Text element is computed at PRE-shape
 *       time counting ำ as a single character width. Render then
 *       produces two glyphs — the second (า) can push the last
 *       char of the string past the container edge, which fontkit
 *       clips silently.
 *   (2) No word-break rules for Thai — line-break opportunities
 *       default to whitespace-only, so a Thai run to the edge of
 *       the container gets no hyphenation point and the overflow
 *       is applied as clip, not wrap.
 *
 * Fixes (in order of effect):
 *   (a) **Pre-decompose ำ manually** (not via NFD on whole string
 *       — other Thai vowels are also affected by NFD and decomposing
 *       them confuses fontkit further). The layout engine now
 *       counts ◌ํ + า as two chars and allocates matching width.
 *   (b) Append a zero-width space (U+200B) sentinel so the layout
 *       has a break-point after the last real character. Prevents
 *       fontkit from treating the final Thai cluster as "overflow"
 *       when it sits exactly at the container edge.
 *
 * Both transforms are lossless — PDF text-layer extraction maps
 * back to logical order; Thai readers see the glyphs positioned
 * correctly.
 */
const SARA_AM = /\u0E33/g; // ำ
const NIKHAHIT_AA = '\u0E4D\u0E32'; // ◌ํ + า
const ZWSP = '\u200B';
const THAI_CODEPOINT = /[\u0E00-\u0E7F]/;

// Cache a single segmenter — constructing Intl.Segmenter per call is
// expensive (loads ICU word-break tables). Safe across render calls.
let thaiSegmenter: Intl.Segmenter | null = null;
function getThaiSegmenter(): Intl.Segmenter | null {
  if (thaiSegmenter !== null) return thaiSegmenter;
  try {
    thaiSegmenter = new Intl.Segmenter('th', { granularity: 'word' });
    return thaiSegmenter;
  } catch {
    return null;
  }
}

/**
 * Thai has no inter-word whitespace, so fontkit's default
 * whitespace-based line-break algorithm treats an entire Thai run as
 * a single un-breakable token — long legal names / addresses then
 * overflow the container horizontally.
 *
 * We walk the string with `Intl.Segmenter('th', 'word')` and inject
 * a zero-width space (U+200B) between consecutive Thai-word segments.
 * ZWSP is an ICU-approved line-break opportunity: invisible to
 * readers, ignored by copy-paste in most clients, but the layout
 * engine can break at these positions.
 *
 * Non-Thai spans are left untouched so existing spaces + Latin
 * hyphens continue to act as break points.
 */
const WRAP_THRESHOLD_CHARS = 55;

function injectThaiBreakPoints(s: string): string {
  if (!THAI_CODEPOINT.test(s)) return s;
  // Short runs don't need break points.
  if (s.length <= WRAP_THRESHOLD_CHARS) return s;
  const segmenter = getThaiSegmenter();
  if (segmenter === null) return s;
  const segments = [...segmenter.segment(s)].map((seg) => seg.segment);
  if (segments.length <= 1) return s;
  // For long strings, inject a real newline at word boundaries when
  // the current line-width budget is exceeded. @react-pdf / fontkit
  // does not reliably respect ZWSP as a break opportunity for
  // Thai-without-whitespace, so we fall back to a hard newline
  // which every text engine honours. The break falls at a
  // word-boundary (Intl.Segmenter), never mid-cluster.
  // CUMULATIVE line length — we do NOT reset on whitespace. fontkit
  // miscalculates Thai advance-widths and therefore doesn't break at
  // spaces anyway, so we have to insert the break ourselves based on
  // character count.
  let out = '';
  let lineLen = 0;
  for (let i = 0; i < segments.length; i++) {
    const cur = segments[i]!;
    if (cur === '\n') {
      out += cur;
      lineLen = 0;
      continue;
    }
    // Prefer to break BEFORE the current segment if adding it would
    // exceed the threshold. Breaking at a whitespace segment is
    // cleanest: consume the space as the line terminator.
    if (
      lineLen + cur.length > WRAP_THRESHOLD_CHARS &&
      out.length > 0 &&
      !out.endsWith('\n')
    ) {
      if (/^\s+$/.test(cur)) {
        // Current segment is whitespace — swap it for a newline.
        out += '\n';
        lineLen = 0;
        continue;
      }
      // Force break before non-whitespace segment.
      out += '\n';
      lineLen = 0;
    }
    out += cur;
    lineLen += cur.length;
  }
  return out;
}

export function shapeThai(input: string | null | undefined): string {
  if (input === null || input === undefined) return '';
  if (input.length === 0) return '';
  // 1. NFC so any upstream NFD variant collapses to canonical ำ.
  const nfc = input.normalize('NFC');
  // 2. Inject Thai word-boundary break points (ZWSP) so long strings
  //    wrap properly instead of overflowing the container.
  const broken = injectThaiBreakPoints(nfc);
  // 3. Decompose sara-am so advance-width counts match rendered glyph
  //    count (prevents end-of-string clipping).
  const decomposed = broken.replace(SARA_AM, NIKHAHIT_AA);
  // 4. Append a trailing ZWSP sentinel when the tail is Thai — stops
  //    fontkit from clipping the final cluster when it sits exactly
  //    at the container edge.
  const lastChar = decomposed.charCodeAt(decomposed.length - 1);
  const isThaiTail = lastChar >= 0x0e00 && lastChar <= 0x0e7f;
  return isThaiTail ? decomposed + ZWSP : decomposed;
}

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

  // CRITICAL — prevent per-character word splitting that breaks Thai
  // shaping. Returning `[word]` tells the layout engine to treat each
  // whitespace-delimited token as one indivisible unit.
  Font.registerHyphenationCallback((word: string) => [word]);
}

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

export function shapeThai(input: string | null | undefined): string {
  if (input === null || input === undefined) return '';
  if (input.length === 0) return '';
  // Work on NFC first so any upstream NFD variant collapses to the
  // canonical ำ before we decompose it explicitly below.
  const nfc = input.normalize('NFC');
  // Decompose sara-am so advance-width counts match rendered glyph count.
  const decomposed = nfc.replace(SARA_AM, NIKHAHIT_AA);
  // Only append the sentinel when the tail is a Thai character —
  // otherwise we'd add invisible characters to pure-ASCII strings.
  const lastChar = decomposed.charCodeAt(decomposed.length - 1);
  const isThaiTail = lastChar >= 0x0e00 && lastChar <= 0x0e7f;
  return isThaiTail ? decomposed + ZWSP : decomposed;
}

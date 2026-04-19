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
 * Normalise a potentially-mixed-form Thai string to NFC so the PDF
 * engine sees a single codepoint for sara-am (ำ U+0E33) instead of
 * the decomposed pair (ํ U+0E4D + า U+0E32). Idempotent + safe on
 * pure-ASCII + mixed TH/EN strings.
 */
export function shapeThai(input: string | null | undefined): string {
  if (input === null || input === undefined) return '';
  return input.normalize('NFC');
}

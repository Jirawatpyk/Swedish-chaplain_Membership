/**
 * 093-wht-note-pdf-wrap — shapeThai parameterized wrap threshold (unit).
 *
 * Root cause of the premature-wrap bug: `shapeThai` hard-coded a single
 * WRAP_THRESHOLD_CHARS = 55 char budget calibrated for the NARROWEST Thai
 * container (the half-width seller header block). Applied to the FULL-WIDTH
 * `whtNoteBlock` (width 100%, fontSize 8, content width 523.28pt), the ~68-char
 * accountant WHT note is force-wrapped onto two lines even though it renders at
 * only 224.79pt (43% of the block — measured with fontkit 2.0.4 against
 * Sarabun-Regular, the same engine @react-pdf/renderer lays glyphs with).
 *
 * Fix: parameterize the threshold. The default (55) is preserved for EVERY
 * existing call site (seller/buyer/description/amount-in-words). Only the
 * full-width WHT note passes the wider WHT_NOTE_WRAP_THRESHOLD_CHARS (72), which
 * keeps the 68-char note on one line with headroom while still wrapping a
 * genuinely-too-long (>72-char) note. 72 sits safely below the measured
 * worst-case single-line capacity of 78 chars (widest Thai consonant ฒ =
 * 6.648pt @8pt → 523.28 / 6.648 ≈ 78), so no wrapped line can ever overflow.
 */
import { describe, it, expect } from 'vitest';
import { shapeThai } from '@/modules/invoicing/infrastructure/pdf/fonts/register-sarabun';
import { WHT_NOTE_WRAP_THRESHOLD_CHARS } from '@/modules/invoicing/infrastructure/pdf/templates/invoice-template';

// The real TSCC accountant WHT note — MUST match wht-note-scope.integration.test.ts.
const WHT_NOTE_TH =
  'หอการค้าไทย-สวีเดนได้รับการยกเว้นภาษีเงินได้ไม่ต้องหักภาษี ณ ที่จ่าย';

describe('shapeThai — parameterized wrap threshold (093 WHT-note fix)', () => {
  it('the WHT threshold is a safe value: real note fits, below the 78-char overflow cap', () => {
    expect(WHT_NOTE_WRAP_THRESHOLD_CHARS).toBe(72);
    // ≤ 78 → even an all-widest-consonant line at this length never overflows 523.28pt.
    expect(WHT_NOTE_WRAP_THRESHOLD_CHARS).toBeLessThanOrEqual(78);
  });

  it('the real accountant note sits in the fix window: >55 (default wraps), ≤72 (WHT keeps one line)', () => {
    const len = WHT_NOTE_TH.normalize('NFC').length;
    expect(len).toBeGreaterThan(55);
    expect(len).toBeLessThanOrEqual(WHT_NOTE_WRAP_THRESHOLD_CHARS);
  });

  it('DEFAULT threshold (55) force-wraps the note — the premature-wrap bug (regression tripwire)', () => {
    // Proves the narrow-container calibration still wraps this note, so the
    // seller/buyer/description call sites keep their EXISTING behavior unchanged.
    expect(shapeThai(WHT_NOTE_TH)).toContain('\n');
    expect(shapeThai(WHT_NOTE_TH, 55)).toContain('\n');
  });

  it('WHT threshold (72) keeps the real 68-char note on ONE line (no \\n injected)', () => {
    expect(shapeThai(WHT_NOTE_TH, WHT_NOTE_WRAP_THRESHOLD_CHARS)).not.toContain('\n');
  });

  it('a genuinely-too-long (>72-char) note STILL wraps at the WHT threshold', () => {
    const longNote = WHT_NOTE_TH + 'เพิ่มเติมอีกหลายคำเพื่อให้ยาวเกินเกณฑ์ที่กำหนด';
    expect(longNote.normalize('NFC').length).toBeGreaterThan(WHT_NOTE_WRAP_THRESHOLD_CHARS);
    expect(shapeThai(longNote, WHT_NOTE_WRAP_THRESHOLD_CHARS)).toContain('\n');
  });

  it('the maxCharsPerLine default is 55 — non-WHT call sites are byte-identical to the pre-fix behavior', () => {
    expect(shapeThai(WHT_NOTE_TH)).toBe(shapeThai(WHT_NOTE_TH, 55));
  });

  it('preserves NFC + sara-am decompose + trailing-ZWSP regardless of threshold', () => {
    const withSaraAm = 'จำนวนเงินรวมทั้งสิ้นตามรายการข้างต้นนี้'; // contains ำ, Thai tail
    const out = shapeThai(withSaraAm, WHT_NOTE_WRAP_THRESHOLD_CHARS);
    expect(out).not.toContain('ำ'); // sara-am (U+0E33) decomposed to ◌ํ + า
    expect(out.endsWith('​')).toBe(true); // Thai tail → trailing ZWSP sentinel
  });
});

/**
 * Unit tests for buildFormats() — the central next-intl dateTime preset builder.
 *
 * Covers:
 *  1. Preset shape: `th` includes `calendar: 'buddhist'` on every preset;
 *     `en` / `sv` do NOT.
 *  2. End-to-end Intl rendering: a known Gregorian date produces a BE year
 *     (CE + 543) for `th` presets, and the unmodified CE year for `en` / `sv`.
 *     This proves the config is actually wired correctly at the ICU level, not
 *     just structurally present.
 */

import { describe, expect, it } from 'vitest';
import { buildFormats } from '@/i18n/formats';

// 2026-05-29 CE → 2569 BE
const REFERENCE_DATE = new Date('2026-05-29T00:00:00Z');
const CE_YEAR = '2026';
const BE_YEAR = '2569';

const ALL_PRESET_KEYS = [
  'dateMedium',
  'dateMedium2Digit',
  'dateLong',
  'dateTimeMedium',
  'medium',
  'mediumWithTime',
] as const;

describe('buildFormats', () => {
  describe('th locale — all presets carry calendar: buddhist', () => {
    const formats = buildFormats('th');

    it.each(ALL_PRESET_KEYS)('preset %s includes calendar: buddhist', (preset) => {
      expect(formats.dateTime[preset]).toBeDefined();
      expect(formats.dateTime[preset]).toHaveProperty('calendar', 'buddhist');
    });
  });

  describe('en locale — no calendar override on any preset', () => {
    const formats = buildFormats('en');

    it.each(ALL_PRESET_KEYS)('preset %s does NOT include calendar', (preset) => {
      expect(formats.dateTime[preset]).toBeDefined();
      expect(formats.dateTime[preset]).not.toHaveProperty('calendar');
    });
  });

  describe('sv locale — no calendar override on any preset', () => {
    const formats = buildFormats('sv');

    it.each(ALL_PRESET_KEYS)('preset %s does NOT include calendar', (preset) => {
      expect(formats.dateTime[preset]).toBeDefined();
      expect(formats.dateTime[preset]).not.toHaveProperty('calendar');
    });
  });

  describe('end-to-end ICU rendering', () => {
    it('th dateMedium renders BE year (2026 CE → 2569)', () => {
      const opts = buildFormats('th').dateTime['dateMedium']!;
      const rendered = new Intl.DateTimeFormat('th', opts).format(REFERENCE_DATE);
      expect(rendered).toContain(BE_YEAR);
      expect(rendered).not.toContain(CE_YEAR);
    });

    it('en dateMedium renders CE year (2026)', () => {
      const opts = buildFormats('en').dateTime['dateMedium']!;
      const rendered = new Intl.DateTimeFormat('en', opts).format(REFERENCE_DATE);
      expect(rendered).toContain(CE_YEAR);
      expect(rendered).not.toContain(BE_YEAR);
    });

    it('sv dateMedium renders CE year (2026)', () => {
      const opts = buildFormats('sv').dateTime['dateMedium']!;
      const rendered = new Intl.DateTimeFormat('sv', opts).format(REFERENCE_DATE);
      expect(rendered).toContain(CE_YEAR);
      expect(rendered).not.toContain(BE_YEAR);
    });

    it('th dateLong renders BE year', () => {
      const opts = buildFormats('th').dateTime['dateLong']!;
      const rendered = new Intl.DateTimeFormat('th', opts).format(REFERENCE_DATE);
      expect(rendered).toContain(BE_YEAR);
    });

    it('th dateTimeMedium renders BE year', () => {
      const opts = buildFormats('th').dateTime['dateTimeMedium']!;
      const rendered = new Intl.DateTimeFormat('th', opts).format(REFERENCE_DATE);
      expect(rendered).toContain(BE_YEAR);
    });

    it('th medium (dateStyle) renders BE year', () => {
      const opts = buildFormats('th').dateTime['medium']!;
      const rendered = new Intl.DateTimeFormat('th', opts).format(REFERENCE_DATE);
      expect(rendered).toContain(BE_YEAR);
    });

    it('th mediumWithTime renders BE year', () => {
      const opts = buildFormats('th').dateTime['mediumWithTime']!;
      const rendered = new Intl.DateTimeFormat('th', opts).format(REFERENCE_DATE);
      expect(rendered).toContain(BE_YEAR);
    });
  });
});

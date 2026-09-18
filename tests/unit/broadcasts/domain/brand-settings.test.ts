/**
 * F119 T018 — `BrandSettings` value objects (`domain/brand/brand-settings.ts`).
 *
 * FR-041b/c: exactly one primary colour (`#RRGGBB`, contrast-checked
 * elsewhere) and a postal address of ≤ 300 characters with line breaks
 * allowed. The logo URL is read-only and never parsed here.
 */
import { describe, expect, it } from 'vitest';
import {
  BRAND_POSTAL_ADDRESS_MAX,
  DEFAULT_BRAND_PRIMARY_COLOR,
  parseBrandPostalAddress,
  parseBrandPrimaryColor,
} from '@/modules/broadcasts/domain/brand/brand-settings';

describe('parseBrandPrimaryColor', () => {
  it('accepts #RRGGBB and normalises to lower case', () => {
    const r = parseBrandPrimaryColor('#10487A');
    expect(r).toEqual({ ok: true, value: '#10487a' });
  });

  it('refuses a 3-digit hex, a missing hash and rgb() (the CHECK is ^#[0-9a-fA-F]{6}$)', () => {
    for (const bad of ['#fff', '10487a', 'rgb(16,72,122)', '#10487ag', '']) {
      const r = parseBrandPrimaryColor(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid_color_format');
    }
  });

  it('null clears the colour (the platform default applies at render)', () => {
    expect(parseBrandPrimaryColor(null)).toEqual({ ok: true, value: null });
    expect(DEFAULT_BRAND_PRIMARY_COLOR).toBe('#10487a');
  });
});

describe('parseBrandPostalAddress (FR-041c — ≤ 300 chars, line breaks allowed)', () => {
  it('a 301-character address is refused', () => {
    const r = parseBrandPostalAddress('x'.repeat(301));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ code: 'address_too_long', max: 300 });
    expect(BRAND_POSTAL_ADDRESS_MAX).toBe(300);
  });

  it('a 300-character address with line breaks is accepted, breaks preserved', () => {
    const line = 'Thai-Swedish Chamber of Commerce\n';
    const text = (line.repeat(20) + 'x'.repeat(300)).slice(0, 300);
    expect(text.length).toBe(300);
    expect(text).toContain('\n');
    const r = parseBrandPostalAddress(text);
    expect(r).toEqual({ ok: true, value: text });
  });

  it('trims surrounding whitespace and treats an all-whitespace address as cleared (null)', () => {
    expect(parseBrandPostalAddress('  \n  ')).toEqual({ ok: true, value: null });
    expect(parseBrandPostalAddress('  Bangkok 10110  ')).toEqual({ ok: true, value: 'Bangkok 10110' });
    expect(parseBrandPostalAddress(null)).toEqual({ ok: true, value: null });
  });

  it('normalises CRLF to LF so the stored length matches what the user sees', () => {
    const r = parseBrandPostalAddress('Line 1\r\nLine 2');
    expect(r).toEqual({ ok: true, value: 'Line 1\nLine 2' });
  });
});

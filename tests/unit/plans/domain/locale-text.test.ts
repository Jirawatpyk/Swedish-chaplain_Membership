import { describe, expect, it } from 'vitest';
import {
  asLocaleText,
  EmptyEnLocaleTextError,
  hasMissingTranslations,
  LOCALE_KEYS,
  pickLocaleText,
  type LocaleText,
} from '@/modules/plans/domain/locale-text';

describe('LocaleText', () => {
  it('LOCALE_KEYS are exactly en/th/sv', () => {
    expect([...LOCALE_KEYS]).toEqual(['en', 'th', 'sv']);
  });

  describe('hasMissingTranslations', () => {
    it('returns empty when all three locales are present', () => {
      const text: LocaleText = { en: 'Premium', th: 'พรีเมียม', sv: 'Premium' };
      expect(hasMissingTranslations(text)).toEqual([]);
    });

    it('flags missing th', () => {
      const text: LocaleText = { en: 'Premium', sv: 'Premium' };
      expect(hasMissingTranslations(text)).toEqual(['th']);
    });

    it('flags missing sv', () => {
      const text: LocaleText = { en: 'Premium', th: 'พรีเมียม' };
      expect(hasMissingTranslations(text)).toEqual(['sv']);
    });

    it('flags both missing', () => {
      const text: LocaleText = { en: 'Premium' };
      expect(hasMissingTranslations(text)).toEqual(['th', 'sv']);
    });

    it('treats empty / whitespace-only translations as missing', () => {
      const text: LocaleText = { en: 'Premium', th: '', sv: '   ' };
      expect(hasMissingTranslations(text)).toEqual(['th', 'sv']);
    });
  });

  describe('pickLocaleText', () => {
    const text: LocaleText = { en: 'Premium', th: 'พรีเมียม' };

    it('returns en directly when active locale is en', () => {
      expect(pickLocaleText(text, 'en')).toEqual({ value: 'Premium', missing: false });
    });

    it('returns th when present', () => {
      expect(pickLocaleText(text, 'th')).toEqual({
        value: 'พรีเมียม',
        missing: false,
      });
    });

    it('falls back to en when requested locale missing', () => {
      expect(pickLocaleText(text, 'sv')).toEqual({ value: 'Premium', missing: true });
    });

    it('falls back when locale value is empty string', () => {
      const t: LocaleText = { en: 'Premium', th: '' };
      expect(pickLocaleText(t, 'th')).toEqual({ value: 'Premium', missing: true });
    });
  });

  // 016 T072 coverage closure — the R6 I9/D4 smart constructor had no test.
  describe('asLocaleText', () => {
    it('accepts an en-only record and omits absent optional locales', () => {
      const out = asLocaleText({ en: 'Premium' });
      expect(out).toEqual({ en: 'Premium' });
      expect('th' in out).toBe(false);
      expect('sv' in out).toBe(false);
    });

    it('preserves th and sv when supplied', () => {
      expect(asLocaleText({ en: 'Premium', th: 'พรีเมียม', sv: 'Premium' })).toEqual({
        en: 'Premium',
        th: 'พรีเมียม',
        sv: 'Premium',
      });
    });

    it('throws EmptyEnLocaleTextError on an empty or whitespace-only en', () => {
      expect(() => asLocaleText({ en: '' })).toThrow(EmptyEnLocaleTextError);
      expect(() => asLocaleText({ en: '   ' })).toThrow(EmptyEnLocaleTextError);
      // The invariant this constructor exists for: fixture/seed code that
      // bypasses zod must not be able to persist an empty primary locale.
      expect(() => asLocaleText({ en: '', th: 'มีค่า' })).toThrow(
        'asLocaleText: `en` is required',
      );
    });
  });
});

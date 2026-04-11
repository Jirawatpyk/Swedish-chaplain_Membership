import { describe, expect, it } from 'vitest';
import {
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
});

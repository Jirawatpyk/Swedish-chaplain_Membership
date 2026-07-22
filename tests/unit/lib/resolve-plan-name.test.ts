/**
 * `resolvePlanName` locale fallback unit tests.
 *
 * Pins the branch matrix the portal renewal page + admin invoice-create
 * + member-form surfaces rely on to render a plan name in TH/SV with EN
 * canonical fallback. Promoted from the portal route `_lib/` to `src/lib/`
 * (plan-change UX remediation P1-8) alongside the resolver itself — all
 * 14 cases moved verbatim.
 */
import { describe, expect, it } from 'vitest';
import { resolvePlanName } from '@/lib/resolve-plan-name';

describe('resolvePlanName (Phase 6 round-3 I1)', () => {
  it('returns en when locale=en and rawName has en', () => {
    expect(
      resolvePlanName({ en: 'Premium Corporate' }, 'premium', 'en'),
    ).toBe('Premium Corporate');
  });

  it('returns th when locale=th and rawName has th', () => {
    expect(
      resolvePlanName(
        { en: 'Premium Corporate', th: 'พรีเมียม คอร์ปอเรท' },
        'premium',
        'th',
      ),
    ).toBe('พรีเมียม คอร์ปอเรท');
  });

  it('returns sv when locale=sv and rawName has sv', () => {
    expect(
      resolvePlanName({ en: 'Premium', sv: 'Premium Företag' }, 'premium', 'sv'),
    ).toBe('Premium Företag');
  });

  it('falls back to en when locale=th but th is missing', () => {
    expect(
      resolvePlanName({ en: 'Premium' }, 'premium', 'th'),
    ).toBe('Premium');
  });

  it('falls back to en when locale=sv but sv is missing', () => {
    expect(
      resolvePlanName({ en: 'Premium' }, 'premium', 'sv'),
    ).toBe('Premium');
  });

  it('falls back to en when locale=th and th is empty string', () => {
    expect(
      resolvePlanName({ en: 'Premium', th: '' }, 'premium', 'th'),
    ).toBe('Premium');
  });

  it('falls back to en when locale=sv and sv is empty string', () => {
    expect(
      resolvePlanName({ en: 'Premium', sv: '' }, 'premium', 'sv'),
    ).toBe('Premium');
  });

  it('returns fallback when rawName is null', () => {
    expect(resolvePlanName(null, 'premium-slug', 'en')).toBe('premium-slug');
  });

  it('returns fallback when rawName is undefined', () => {
    expect(resolvePlanName(undefined, 'premium-slug', 'en')).toBe(
      'premium-slug',
    );
  });

  it('coerces non-object rawName via String()', () => {
    expect(resolvePlanName(42, 'fallback', 'en')).toBe('42');
  });

  it('returns fallback when rawName is object missing en', () => {
    // Defensive — page should never pass JSONB without en, but a
    // malformed F2 row could.
    expect(
      resolvePlanName({ th: 'orphan th' } as unknown, 'plan-slug', 'en'),
    ).toBe('plan-slug');
  });

  it('returns en even when locale is unrecognised (e.g. de)', () => {
    expect(
      resolvePlanName({ en: 'Premium' }, 'premium', 'de'),
    ).toBe('Premium');
  });

  // R2-S8: covers the previously-untested empty-string EN fallback —
  // `localeText.en` can be present-but-empty (defensive — F2 plan
  // names always have non-empty `en` per FR-008, but a malformed
  // import or future schema relaxation could produce this state).
  // The `||` chain falls through to `fallback` when `en` is empty.
  it('returns fallback when locale is en but localeText.en is empty string', () => {
    expect(resolvePlanName({ en: '' }, 'premium-slug', 'en')).toBe(
      'premium-slug',
    );
  });

  it('returns fallback when th locale + th empty + en empty', () => {
    expect(
      resolvePlanName({ en: '', th: '' }, 'premium-slug', 'th'),
    ).toBe('premium-slug');
  });
});

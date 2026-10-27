/**
 * Task #12 (PR B) — the category names a tier E-Blast's history row shows,
 * shared by the member panel and its preview fixture. Since PR D only the two
 * `plan_category` values can be submitted, but rows from before it may hold
 * typed text: only the categories are looked up; anything else, an
 * Object.prototype name included, shows as itself.
 */
import { describe, expect, it } from 'vitest';
import { tierNames } from '@/components/broadcast/tier-audience';

const label = (code: 'corporate' | 'partnership'): string =>
  code === 'corporate' ? 'Corporate' : 'Partnership';

describe('tierNames', () => {
  it('names the categories, joined for the locale', () => {
    expect(tierNames(['corporate', 'partnership'], 'en', label)).toBe('Corporate and Partnership');
    expect(tierNames(['corporate', 'partnership'], 'sv', label)).toBe('Corporate och Partnership');
  });

  it.each(['constructor', 'toString', '__proto__', 'gold', 'Corporate'])(
    'shows %s as typed: it is not a category',
    (code) => {
      expect(tierNames([code], 'en', label)).toBe(code);
    },
  );

  it('names a repeated category once', () => {
    expect(tierNames(['corporate', 'corporate'], 'en', label)).toBe('Corporate');
  });
});

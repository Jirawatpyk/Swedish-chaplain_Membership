import { describe, it, expect } from 'vitest';
import { LOCALE_COOKIE_NAME } from '@/i18n/config';

describe('LOCALE_COOKIE_NAME', () => {
  it('is the next-intl locale cookie name read by request.ts', () => {
    expect(LOCALE_COOKIE_NAME).toBe('NEXT_LOCALE');
  });
});

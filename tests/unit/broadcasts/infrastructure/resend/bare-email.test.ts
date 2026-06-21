import { describe, expect, it } from 'vitest';
import { extractBareEmail } from '@/modules/broadcasts/infrastructure/resend/bare-email';

describe('extractBareEmail', () => {
  it('extracts the address from a "Name <email>" string', () => {
    expect(extractBareEmail('SweCham <noreply@zyncdata.app>')).toBe('noreply@zyncdata.app');
  });
  it('passes a bare address through', () => {
    expect(extractBareEmail('noreply@zyncdata.app')).toBe('noreply@zyncdata.app');
  });
  it('trims surrounding whitespace', () => {
    expect(extractBareEmail('  Chamber <broadcasts@swecham.com>  ')).toBe('broadcasts@swecham.com');
  });
});

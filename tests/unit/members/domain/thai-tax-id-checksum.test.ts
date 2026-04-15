import { describe, expect, it } from 'vitest';
import { validateThaiTaxIdChecksum } from '@/modules/members/domain/policies/thai-tax-id-checksum';

describe('Thai tax-id checksum policy', () => {
  it('accepts known-good ID', () => {
    expect(validateThaiTaxIdChecksum('1234567890121')).toBe(true);
  });

  it('rejects last-digit tamper', () => {
    expect(validateThaiTaxIdChecksum('1234567890122')).toBe(false);
  });

  it('rejects non-13-digit', () => {
    expect(validateThaiTaxIdChecksum('12345')).toBe(false);
  });

  it('rejects non-numeric', () => {
    expect(validateThaiTaxIdChecksum('12345A7890121')).toBe(false);
  });

  it('rejects 14-digit string', () => {
    expect(validateThaiTaxIdChecksum('12345678901210')).toBe(false);
  });
});

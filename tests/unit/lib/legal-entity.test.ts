/**
 * 088 US3 review fix (2026-07-02) — the shared VAT-registrant discriminator.
 * Regression guard for the adapter fail-OPEN: a natural person entered with a
 * non-canonical 'individual' (casing / whitespace) MUST still be fail-closed so
 * no §86/4 Head-Office / Branch line prints on their tax receipt (AS3).
 */
import { describe, expect, it } from 'vitest';
import { isVatRegistrantEntityType } from '@/lib/legal-entity';

describe('isVatRegistrantEntityType — §86/4 branch-line discriminator (FR-008/AS3)', () => {
  it('is fail-closed for null / undefined / empty', () => {
    expect(isVatRegistrantEntityType(null)).toBe(false);
    expect(isVatRegistrantEntityType(undefined)).toBe(false);
    expect(isVatRegistrantEntityType('')).toBe(false);
    expect(isVatRegistrantEntityType('   ')).toBe(false);
  });

  it('is fail-closed for individual in ANY casing / whitespace (the review defect)', () => {
    expect(isVatRegistrantEntityType('individual')).toBe(false);
    expect(isVatRegistrantEntityType('Individual')).toBe(false);
    expect(isVatRegistrantEntityType('INDIVIDUAL')).toBe(false);
    expect(isVatRegistrantEntityType('  individual  ')).toBe(false);
  });

  it('is true for a juristic entity type', () => {
    expect(isVatRegistrantEntityType('company')).toBe(true);
    expect(isVatRegistrantEntityType('Company')).toBe(true);
    expect(isVatRegistrantEntityType('both')).toBe(true);
    expect(isVatRegistrantEntityType('partnership')).toBe(true);
  });
});

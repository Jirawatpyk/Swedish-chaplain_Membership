import { describe, expect, it } from 'vitest';
import { resolveBenefitsTab, BENEFITS_TAB } from '@/app/(member)/portal/benefits/_helpers/tabs';

describe('resolveBenefitsTab (058 G1)', () => {
  it('defaults to benefits when param is absent', () => {
    expect(resolveBenefitsTab(undefined)).toBe(BENEFITS_TAB.benefits);
  });

  it('returns broadcasts when param is "broadcasts"', () => {
    expect(resolveBenefitsTab('broadcasts')).toBe(BENEFITS_TAB.broadcasts);
  });

  it('returns benefits when param is "benefits"', () => {
    expect(resolveBenefitsTab('benefits')).toBe(BENEFITS_TAB.benefits);
  });

  it('clamps an unknown value to the default benefits tab', () => {
    expect(resolveBenefitsTab('garbage')).toBe(BENEFITS_TAB.benefits);
  });
});

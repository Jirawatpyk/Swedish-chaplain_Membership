/**
 * Stage-3 importer — tier-resolution unit tests (spec § 4 + § 8).
 * Uses the real 2026 SweCham seeded plans (scripts/seed-swecham-2026-plans.ts).
 */
import { describe, expect, it } from 'vitest';

const { buildTierResolver } = await import(
  '@/../scripts/import-members/tier-resolution'
);

// Mirrors the 9 seeded SweCham 2026 plans (plan_id, plan_name.en, scope).
const PLANS = [
  { planId: 'premium', nameEn: 'Premium Corporate', memberTypeScope: 'company' },
  { planId: 'large', nameEn: 'Large Corporate', memberTypeScope: 'company' },
  { planId: 'regular', nameEn: 'Regular Corporate', memberTypeScope: 'company' },
  { planId: 'start-up', nameEn: 'Start-up', memberTypeScope: 'company' },
  { planId: 'individual', nameEn: 'Individual', memberTypeScope: 'individual' },
  { planId: 'thai-alumni', nameEn: 'Thai Alumni/Student', memberTypeScope: 'individual' },
  { planId: 'diamond', nameEn: 'Diamond Partnership', memberTypeScope: 'company' },
  { planId: 'platinum', nameEn: 'Platinum Partnership', memberTypeScope: 'company' },
  { planId: 'gold', nameEn: 'Gold Partnership', memberTypeScope: 'company' },
] as const;

describe('buildTierResolver — tier → plan_id (spec § 4)', () => {
  const r = buildTierResolver(PLANS);

  it('resolves by short Excel label (plan_id slug)', () => {
    const premium = r.resolve('Premium');
    expect(premium.ok).toBe(true);
    if (premium.ok) {
      expect(premium.value.planId).toBe('premium');
      expect(premium.value.memberTypeScope).toBe('company');
    }
    expect(r.resolve('Gold').ok && r.resolve('Gold')).toMatchObject({ value: { planId: 'gold' } });
  });

  it('resolves by full plan name', () => {
    expect(r.resolve('Premium Corporate')).toMatchObject({ ok: true, value: { planId: 'premium' } });
    expect(r.resolve('Gold Partnership')).toMatchObject({ ok: true, value: { planId: 'gold' } });
  });

  it('normalizes case / whitespace / punctuation ("Start-up" ≡ "startup" ≡ "start up")', () => {
    for (const label of ['Start-up', 'startup', 'START UP', '  start-up ']) {
      const res = r.resolve(label);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.planId).toBe('start-up');
    }
  });

  it('carries individual scope for person tiers (drives the tax_id rule)', () => {
    const ind = r.resolve('Individual');
    const alumni = r.resolve('Thai Alumni');
    expect(ind.ok && ind.value.memberTypeScope).toBe('individual');
    expect(alumni.ok && alumni.value.memberTypeScope).toBe('individual');
  });

  it('fails loud on an unmapped tier (no silent default), with the known list', () => {
    const res = r.resolve('Bronze');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('tier.unmapped');
      expect(res.error.raw).toBe('Bronze');
      expect(res.error.known).toContain('premium');
      expect(res.error.known).toHaveLength(9);
    }
  });

  it('throws at build time on ambiguous seeded aliases (seed integrity guard)', () => {
    expect(() =>
      buildTierResolver([
        { planId: 'a', nameEn: 'Gold', memberTypeScope: 'company' },
        { planId: 'b', nameEn: 'Gold', memberTypeScope: 'company' },
      ]),
    ).toThrow(/ambiguous/);
  });
});

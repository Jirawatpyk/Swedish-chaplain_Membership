/**
 * Spec 122 follow-up PR E (27 Oct 2026) — one name per membership category.
 *
 * The admin plans pages called the categories องค์กร / พาร์ทเนอร์ชิป on the
 * badges and filters, and นิติบุคคล / พันธมิตร in the create form (นิติบุคคล
 * is the legal entity type on the members pages). The maintainer chose
 * องค์กร / พันธมิตร, as renewals, benefits and E-Blast already say. Every
 * place that names a `plan_category` must say the same word.
 */
import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import sv from '@/i18n/messages/sv.json';

const LOCALES = { en, th, sv } as const;

describe.each(Object.entries(LOCALES))('%s: a membership category has one name', (_locale, m) => {
  it.each(['corporate', 'partnership'] as const)('%s', (category) => {
    const names = new Set([
      m.admin.plans.badges[category],
      m.admin.plans.filters.category[category],
      m.admin.plans.create.options.planCategory[category],
      m.portal.broadcasts.list.tierCode[category],
      ...(category === 'partnership' ? [m.admin.renewals.tierBadge.partnership] : []),
    ]);
    expect([...names]).toHaveLength(1);
  });
});

describe('th', () => {
  it('says พันธมิตร, never พาร์ทเนอร์ชิป, and does not call a category นิติบุคคล', () => {
    const json = JSON.stringify(th);
    expect(json).not.toContain('พาร์ทเนอร์ชิป');
    expect(th.admin.plans.create.options.planCategory.corporate).not.toBe('นิติบุคคล');
  });
});

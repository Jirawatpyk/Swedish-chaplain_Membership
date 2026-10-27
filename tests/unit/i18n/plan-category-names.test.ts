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
      ...(category === 'partnership'
        ? [
            m.admin.renewals.tierBadge.partnership,
            m.admin.renewals.settings.schedules.tabs.partnership,
            m.admin.renewals.tasks.tierBucket.partnership,
          ]
        : []),
    ]);
    expect([...names]).toHaveLength(1);
  });
});

describe('th', () => {
  it('says พันธมิตร, never พาร์ทเนอร์ชิป or พาร์ตเนอร์ชิป (events included)', () => {
    const strings = (v: unknown): string[] =>
      typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [];
    expect(strings(th).filter((s) => /พาร์[ทต]เนอร์/.test(s))).toEqual([]);
  });

  it('names the categories in Thai where the copy mentions them', () => {
    expect(th.admin.members.bundleChangeWarning.description).not.toMatch(/corporate|partnership/i);
    expect(th.admin.events.detail.toggles.confirmFlagCulturalBody).not.toContain('Corporate');
  });
});

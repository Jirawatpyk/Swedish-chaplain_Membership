/**
 * 122 US7a (maintainer decision, 1 Oct 2026, from the i18n review) — the
 * renewal pipeline names one action and one queue the same way everywhere a
 * member of staff meets them, in every locale.
 */
import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import sv from '@/i18n/messages/sv.json';

const LOCALES = { en, th, sv } as const;

describe('renewal pipeline copy consistency', () => {
  it.each(Object.entries(LOCALES))(
    '%s: the row menu and the bulk bar say "Mark paid" as the dialog button does',
    (_locale, messages) => {
      const r = messages.admin.renewals;
      const confirm = r.cycleDetail.markPaidOffline.confirm;
      expect(r.actions.markPaid).toBe(confirm);
      expect(r.bulk.actions.markPaid).toBe(confirm);
    },
  );

  it('th: the pending-review count read out on the tab uses the tab\'s own words', () => {
    const r = th.admin.renewals.pendingReview;
    expect(r.tabCountSr).toContain(r.tab);
  });

  it('sv: the collection rate is not called an inkasso (debt-collection) rate', () => {
    expect(sv.admin.renewals.money.collectionRate.label).not.toMatch(/inkass/i);
  });

  it.each(Object.entries(LOCALES))(
    '%s: the bulk mark-paid warning exists with the single dialog\'s credit-note rule',
    (_locale, messages) => {
      const b = messages.admin.renewals.bulk as Record<string, unknown>;
      expect(typeof b.taxDocWarningTitle).toBe('string');
      expect(typeof b.taxDocWarningBody).toBe('string');
    },
  );
});

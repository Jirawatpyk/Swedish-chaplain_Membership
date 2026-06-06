import { describe, it, expect } from 'vitest';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import sv from '@/i18n/messages/sv.json';

/**
 * Locks the portal.dashboard i18n surface for the G2 primitives across
 * all three locales. Missing keys would surface as raw key paths in the
 * UI (EN) or fail `pnpm check:i18n` on release branches (TH/SV).
 */
const REQUIRED = [
  'quotaBar.readout',
  'quotaBar.ariaLabel',
  'activity.title',
  'activity.empty.title',
  'activity.empty.body',
  'activity.viewAll',
  'quickActions.title',
] as const;

function get(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, k) =>
        acc && typeof acc === 'object'
          ? (acc as Record<string, unknown>)[k]
          : undefined,
      obj,
    );
}

describe('portal.dashboard i18n keys', () => {
  for (const [name, msgs] of [
    ['en', en],
    ['th', th],
    ['sv', sv],
  ] as const) {
    for (const key of REQUIRED) {
      it(`${name}: portal.dashboard.${key} is a non-empty string`, () => {
        const v = get(
          (msgs as Record<string, unknown>).portal,
          `dashboard.${key}`,
        );
        expect(typeof v).toBe('string');
        expect((v as string).length).toBeGreaterThan(0);
      });
    }
  }
});

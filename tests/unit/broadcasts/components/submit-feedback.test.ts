/**
 * 108 PR-C T077 (FR-022a, US3 AS9) — the sender is told HOW MANY entries were
 * excluded by recipient preference, never which. The count arrives on the
 * submit response as `recipientPreferenceExcluded`; both compose forms
 * (member + admin proxy) build their success-toast description through
 * `submitSuccessDescription`, which is pure and testable in jsdom (the forms
 * themselves cannot be driven to a submit without a live Tiptap editor —
 * see proxy-compose-missing-email.test.tsx; the e2e in T084 covers the
 * rendered toast).
 *
 * Also pins the i18n keys statically (mirrors the admin-toast-i18n pattern):
 * the unit mocks of next-intl never throw on a missing key and
 * `check:i18n` is parity-only, so a typo'd key would render its own path.
 */
import { describe, expect, it, vi } from 'vitest';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import sv from '@/i18n/messages/sv.json';
import { submitSuccessDescription } from '@/components/broadcast/submit-feedback';

type Messages = Record<string, unknown>;
function pick(messages: Messages, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => (acc as Messages | undefined)?.[k], messages);
}

describe('submit feedback i18n keys (108 PR-C T077)', () => {
  it.each([
    ['portal.broadcasts.compose.toast.preferenceExcluded'],
    ['admin.broadcasts.proxySubmitDialog.preferenceExcluded'],
  ])('%s exists and interpolates {count} in en / th / sv', (path) => {
    for (const [locale, messages] of [['en', en], ['th', th], ['sv', sv]] as const) {
      const value = pick(messages as Messages, path);
      expect(typeof value, `${locale}: ${path}`).toBe('string');
      expect(value as string, `${locale}: ${path} must interpolate {count}`).toMatch(/\{count/);
    }
  });
});

describe('submitSuccessDescription', () => {
  function makeT(): { t: (key: string, values?: Record<string, number>) => string; calls: Array<[string, Record<string, number> | undefined]> } {
    const calls: Array<[string, Record<string, number> | undefined]> = [];
    return {
      calls,
      t: (key, values) => {
        calls.push([key, values]);
        return values ? `${key}:${values.count}` : key;
      },
    };
  }

  it('no exclusions → the SLA hint only (unchanged copy)', () => {
    const { t, calls } = makeT();
    expect(submitSuccessDescription(t, { recipientPreferenceExcluded: 0 })).toBe('toast.submittedSlaHint');
    expect(calls).toEqual([['toast.submittedSlaHint', undefined]]);
  });

  it('a positive count → the preference line with {count} first, then the SLA hint', () => {
    const { t } = makeT();
    expect(submitSuccessDescription(t, { recipientPreferenceExcluded: 2 })).toBe(
      'toast.preferenceExcluded:2 toast.submittedSlaHint',
    );
  });

  it('a missing or non-numeric field (older server, malformed body) → the SLA hint only, never NaN', () => {
    const { t } = makeT();
    expect(submitSuccessDescription(t, {})).toBe('toast.submittedSlaHint');
    expect(submitSuccessDescription(t, { recipientPreferenceExcluded: 'two' })).toBe('toast.submittedSlaHint');
    expect(submitSuccessDescription(t, { recipientPreferenceExcluded: -1 })).toBe('toast.submittedSlaHint');
  });

  it('takes the hint key from the caller so a form can use its own namespace', () => {
    const { t, calls } = makeT();
    submitSuccessDescription(t, { recipientPreferenceExcluded: 3 }, { hintKey: 'successToastHint' });
    expect(calls.map(([k]) => k)).toEqual(['toast.preferenceExcluded', 'successToastHint']);
  });

  it('with no hint (the admin proxy toast has none): undefined at zero, the preference line alone otherwise', () => {
    const { t } = makeT();
    expect(submitSuccessDescription(t, { recipientPreferenceExcluded: 0 }, { hintKey: null })).toBeUndefined();
    expect(submitSuccessDescription(t, {}, { hintKey: null })).toBeUndefined();
    expect(
      submitSuccessDescription(t, { recipientPreferenceExcluded: 3 }, { hintKey: null, countKey: 'preferenceExcluded' }),
    ).toBe('preferenceExcluded:3');
    vi.restoreAllMocks();
  });
});

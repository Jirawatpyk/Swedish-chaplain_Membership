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
import {
  errorValues,
  estimateNoteKey,
  showsSelfExclusionHint,
  submitSuccessDescription,
} from '@/components/broadcast/submit-feedback';

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

/**
 * 108 PR-C T085 (FR-041 / FR-042) — the "audience too large" copy interpolates
 * the ceiling the server refused against (`details.cap` on the 422 body),
 * so the message is true whichever ceiling is in force (5,000 or 50,000).
 */
describe('too-large copy interpolates the ceiling (108 PR-C T085)', () => {
  it.each([
    ['portal.broadcasts.compose.errors.broadcast_audience_too_large'],
    ['admin.broadcasts.proxySubmitDialog.audienceTooLargeError'],
  ])('%s interpolates {ceiling} in en / th / sv and no longer hard-codes 5,000', (path) => {
    for (const [locale, messages] of [['en', en], ['th', th], ['sv', sv]] as const) {
      const value = pick(messages as Messages, path);
      expect(typeof value, `${locale}: ${path}`).toBe('string');
      expect(value as string, `${locale}: ${path}`).toMatch(/\{ceiling/);
      expect(value as string, `${locale}: ${path}`).not.toMatch(/5[,. ]?000/);
    }
  });

  it('errorValues: the too-large code yields { ceiling } from details.cap; anything else yields undefined', () => {
    expect(errorValues('broadcast_audience_too_large', { cap: 50000, count: 50001 })).toEqual({ ceiling: 50000 });
    expect(errorValues('broadcast_audience_too_large', {})).toBeUndefined();
    expect(errorValues('broadcast_audience_too_large', { cap: 'x' })).toBeUndefined();
    expect(errorValues('broadcast_empty_segment_blocked', { cap: 5000 })).toBeUndefined();
    expect(errorValues('broadcast_audience_too_large', undefined)).toBeUndefined();
  });
});

/**
 * 108 PR-C T079 (FR-022b; tasks T079) — the compose copy tells the truth for
 * the leg in force: with the flag ON the recipients are every eligible
 * contact, not "every active member with a primary contact email"; the
 * ceiling is interpolated, never hard-coded; and a member-based segment
 * shows the self-exclusion hint ("you and your colleagues"). The key choice
 * is a pure helper so the wording per (segment, leg) is pinned without
 * mounting the Tiptap form.
 */
describe('compose copy per audience leg (108 PR-C T079)', () => {
  it.each([
    ['portal.broadcasts.compose.estimateNote.allMembers', true],
    ['portal.broadcasts.compose.estimateNote.tier', true],
    ['portal.broadcasts.compose.estimateNote.allMembersAllContacts', true],
    ['portal.broadcasts.compose.estimateNote.tierAllContacts', true],
    ['portal.broadcasts.compose.selfExclusionHint', false],
    ['admin.broadcasts.proxySubmitDialog.selfExclusionNotice', false],
  ])('%s exists in en / th / sv (ceiling interpolated: %s) and never hard-codes 5,000', (path, ceiling) => {
    for (const [locale, messages] of [['en', en], ['th', th], ['sv', sv]] as const) {
      const value = pick(messages as Messages, path);
      expect(typeof value, `${locale}: ${path}`).toBe('string');
      if (ceiling) expect(value as string, `${locale}: ${path}`).toMatch(/\{ceiling/);
      expect(value as string, `${locale}: ${path}`).not.toMatch(/5[,. ]?000/);
    }
  });

  it('estimateNoteKey picks the leg-specific wording for member-based segments and the plain custom/attendee copy otherwise', () => {
    expect(estimateNoteKey('all_members', 'primary_only')).toBe('estimateNote.allMembers');
    expect(estimateNoteKey('all_members', 'all_contacts')).toBe('estimateNote.allMembersAllContacts');
    expect(estimateNoteKey('tier', 'primary_only')).toBe('estimateNote.tier');
    expect(estimateNoteKey('tier', 'all_contacts')).toBe('estimateNote.tierAllContacts');
    expect(estimateNoteKey('custom', 'all_contacts')).toBe('estimateNote.custom');
    expect(estimateNoteKey('event_attendees_last_90d', 'primary_only')).toBe('estimateNote.custom');
  });

  it('showsSelfExclusionHint is true for member-based segments only (the custom list is not self-excluded)', () => {
    expect(showsSelfExclusionHint('all_members')).toBe(true);
    expect(showsSelfExclusionHint('tier')).toBe(true);
    expect(showsSelfExclusionHint('custom')).toBe(false);
    expect(showsSelfExclusionHint('event_attendees_last_90d')).toBe(false);
  });
});

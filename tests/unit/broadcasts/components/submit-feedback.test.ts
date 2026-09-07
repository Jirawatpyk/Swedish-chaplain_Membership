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
  excludedByPreference,
  proxySelfExclusionNoticeKey,
  selfExclusionHintKey,
  showsSelfExclusionHint,
  submitBlockedByCount,
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

// Review 2026-09-07 round 2 (UX H-6) — the preference number no longer rides
// as a 4-second description under the success toast: it is its OWN toast,
// held longer. The forms read the count through this one guard, so a
// malformed body never yields "NaN addresses".
describe('excludedByPreference', () => {
  it('a positive integer passes through; missing, non-numeric, negative and fractional are 0', () => {
    expect(excludedByPreference({ recipientPreferenceExcluded: 2 })).toBe(2);
    expect(excludedByPreference({})).toBe(0);
    expect(excludedByPreference({ recipientPreferenceExcluded: 'two' })).toBe(0);
    expect(excludedByPreference({ recipientPreferenceExcluded: -1 })).toBe(0);
    expect(excludedByPreference({ recipientPreferenceExcluded: 1.5 })).toBe(0);
    vi.restoreAllMocks();
  });
});

// Review 2026-09-07 round 2 (UX H-4, decision (a)) — the count line said
// "the submission would be refused" while the Submit button stayed enabled;
// the user learned the refusal by clicking. The gate is a pure function of
// the count state: a measured refusal (over the ceiling, or nobody left)
// blocks; `unavailable` never does (the server recomputes — FR-040b).
describe('submitBlockedByCount', () => {
  const base = { ceiling: 5000, orphans: 0, droppedByPreference: 0 } as const;
  it('blocks on a measured refusal only', () => {
    expect(submitBlockedByCount({ status: 'ready', count: 5001, exceeds: true, ...base })).toBe(true);
    expect(submitBlockedByCount({ status: 'ready', count: 0, exceeds: false, ...base })).toBe(true);
    expect(submitBlockedByCount({ status: 'ready', count: 12, exceeds: false, ...base })).toBe(false);
  });
  it('never blocks while the number is unknown', () => {
    expect(submitBlockedByCount({ status: 'unavailable' })).toBe(false);
    expect(submitBlockedByCount({ status: 'loading' })).toBe(false);
    expect(submitBlockedByCount({ status: 'idle' })).toBe(false);
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

  // Review 2026-09-07 round 2 (i18n H4) — next-intl does NOT throw on a
  // missing value; it renders the raw key path as the toast. So the
  // too-large code must ALWAYS carry a ceiling: the server's `details.cap`
  // when present, else the ceiling the page resolved server-side.
  it('errorValues: the too-large code yields { ceiling } from details.cap, falling back to the page ceiling; anything else yields undefined', () => {
    expect(errorValues('broadcast_audience_too_large', { cap: 50000, count: 50001 }, 5000)).toEqual({ ceiling: 50000 });
    expect(errorValues('broadcast_audience_too_large', {}, 5000)).toEqual({ ceiling: 5000 });
    expect(errorValues('broadcast_audience_too_large', { cap: 'x' }, 5000)).toEqual({ ceiling: 5000 });
    expect(errorValues('broadcast_audience_too_large', undefined, 50000)).toEqual({ ceiling: 50000 });
    expect(errorValues('broadcast_empty_segment_blocked', { cap: 5000 }, 5000)).toBeUndefined();
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

  it('estimateNoteKey picks the leg-specific wording for member-based segments, the custom copy for the list, and its OWN copy for attendees', () => {
    expect(estimateNoteKey('all_members', 'primary_only')).toBe('estimateNote.allMembers');
    expect(estimateNoteKey('all_members', 'all_contacts')).toBe('estimateNote.allMembersAllContacts');
    expect(estimateNoteKey('tier', 'primary_only')).toBe('estimateNote.tier');
    expect(estimateNoteKey('tier', 'all_contacts')).toBe('estimateNote.tierAllContacts');
    expect(estimateNoteKey('custom', 'all_contacts')).toBe('estimateNote.custom');
    // Review round 2 (UX H-2 + i18n L1): the attendee segment inherited the
    // custom-list copy ("each line below is one email… Maximum 100 entries")
    // with no textarea following it, next to a real server count.
    expect(estimateNoteKey('event_attendees_last_90d', 'primary_only')).toBe('estimateNote.attendees');
    expect(estimateNoteKey('event_attendees_last_90d', 'all_contacts')).toBe('estimateNote.attendees');
  });

  it('showsSelfExclusionHint is true for member-based segments only (the custom list is not self-excluded)', () => {
    expect(showsSelfExclusionHint('all_members')).toBe(true);
    expect(showsSelfExclusionHint('tier')).toBe(true);
    expect(showsSelfExclusionHint('custom')).toBe(false);
    expect(showsSelfExclusionHint('event_attendees_last_90d')).toBe(false);
  });

  // Review 2026-09-07 round 2 (UX H-3) — the ABSENCE of a hint on the custom
  // list / attendee segment read as "the same rule applies": a sender who
  // learned "you won't receive your own broadcast" on all_members switched
  // to a custom list containing their own address and got their own e-blast.
  // Every segment kind now says which way the rule goes.
  it('selfExclusionHintKey: every segment kind has a hint, and it says which way the rule goes', () => {
    expect(selfExclusionHintKey('all_members')).toBe('selfExclusionHint');
    expect(selfExclusionHintKey('tier')).toBe('selfExclusionHint');
    expect(selfExclusionHintKey('custom')).toBe('selfExclusionHintCustom');
    expect(selfExclusionHintKey('event_attendees_last_90d')).toBe('selfExclusionHintAttendees');
  });

  // Review round 2 (UX H-1 + i18n H3) — the staff proxy form told the admin
  // "{company} won't receive this broadcast" on member selection regardless
  // of segment; on a custom list containing the member's address that was
  // the opposite of what happened.
  it('proxySelfExclusionNoticeKey: excluded on member-based segments, "included" on the custom list and attendees', () => {
    expect(proxySelfExclusionNoticeKey('all_members')).toBe('selfExclusionNotice');
    expect(proxySelfExclusionNoticeKey('tier')).toBe('selfExclusionNotice');
    expect(proxySelfExclusionNoticeKey('custom')).toBe('selfExclusionNoticeIncluded');
    expect(proxySelfExclusionNoticeKey('event_attendees_last_90d')).toBe('selfExclusionNoticeIncluded');
  });
});

// Review 2026-09-07 round 2 — the UX / i18n reviewers' copy findings, pinned
// so they cannot quietly regress. Presence in all three locales, plus the
// specific TH / SV terms that were wrong.
describe('round-2 copy pins (UX + i18n reviewers)', () => {
  it.each([
    ['portal.broadcasts.compose.estimateNote.attendees', true],
    ['portal.broadcasts.compose.selfExclusionHintCustom', false],
    ['portal.broadcasts.compose.selfExclusionHintAttendees', false],
    ['portal.broadcasts.compose.recipientCount.empty', false],
    ['portal.broadcasts.compose.recipientCount.retry', false],
    ['admin.broadcasts.proxySubmitDialog.selfExclusionNoticeIncluded', false],
  ])('%s exists in en / th / sv (ceiling interpolated: %s)', (path, ceiling) => {
    for (const [locale, messages] of [['en', en], ['th', th], ['sv', sv]] as const) {
      const value = pick(messages as Messages, path);
      expect(typeof value, `${locale}: ${path}`).toBe('string');
      expect((value as string).length, `${locale}: ${path}`).toBeGreaterThan(0);
      if (ceiling) expect(value as string, `${locale}: ${path}`).toMatch(/\{ceiling/);
    }
  });

  it('EN: the ready line is pluralised (1 recipient, not "1 recipients") and says "limit", not "ceiling"', () => {
    expect(pick(en as Messages, 'portal.broadcasts.compose.recipientCount.ready')).toMatch(/\{count, plural/);
    expect(pick(en as Messages, 'portal.broadcasts.compose.recipientCount.exceeds')).not.toMatch(/ceiling of/);
  });

  it('TH: preference counts are locale-grouped numbers, "email" is อีเมล, opt-out is the house term', () => {
    for (const path of [
      'portal.broadcasts.compose.toast.preferenceExcluded',
      'admin.broadcasts.proxySubmitDialog.preferenceExcluded',
    ]) {
      const v = pick(th as Messages, path) as string;
      expect(v, path).toMatch(/\{count, number\}/);
      expect(v, path).not.toMatch(/ที่อยู่/);
    }
    for (const path of [
      'portal.broadcasts.compose.estimateNote.allMembersAllContacts',
      'portal.broadcasts.compose.estimateNote.tierAllContacts',
    ]) {
      const v = pick(th as Messages, path) as string;
      expect(v, path).toMatch(/ปิดการรับข่าวสาร/);
      expect(v, path).not.toMatch(/ไม่ได้ปิดรับ/);
    }
    expect(pick(th as Messages, 'admin.broadcasts.queue.haltStateUnavailable')).not.toMatch(/ซ่อน/);
  });

  it('SV: the reflexive binds to the member, the count is plural-genitive, unsubscribe is the house term, "skicka in" not "inlämningen"', () => {
    expect(pick(sv as Messages, 'admin.broadcasts.proxySubmitDialog.selfExclusionNotice')).not.toMatch(/\bsina\b/);
    for (const path of [
      'portal.broadcasts.compose.toast.preferenceExcluded',
      'admin.broadcasts.proxySubmitDialog.preferenceExcluded',
    ]) {
      const v = pick(sv as Messages, path) as string;
      expect(v, path).toMatch(/mottagarnas/);
      expect(v, path).toMatch(/e-postadress/);
    }
    for (const path of [
      'portal.broadcasts.compose.estimateNote.allMembersAllContacts',
      'portal.broadcasts.compose.estimateNote.tierAllContacts',
    ]) {
      expect(pick(sv as Messages, path), path).not.toMatch(/avböjt/);
    }
    expect(pick(sv as Messages, 'portal.broadcasts.compose.recipientCount.exceeds')).not.toMatch(/inlämningen/);
    expect(pick(sv as Messages, 'portal.broadcasts.compose.selfExclusionHint')).not.toMatch(/får inte/);
  });
});

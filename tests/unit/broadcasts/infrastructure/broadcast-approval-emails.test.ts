/**
 * F119 T129a — the five approval-round email builders × EN / TH / SV
 * (contracts/dashboard-and-notifications.md § 3, FR-021b, FR-024).
 *
 *   1. Every builder, every variant (decision / kind / audience / times that
 *      differ or not), renders in all three locales with no missing key and
 *      no unfilled placeholder, and the Thai copy is Thai — never a
 *      Latin-only fallback, never italic.
 *   2. FR-021b containment: a STAFF body carries the E-Blast subject, the
 *      member company, the stage and a link — and none of the body, the
 *      member's reason, marketing's note or the send times, even when the
 *      caller hands the builder a context that has all of them. The positive
 *      control proves the leak matcher can see a reason spliced back in.
 *   3. The member bodies say what they must: the "version ready" body the
 *      day 3 / 7 / 23 / 30 timeline, the schedule body both times plus the
 *      "not the time you proposed" line only when they differ.
 *   4. Every key under `email.eblastApproval` is read by some rendering, so
 *      no translator is asked to keep a dead line true.
 */
import { describe, expect, it } from 'vitest';
import enMessages from '@/i18n/messages/en.json';
import thMessages from '@/i18n/messages/th.json';
import svMessages from '@/i18n/messages/sv.json';
import { escapeHtml } from '@/lib/html-escape';
import {
  EBLAST_LIFECYCLE_KINDS,
  EBLAST_MEMBER_DECIDED_KINDS,
  buildEblastApprovalLifecycleEmail,
  buildEblastMemberDecidedMarketingEmail,
  buildEblastScheduleConfirmedMemberEmail,
  buildEblastSubmittedMarketingEmail,
  buildEblastVersionSentMemberEmail,
  formatEblastEmailDate,
  type BuiltEblastEmail,
} from '@/modules/broadcasts/infrastructure/email/broadcast-approval-emails';

const LOCALES = ['en', 'th', 'sv'] as const;
const BROADCAST_ID = '11111111-1111-4111-8111-111111111111';
const SUBJECT = 'Autumn networking night';
const COMPANY = 'Nordic Trading Co., Ltd.';
const SENT_AT = new Date('2026-09-20T03:00:00.000Z');
const PROPOSED = new Date('2026-10-01T02:00:00.000Z');
const CONFIRMED = new Date('2026-10-02T04:30:00.000Z');

/** Everything a staff email must NOT carry — handed to the builder anyway. */
const BODY = '<p>SECRET-BODY-7f3a the member wrote this</p>';
const REASON = 'SECRET-REASON-91c2 please change the logo';
const NOTE = 'SECRET-NOTE-44de check the date';
const FULL_CONTEXT = {
  bodyHtml: BODY,
  reason: REASON,
  noteToMember: NOTE,
  proposedSendAt: PROPOSED,
  confirmedSendAt: CONFIRMED,
  sentAt: SENT_AT,
};

function forbiddenFragments(locale: (typeof LOCALES)[number]): string[] {
  return [
    'SECRET-BODY-7f3a',
    'SECRET-REASON-91c2',
    'SECRET-NOTE-44de',
    PROPOSED.toISOString(),
    CONFIRMED.toISOString(),
    formatEblastEmailDate(PROPOSED, locale),
    formatEblastEmailDate(CONFIRMED, locale),
    formatEblastEmailDate(SENT_AT, locale),
  ];
}

/** Which forbidden fragments appear anywhere in the email (subject, html, text; raw or escaped). */
function leaks(email: BuiltEblastEmail, forbidden: readonly string[]): string[] {
  const all = `${email.subject}\n${email.html}\n${email.text}`;
  return forbidden.filter((f) => all.includes(f) || all.includes(escapeHtml(f)));
}

type Rendered = { readonly label: string; readonly locale: (typeof LOCALES)[number]; readonly audience: 'staff' | 'member'; readonly email: BuiltEblastEmail };

function staffRenders(locale: (typeof LOCALES)[number]): Rendered[] {
  // The spread hands each builder a context holding the body, the reason, the
  // note and every time: the TYPE admits none of them, and the render must
  // not find a way to them either.
  const base = { ...FULL_CONTEXT, locale, broadcastId: BROADCAST_ID, broadcastSubject: SUBJECT, companyName: COMPANY };
  return [
    { label: 'submitted_marketing', locale, audience: 'staff', email: buildEblastSubmittedMarketingEmail(base) },
    ...EBLAST_MEMBER_DECIDED_KINDS.map((decision) => ({
      label: `member_decided_marketing:${decision}`,
      locale,
      audience: 'staff' as const,
      email: buildEblastMemberDecidedMarketingEmail({ ...base, decision }),
    })),
    ...EBLAST_LIFECYCLE_KINDS.map((kind) => ({
      label: `lifecycle:staff:${kind}`,
      locale,
      audience: 'staff' as const,
      email: buildEblastApprovalLifecycleEmail({ ...base, audience: 'staff', kind }),
    })),
  ];
}

function memberRenders(locale: (typeof LOCALES)[number]): Rendered[] {
  const version = { locale, broadcastId: BROADCAST_ID, versionSubject: SUBJECT, round: 2, sentAt: SENT_AT };
  const schedule = { locale, broadcastId: BROADCAST_ID, broadcastSubject: SUBJECT, confirmedSendAt: CONFIRMED };
  return [
    { label: 'version_sent:note+proposal', locale, audience: 'member', email: buildEblastVersionSentMemberEmail({ ...version, noteToMember: NOTE, proposedSendAt: PROPOSED }) },
    { label: 'version_sent:bare', locale, audience: 'member', email: buildEblastVersionSentMemberEmail({ ...version, noteToMember: null, proposedSendAt: null }) },
    { label: 'schedule:differs', locale, audience: 'member', email: buildEblastScheduleConfirmedMemberEmail({ ...schedule, proposedSendAt: PROPOSED }) },
    { label: 'schedule:same', locale, audience: 'member', email: buildEblastScheduleConfirmedMemberEmail({ ...schedule, confirmedSendAt: PROPOSED, proposedSendAt: PROPOSED }) },
    { label: 'schedule:no-proposal', locale, audience: 'member', email: buildEblastScheduleConfirmedMemberEmail({ ...schedule, proposedSendAt: null }) },
    ...EBLAST_LIFECYCLE_KINDS.map((kind) => ({
      label: `lifecycle:member:${kind}`,
      locale,
      audience: 'member' as const,
      email: buildEblastApprovalLifecycleEmail({ locale, audience: 'member', kind, broadcastId: BROADCAST_ID, broadcastSubject: SUBJECT, sentAt: SENT_AT }),
    })),
  ];
}

const ALL: Rendered[] = LOCALES.flatMap((l) => [...staffRenders(l), ...memberRenders(l)]);

const THAI = /[฀-๿]/;

function leaves(node: unknown, path = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[path, node]];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
}
const copyOf = (m: unknown) => (m as { email: { eblastApproval: unknown } }).email.eblastApproval;

describe('every builder renders in en, th and sv with no missing key and no Latin-only fallback in th', () => {
  it('covers all five notification types across every variant (positive control on the fixture)', () => {
    // 1 submitted + 4 decisions + 4 staff lifecycle + 2 version + 3 schedule + 4 member lifecycle
    expect(ALL).toHaveLength(3 * 18);
  });

  it.each(ALL.map((r) => [`${r.locale} ${r.label}`, r] as const))('%s: complete, no placeholder, no "undefined"', (_n, r) => {
    for (const part of [r.email.subject, r.email.html, r.email.text]) {
      expect(part.length).toBeGreaterThan(0);
      expect(part).not.toMatch(/\{\w+\}/);
      expect(part).not.toContain('undefined');
      expect(part).not.toContain('[object');
    }
    expect(r.email.html).toContain(`lang="${r.locale}"`);
  });

  it('the Thai copy is Thai: every th leaf carries Thai script and differs from en', () => {
    const th = leaves(copyOf(thMessages));
    const en = new Map(leaves(copyOf(enMessages)));
    expect(th.length).toBeGreaterThan(40);
    for (const [path, value] of th) {
      expect(value, path).toMatch(THAI);
      expect(value, path).not.toBe(en.get(path));
    }
  });

  it('every th rendering reads as Thai and uses no italic', () => {
    for (const r of ALL.filter((x) => x.locale === 'th')) {
      expect(r.email.subject, r.label).toMatch(THAI);
      expect(r.email.text, r.label).toMatch(THAI);
      expect(r.email.html, r.label).not.toMatch(/<(em|i)\b|font-style:\s*italic/i);
    }
  });

  it('the three locales carry the same key set', () => {
    const keys = (m: unknown) => leaves(copyOf(m)).map(([p]) => p).sort();
    expect(keys(thMessages)).toEqual(keys(enMessages));
    expect(keys(svMessages)).toEqual(keys(enMessages));
  });

  it('every en key is read by at least one rendering (no dead copy)', () => {
    const rendered = ALL.filter((r) => r.locale === 'en').map((r) => `${r.email.subject}\n${r.email.text}`).join('\n');
    const dead = leaves(copyOf(enMessages)).filter(([, value]) => {
      const fragments = value.split(/\{\w+\}/).map((s) => s.trim()).filter((s) => s.length >= 4);
      return fragments.length > 0 && !fragments.every((f) => rendered.includes(f));
    });
    expect(dead).toEqual([]);
  });
});

describe('FR-021b — a staff body carries subject + company + stage + link, and nothing else', () => {
  it.each(LOCALES.flatMap((l) => staffRenders(l)).map((r) => [`${r.locale} ${r.label}`, r] as const))(
    '%s: contains none of the body, the reason, the note or the send times',
    (_n, r) => {
      expect(leaks(r.email, forbiddenFragments(r.locale))).toEqual([]);
      expect(r.email.text).toContain(SUBJECT);
      expect(r.email.text).toContain(COMPANY);
      expect(r.email.text).toContain(`/admin/broadcasts/${BROADCAST_ID}`);
    },
  );

  it('positive control: the matcher fails when the member\'s reason is spliced back into a staff body', () => {
    const [clean] = staffRenders('en');
    const spliced = { ...clean!.email, html: `${clean!.email.html}<p>${escapeHtml(REASON)}</p>` };
    expect(leaks(spliced, forbiddenFragments('en'))).toEqual(['SECRET-REASON-91c2']);
    const splicedText = { ...clean!.email, text: `${clean!.email.text}\n${formatEblastEmailDate(PROPOSED, 'en')}` };
    expect(leaks(splicedText, forbiddenFragments('en'))).toEqual([formatEblastEmailDate(PROPOSED, 'en')]);
  });

  it('each decision names its own stage (the discriminator selects the wording)', () => {
    const stages = EBLAST_MEMBER_DECIDED_KINDS.map((decision) =>
      buildEblastMemberDecidedMarketingEmail({ locale: 'en', broadcastId: BROADCAST_ID, broadcastSubject: SUBJECT, companyName: COMPANY, decision }).text,
    );
    expect(stages[0]).toContain('Member approved — awaiting schedule');
    expect(stages[1]).toContain('Changes requested by member');
    expect(stages[2]).toContain('Changes requested by member');
    expect(stages[3]).toContain('Withdrawn');
  });
});

describe('member bodies state what changed, who acted, the times and the way back', () => {
  it.each(LOCALES)('%s: the version-ready body states day 3, 7, 23 and 30 with their dates, the round, "the chamber" and a portal link', (locale) => {
    const email = buildEblastVersionSentMemberEmail({
      locale,
      broadcastId: BROADCAST_ID,
      versionSubject: SUBJECT,
      round: 2,
      noteToMember: NOTE,
      proposedSendAt: PROPOSED,
      sentAt: SENT_AT,
    });
    for (const day of [3, 7, 23, 30]) {
      expect(email.text).toContain(formatEblastEmailDate(new Date(SENT_AT.getTime() + day * 86_400_000), locale));
    }
    expect(email.text).toContain(NOTE);
    expect(email.text).toContain(formatEblastEmailDate(PROPOSED, locale));
    expect(email.text).toContain(`/portal/broadcasts/${BROADCAST_ID}`);
    expect(email.text).toContain('2');
    if (locale === 'en') {
      for (const day of ['Day 3', 'Day 7', 'Day 23', 'Day 30']) expect(email.text).toContain(day);
      expect(email.text).toContain('The chamber');
    }
  });

  it.each(LOCALES)('%s: the schedule body shows both times and the "not the time you proposed" line only when they differ', (locale) => {
    const notProposed = (copyOf({ en: enMessages, th: thMessages, sv: svMessages }[locale]) as { scheduleConfirmedMember: { notProposedTime: string } })
      .scheduleConfirmedMember.notProposedTime;
    const base = { locale, broadcastId: BROADCAST_ID, broadcastSubject: SUBJECT };
    const differs = buildEblastScheduleConfirmedMemberEmail({ ...base, proposedSendAt: PROPOSED, confirmedSendAt: CONFIRMED });
    expect(differs.text).toContain(formatEblastEmailDate(CONFIRMED, locale));
    expect(differs.text).toContain(formatEblastEmailDate(PROPOSED, locale));
    expect(differs.text).toContain(notProposed);

    const same = buildEblastScheduleConfirmedMemberEmail({ ...base, proposedSendAt: PROPOSED, confirmedSendAt: PROPOSED });
    expect(same.text).toContain(formatEblastEmailDate(PROPOSED, locale));
    expect(same.text).not.toContain(notProposed);
    expect(same.text.split(formatEblastEmailDate(PROPOSED, locale))).toHaveLength(2);

    const none = buildEblastScheduleConfirmedMemberEmail({ ...base, proposedSendAt: null, confirmedSendAt: CONFIRMED });
    expect(none.text).toContain(notProposed);
    expect(none.text).toContain(`/portal/broadcasts/${BROADCAST_ID}`);
  });

  it('the member lifecycle bodies restate only the REMAINING timeline, and day 30 states the closing date', () => {
    const day = (n: number) => formatEblastEmailDate(new Date(SENT_AT.getTime() + n * 86_400_000), 'en');
    const render = (kind: (typeof EBLAST_LIFECYCLE_KINDS)[number]) =>
      buildEblastApprovalLifecycleEmail({ locale: 'en', audience: 'member', kind, broadcastId: BROADCAST_ID, broadcastSubject: SUBJECT, sentAt: SENT_AT }).text;
    expect(render('reminder_day3')).toContain(day(7));
    expect(render('reminder_day3')).toContain(day(30));
    expect(render('reminder_day7')).not.toContain('Day 7 (');
    expect(render('reminder_day7')).toContain(day(23));
    expect(render('expiry_warning_day23')).toContain(day(30));
    expect(render('expired_day30')).toContain(day(30));
    expect(render('expired_day30')).not.toContain('What happens next');
  });

  it('user text is escaped in the HTML', () => {
    const email = buildEblastVersionSentMemberEmail({
      locale: 'en',
      broadcastId: BROADCAST_ID,
      versionSubject: '<script>alert(1)</script>',
      round: 1,
      noteToMember: '<img src=x onerror=1>',
      proposedSendAt: null,
      sentAt: SENT_AT,
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<img src=x');
    expect(email.html).toContain('&lt;script&gt;');
  });
});

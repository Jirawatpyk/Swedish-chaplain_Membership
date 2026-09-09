/**
 * Staff review 2026-09-07, Pass 4 finding 🟡-1 — the FR-021 / AS2
 * "your scheduled E-Blast did not go out" email is the one place a member
 * reads about a dispatch failure, and nothing tested it.
 *
 * `input.reason` is an ENGINEERING token: `audience_too_large`,
 * `audience_post_suppression_empty`, `malformed_segment` (new in 108 PR-C),
 * or — on `classifyThrown`'s unknown branch — a raw `Error.message`. It used
 * to be interpolated straight into the body, so a Thai member read
 * "สาเหตุ: malformed_segment" about a database data defect they cannot act
 * on, and an unmapped throw could have put an exception message (with
 * whatever it carries) into a member's inbox.
 *
 * Pinned here: every token renders a translated sentence in all three
 * locales, an unknown token falls back to the generic sentence, and the raw
 * token never appears in the rendered HTML or text.
 */
import { describe, expect, it } from 'vitest';

import { buildBroadcastFailedToDispatchEmail } from '@/modules/broadcasts/infrastructure/email/broadcast-notification-emails';
import { MEMBER_FACING_FAILURE_REASONS } from '@/modules/broadcasts/application/use-cases/build-audience-tick';
import enMessages from '@/i18n/messages/en.json';
import thMessages from '@/i18n/messages/th.json';
import svMessages from '@/i18n/messages/sv.json';

const LOCALES = ['en', 'th', 'sv'] as const;

/**
 * DERIVED, not restated (round 3 finding 3-12, third leg). This list used to
 * name three reasons by hand while `ImportFailureReason` carried nine, so SEVEN
 * of the ten tokens a member can receive rendered the same generic sentence —
 * and nothing could see it: `check:i18n` only compares locales against each
 * other, and `broadcast-notification-emails.ts:265` falls back with
 * `?? generic` on a plain object, so an absent key is indistinguishable from a
 * deliberate one at runtime.
 *
 * Importing the tuple means adding a reason without adding its sentence in all
 * three locales fails HERE instead of quietly telling a member "a technical
 * problem prevented delivery".
 */
const KNOWN_REASONS = MEMBER_FACING_FAILURE_REASONS;

/** A distinctive fragment of each locale's `body2`, read from the message file. */
function enOutageMarker(locale: (typeof LOCALES)[number]): string {
  const msgs = { en: enMessages, th: thMessages, sv: svMessages }[locale] as {
    email: { broadcastFailedToDispatch: { body2: string } };
  };
  // First eight words is enough to be distinctive and short enough to survive a
  // trailing-clause edit.
  return msgs.email.broadcastFailedToDispatch.body2.split(' ').slice(0, 8).join(' ');
}

function build(reason: string, locale: (typeof LOCALES)[number]) {
  return buildBroadcastFailedToDispatchEmail({
    toEmail: 'member@example.test',
    broadcastId: '11111111-1111-4111-8111-111111111111',
    broadcastSubject: 'Chamber news',
    tenantDisplayName: 'Test Chamber',
    scheduledFor: '2026-09-07T09:00:00.000Z',
    reason,
    locale,
  });
}

describe('buildBroadcastFailedToDispatchEmail — the reason a MEMBER reads', () => {
  it.each(LOCALES)('%s: every known reason renders a sentence, never the token', (locale) => {
    for (const reason of KNOWN_REASONS) {
      const mail = build(reason, locale);
      expect(mail.text, `${locale}/${reason}`).not.toContain(reason);
      expect(mail.html, `${locale}/${reason}`).not.toContain(reason);
      // A sentence, not an identifier: no snake_case token anywhere in the body.
      expect(mail.text, `${locale}/${reason}`).not.toMatch(/[a-z]+_[a-z]+_[a-z]+/);
    }
  });

  it.each(LOCALES)('%s: the three known reasons read differently from one another', (locale) => {
    const texts = KNOWN_REASONS.map((r) => build(r, locale).text);
    expect(new Set(texts).size).toBe(KNOWN_REASONS.length);
  });

  it.each(LOCALES)(
    '%s: an UNMAPPED reason (the classifyThrown unknown branch carries a raw Error message) falls back to the generic sentence and leaks nothing',
    (locale) => {
      const raw = 'connect ECONNREFUSED 10.0.0.5:5432 while SELECT email FROM contacts';
      const mail = build(raw, locale);
      expect(mail.text).not.toContain('ECONNREFUSED');
      expect(mail.text).not.toContain('contacts');
      expect(mail.html).not.toContain('ECONNREFUSED');
      // It still says SOMETHING about why — the same generic sentence an
      // unknown failure gets, so the reason line is never blank.
      const generic = build('some-other-unmapped-token', locale).text;
      expect(mail.text).toBe(generic);
    },
  );

  it('en: malformed_segment tells the member who can fix it', () => {
    expect(build('malformed_segment', 'en').text).toMatch(/administrator/i);
  });

  /**
   * Round 2 R2-13, second half — `body2` says "our delivery service was
   * unreachable for over an hour, so we stopped retrying to avoid sending at an
   * unexpected time". It was rendered UNCONDITIONALLY, so a member whose
   * broadcast hit the Free-plan cap, or whose segment would not parse, read a
   * paragraph asserting an outage that had not happened — one paragraph below a
   * Reason line saying something else, in the same email.
   */
  it.each(LOCALES)('%s: the outage paragraph appears ONLY for the reasons it describes', (locale) => {
    const outage = build('retry_budget_exhausted', locale).text;
    const notOutage = build('gateway_permanent', locale).text;

    // Pinned by a distinctive fragment of the sentence rather than the whole
    // string, so a copy edit does not fail this for the wrong reason.
    const marker = enOutageMarker(locale);
    expect(outage).toContain(marker);
    expect(notOutage).not.toContain(marker);
  });

  it('the non-outage email still carries its reason and its reassurance', () => {
    const mail = build('gateway_permanent', 'en');
    // Dropping the paragraph must not drop the two that answer "why" and
    // "what happens to my quota".
    expect(mail.text).toContain('refused the request');
    expect(mail.text).toMatch(/quota/i);
  });

  /**
   * The load-bearing half of the derived list: every reason must render a
   * DISTINCT sentence, not merely a non-token one. Without this, adding the key
   * with the generic string copied in would satisfy every case above — which is
   * exactly the state the seven missing reasons were already in.
   */
  it.each(LOCALES)('%s: no reason silently reuses the generic sentence', (locale) => {
    const generic = build('a-token-nothing-maps', locale).text;
    for (const reason of KNOWN_REASONS) {
      expect(build(reason, locale).text, `${locale}/${reason}`).not.toBe(generic);
    }
  });
});

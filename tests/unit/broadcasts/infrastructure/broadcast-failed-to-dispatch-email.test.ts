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

const LOCALES = ['en', 'th', 'sv'] as const;
const KNOWN_REASONS = [
  'audience_too_large',
  'audience_post_suppression_empty',
  'malformed_segment',
] as const;

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
});

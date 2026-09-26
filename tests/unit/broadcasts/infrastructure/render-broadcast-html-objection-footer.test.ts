/**
 * E-Blast footer — objection route (PDPA/GDPR review follow-up).
 *
 * Recipients land on Resend's hosted unsubscribe page, not ours, so the
 * email itself must say what unsubscribing does (every E-Blast from the
 * chamber, whichever member sent it) and name the monitored privacy inbox
 * as a free alternative (GDPR Art. 21(4): the right to object must be
 * brought to the recipient's attention clearly and separately).
 *
 * The "why you are receiving this" line must also be true for every
 * audience: `event_attendees_last_90d` reaches attendees who are not a
 * member's contact.
 *
 * The address comes from `TENANT_PRIVACY_CONTACT_EMAIL` (tests/setup.ts:
 * privacy@zyncdata.app).
 */
import { describe, expect, it } from 'vitest';
import { renderBroadcastHtml } from '@/modules/broadcasts/infrastructure/resend/email-template';

const BASE = { subject: 'Hello', bodyHtml: '<p>Body</p>', tenantDisplayName: 'Chamber & Co' };

function footer(html: string): string {
  const m = /<tr><td style="padding:16px 32px 24px 32px;border-top:1px solid #eee;[^"]*">([\s\S]*?)<\/td><\/tr>/.exec(html);
  expect(m).not.toBeNull();
  return m![1]!;
}

describe('E-Blast footer — objection route', () => {
  it.each([
    ['en', 'Unsubscribing stops all E-Blasts from Chamber &amp; Co.'],
    ['th', 'การยกเลิกจะหยุด E-Blast ทั้งหมดจาก Chamber &amp; Co'],
    ['sv', 'Avregistreringen stoppar alla utskick från Chamber &amp; Co.'],
  ] as const)('%s: says the opt-out covers every E-Blast and links the privacy inbox', (locale, stops) => {
    const f = footer(renderBroadcastHtml({ ...BASE, locale }));
    expect(f).toContain(stops);
    expect(f).toMatch(/<a href="mailto:privacy@zyncdata\.app"[^>]*>privacy@zyncdata\.app<\/a>/);
    // The Resend unsubscribe merge tag is still the primary CTA.
    expect(f).toContain('href="{{{RESEND_UNSUBSCRIBE_URL}}}"');
  });

  it.each(['en', 'th', 'sv'] as const)(
    '%s: "why you receive this" no longer claims every recipient is a member contact',
    (locale) => {
      const f = footer(renderBroadcastHtml({ ...BASE, locale }));
      expect(f).not.toMatch(/contact at a member|ผู้ติดต่อของสมาชิก|kontakt hos en medlem/);
    },
  );
});

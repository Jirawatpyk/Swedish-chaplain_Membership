/**
 * E-Blasts rely on legitimate interest (GDPR Art. 6(1)(f) / PDPA §24(5)),
 * not consent. The compose banner used to make the member acknowledge that
 * recipients "have agreed" and could "revoke consent per recipient" — a
 * statement about third parties that is untrue, and an opt-out scope
 * (per recipient) that does not match `marketing_unsubscribes` (tenant +
 * email). The banner is an acknowledgement of sending terms, so no locale
 * may describe it as consent.
 */
import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import sv from '@/i18n/messages/sv.json';

const LOCALES = { en, th, sv } as const;
const CONSENT_WORDS = /consent|agreed|ยินยอม|samtyck/i;

describe('E-Blast compose banner — lawful-basis copy', () => {
  for (const [locale, messages] of Object.entries(LOCALES)) {
    it(`${locale}: no acknowledgement string claims consent`, () => {
      const copy = messages.portal.broadcasts.banner.acknowledgement as Record<string, string>;
      for (const [key, value] of Object.entries(copy)) {
        expect(`${key}: ${value}`).not.toMatch(CONSENT_WORDS);
      }
    });
  }

  it('en: states the real rules — opt-outs honoured, unsubscribe link in every E-Blast', () => {
    const copy = en.portal.broadcasts.banner.acknowledgement;
    expect(copy.title).toBe('Before you send E-Blasts');
    expect(copy.body).toBe(
      'E-Blasts go to contacts of member companies who have not opted out of marketing emails. ' +
        'Every E-Blast includes an unsubscribe link, and opt-outs are applied automatically. ' +
        "Keep your message relevant to members and don't include other people's personal data.",
    );
    expect(copy.toastAcknowledged).toBe('Acknowledgement recorded.');
  });
});

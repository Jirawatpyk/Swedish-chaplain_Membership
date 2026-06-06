import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import sv from '@/i18n/messages/sv.json';

const NEW_KEYS = ['benefitsShort', 'accountShort', 'bottomTabsAriaLabel'] as const;

describe('nav.member bottom-tab i18n keys (057)', () => {
  it.each(['en', 'th', 'sv'] as const)('%s has all new nav.member tab keys', (loc) => {
    const messages = ({ en, th, sv } as const)[loc];
    const member = (messages as { nav: { member: Record<string, string> } }).nav.member;
    for (const key of NEW_KEYS) {
      expect(member[key], `${loc} nav.member.${key}`).toBeTruthy();
    }
  });
});

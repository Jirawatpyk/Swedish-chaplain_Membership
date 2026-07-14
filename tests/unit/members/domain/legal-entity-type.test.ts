import { describe, expect, it } from 'vitest';
import enMessages from '@/i18n/messages/en.json';
import thMessages from '@/i18n/messages/th.json';
import svMessages from '@/i18n/messages/sv.json';
import {
  LEGAL_ENTITY_TYPES,
  VAT_DEFAULT_BY_CODE,
  isLegalEntityTypeCode,
} from '@/modules/members/domain/value-objects/legal-entity-type';

describe('legal entity type catalogue', () => {
  it('every code resolves to a label in all three locales', () => {
    // The resolver in [memberId]/page.tsx falls back to the RAW stored string on
    // a miss — no error, no failing test. So a code with no key ships as
    // `limited_company` printed literally on the member page. This is the only
    // test that catches it.
    for (const messages of [enMessages, thMessages, svMessages]) {
      const labels = messages.admin.members.detail.legalEntityTypes as Record<
        string,
        string
      >;
      for (const code of LEGAL_ENTITY_TYPES) {
        expect(labels[code], `missing label for "${code}"`).toBeTruthy();
      }
    }
  });

  it('association and foundation have NO VAT default', () => {
    // VAT registration is a function of turnover (>1.8M THB/yr, พ.ร.ฎ. 432),
    // not of legal form. TSCC is ITSELF a VAT-registered association — a `false`
    // default here would under-print the §86/4 line on the members most like the
    // chamber itself. Force the admin to choose.
    expect(VAT_DEFAULT_BY_CODE.association).toBeNull();
    expect(VAT_DEFAULT_BY_CODE.foundation).toBeNull();
  });

  it('a natural person can still be a VAT registrant', () => {
    // §77/1 defines ผู้ประกอบการ to include natural persons. A sole proprietor
    // above the threshold MUST register. So the default is false, but it is only
    // a default — never a rule.
    expect(VAT_DEFAULT_BY_CODE.sole_proprietor).toBe(false);
    expect(VAT_DEFAULT_BY_CODE.individual).toBe(false);
  });

  it('juristic trading forms default to registrant', () => {
    expect(VAT_DEFAULT_BY_CODE.limited_company).toBe(true);
    expect(VAT_DEFAULT_BY_CODE.public_company).toBe(true);
    expect(VAT_DEFAULT_BY_CODE.state_enterprise).toBe(true);
  });

  it('offices barred from earning revenue default to non-registrant', () => {
    expect(VAT_DEFAULT_BY_CODE.representative_office).toBe(false);
    expect(VAT_DEFAULT_BY_CODE.government).toBe(false);
  });

  it('rejects an unknown code', () => {
    expect(isLegalEntityTypeCode('limited_company')).toBe(true);
    expect(isLegalEntityTypeCode('sole_proprietorship')).toBe(false); // near-miss
    expect(isLegalEntityTypeCode('')).toBe(false);
    expect(isLegalEntityTypeCode(null)).toBe(false);
  });
});

/**
 * Unit tests for composeBuyerAddress (F4 invoice/receipt buyer block).
 *
 * Locks the §86/§87 full-address composition: real structured parts render
 * as a multi-line block; the country is always the last line; an address-less
 * member degrades to the bare country NAME (non-empty invariant preserved so
 * the snapshot schema's `address: string.min(1)` never rejects).
 *
 * 059 / PR-A Task 6a — the country line renders the resolved country NAME
 * ("Sweden"), not the raw ISO 3166-1 alpha-2 code ("SE"). §86/4 requires an
 * address that identifies the buyer unambiguously, and a Revenue officer cannot
 * read a two-letter code. It also surfaces DATA ERRORS: a real issued invoice
 * carried a bare line reading `SV` — which is EL SALVADOR. Sweden is `SE`. `SV`
 * passes `asIsoCountryCode` (El Salvador is a real country), so the value was
 * valid AND wrong, and nobody noticed because nobody reads two-letter codes.
 * Printed as a name it is impossible to miss.
 */
import { describe, expect, it } from 'vitest';
import { composeBuyerAddress } from '@/modules/invoicing/infrastructure/adapters/compose-buyer-address';

describe('composeBuyerAddress', () => {
  it('composes a full DOMESTIC (TH) address — line1 / line2 / locality, country suppressed (L-01)', () => {
    const out = composeBuyerAddress({
      addressLine1: '99/1 Rama IV Road',
      addressLine2: 'Unit 12B',
      subDistrict: null,
      city: 'Khlong Toei',
      province: 'Bangkok',
      postalCode: '10110',
      country: 'TH',
    });
    // Trailing "TH" is redundant on a domestic Thai tax invoice.
    expect(out).toBe('99/1 Rama IV Road\nUnit 12B\nKhlong Toei Bangkok 10110');
  });

  it('FOREIGN member with street parts keeps the country line — resolved to its NAME', () => {
    const out = composeBuyerAddress({
      addressLine1: 'Kungsgatan 1',
      addressLine2: null,
      subDistrict: null,
      city: 'Stockholm',
      province: null,
      postalCode: '11143',
      country: 'SE',
    });
    expect(out).toBe('Kungsgatan 1\nStockholm 11143\nSweden');
  });

  it('resolves the country NAME, so a mis-keyed code is impossible to miss (SV = El Salvador, NOT Sweden)', () => {
    // The bug that prompted this: a real issued invoice ended in a bare `SV`
    // line. `SV` is El Salvador; Sweden is `SE`. Both are valid ISO codes, so no
    // validator objects — only a human reading the NAME can catch it.
    const out = composeBuyerAddress({
      addressLine1: 'Kungsgatan 1',
      addressLine2: null,
      subDistrict: null,
      city: 'Stockholm',
      province: null,
      postalCode: '11143',
      country: 'SV',
    });
    expect(out).toBe('Kungsgatan 1\nStockholm 11143\nEl Salvador');
  });

  it('an UNKNOWN / unresolvable code degrades to the raw code (never blank — §86/4 address must exist)', () => {
    // `i18n-iso-countries.getName` returns undefined for a code it does not know.
    // Never emit an empty country line: the snapshot schema requires a non-empty
    // address, and a tax document must not silently lose a particular.
    const out = composeBuyerAddress({
      addressLine1: 'Somewhere 1',
      addressLine2: null,
      subDistrict: null,
      city: null,
      province: null,
      postalCode: null,
      country: 'ZZ',
    });
    expect(out).toBe('Somewhere 1\nZZ');
  });

  it('resolves a lowercase code (defensive — the column is uppercase, but never print raw junk)', () => {
    const out = composeBuyerAddress({
      addressLine1: 'Kungsgatan 1',
      addressLine2: null,
      subDistrict: null,
      city: null,
      province: null,
      postalCode: null,
      country: 'se',
    });
    expect(out).toBe('Kungsgatan 1\nSweden');
  });

  it('drops missing parts without leaving dangling separators (TH domestic)', () => {
    const out = composeBuyerAddress({
      addressLine1: '500 Sukhumvit',
      addressLine2: null,
      subDistrict: null,
      city: null,
      province: 'Bangkok',
      postalCode: '10250',
      country: 'TH',
    });
    expect(out).toBe('500 Sukhumvit\nBangkok 10250');
  });

  it('falls back to the bare country NAME when no street parts exist (non-empty invariant)', () => {
    const out = composeBuyerAddress({
      addressLine1: null,
      addressLine2: null,
      subDistrict: null,
      city: null,
      province: null,
      postalCode: null,
      country: 'SE',
    });
    expect(out).toBe('Sweden');
  });

  it('TH with no street parts still keeps the bare country name (no street → not suppressed)', () => {
    const out = composeBuyerAddress({
      addressLine1: null,
      addressLine2: null,
      subDistrict: null,
      city: null,
      province: null,
      postalCode: null,
      country: 'TH',
    });
    expect(out).toBe('Thailand');
  });

  it('treats blank/whitespace-only parts as missing', () => {
    const out = composeBuyerAddress({
      addressLine1: '  ',
      addressLine2: '',
      subDistrict: '  ',
      city: '  ',
      province: 'Chiang Mai',
      postalCode: '50000',
      country: 'TH',
    });
    expect(out).toBe('Chiang Mai 50000');
  });

  it('preserves Thai characters verbatim (shaping happens at render, not here)', () => {
    const out = composeBuyerAddress({
      addressLine1: '๙๙/๑ ถนนพระราม ๔',
      addressLine2: null,
      subDistrict: null,
      city: 'คลองเตย',
      province: 'กรุงเทพมหานคร',
      postalCode: '๑๐๑๑๐',
      country: 'TH',
    });
    expect(out).toBe('๙๙/๑ ถนนพระราม ๔\nคลองเตย กรุงเทพมหานคร ๑๐๑๑๐');
  });

  it('places the sub-district before the district on the locality line', () => {
    expect(
      composeBuyerAddress({
        addressLine1: '123 ถนนสุขุมวิท',
        addressLine2: null,
        subDistrict: 'คลองตันเหนือ',
        city: 'เขตวัฒนา',
        province: 'กรุงเทพมหานคร',
        postalCode: '10110',
        country: 'TH',
      }),
    ).toBe('123 ถนนสุขุมวิท\nคลองตันเหนือ เขตวัฒนา กรุงเทพมหานคร 10110');
  });

  it('drops a blank sub-district without leaving a double space', () => {
    expect(
      composeBuyerAddress({
        addressLine1: '123 Sukhumvit Rd',
        addressLine2: null,
        subDistrict: null,
        city: 'Watthana',
        province: 'Bangkok',
        postalCode: '10110',
        country: 'TH',
      }),
    ).toBe('123 Sukhumvit Rd\nWatthana Bangkok 10110');
  });
});

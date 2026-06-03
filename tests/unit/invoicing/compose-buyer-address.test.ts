/**
 * Unit tests for composeBuyerAddress (F4 invoice/receipt buyer block).
 *
 * Locks the §86/§87 full-address composition: real structured parts render
 * as a multi-line block; the country is always the last line; an address-less
 * member degrades to the bare country code (non-empty invariant preserved so
 * the snapshot schema's `address: string.min(1)` never rejects).
 */
import { describe, expect, it } from 'vitest';
import { composeBuyerAddress } from '@/modules/invoicing/infrastructure/adapters/compose-buyer-address';

describe('composeBuyerAddress', () => {
  it('composes a full DOMESTIC (TH) address — line1 / line2 / locality, country suppressed (L-01)', () => {
    const out = composeBuyerAddress({
      addressLine1: '99/1 Rama IV Road',
      addressLine2: 'Unit 12B',
      city: 'Khlong Toei',
      province: 'Bangkok',
      postalCode: '10110',
      country: 'TH',
    });
    // Trailing "TH" is redundant on a domestic Thai tax invoice.
    expect(out).toBe('99/1 Rama IV Road\nUnit 12B\nKhlong Toei Bangkok 10110');
  });

  it('FOREIGN member with street parts keeps the country line', () => {
    const out = composeBuyerAddress({
      addressLine1: 'Kungsgatan 1',
      addressLine2: null,
      city: 'Stockholm',
      province: null,
      postalCode: '11143',
      country: 'SE',
    });
    expect(out).toBe('Kungsgatan 1\nStockholm 11143\nSE');
  });

  it('drops missing parts without leaving dangling separators (TH domestic)', () => {
    const out = composeBuyerAddress({
      addressLine1: '500 Sukhumvit',
      addressLine2: null,
      city: null,
      province: 'Bangkok',
      postalCode: '10250',
      country: 'TH',
    });
    expect(out).toBe('500 Sukhumvit\nBangkok 10250');
  });

  it('falls back to the bare country code when no street parts exist (non-empty invariant)', () => {
    const out = composeBuyerAddress({
      addressLine1: null,
      addressLine2: null,
      city: null,
      province: null,
      postalCode: null,
      country: 'SE',
    });
    expect(out).toBe('SE');
  });

  it('TH with no street parts still keeps the bare country (no street → not suppressed)', () => {
    const out = composeBuyerAddress({
      addressLine1: null,
      addressLine2: null,
      city: null,
      province: null,
      postalCode: null,
      country: 'TH',
    });
    expect(out).toBe('TH');
  });

  it('treats blank/whitespace-only parts as missing', () => {
    const out = composeBuyerAddress({
      addressLine1: '  ',
      addressLine2: '',
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
      city: 'คลองเตย',
      province: 'กรุงเทพมหานคร',
      postalCode: '๑๐๑๑๐',
      country: 'TH',
    });
    expect(out).toBe('๙๙/๑ ถนนพระราม ๔\nคลองเตย กรุงเทพมหานคร ๑๐๑๑๐');
  });
});

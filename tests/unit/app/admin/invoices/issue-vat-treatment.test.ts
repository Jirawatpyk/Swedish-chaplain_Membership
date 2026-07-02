/**
 * 088 US8 (UX-A) — pure decision logic for the issue-invoice zero-rate form.
 *
 * Deterministic unit coverage for the fail-closed cert validation (layer 1),
 * the exact POST body shape (standard = empty; zero-rate = triplet, scan
 * omitted), and the ≥ 5,000 THB advisory trigger. The component test
 * (issue-invoice-form.test.tsx) covers the DOM wiring on top of these.
 */
import { describe, expect, it } from 'vitest';
import {
  buildIssueRequestBody,
  hasZeroRateCertError,
  isZeroRateLowAmount,
  validateZeroRateCert,
  ZERO_RATE_MIN_SUBTOTAL_SATANG,
} from '@/app/(staff)/admin/invoices/_lib/issue-vat-treatment';

describe('validateZeroRateCert — fail-closed layer 1 (FR-024)', () => {
  it('is inert for a standard-rate issue (nothing to validate)', () => {
    expect(
      validateZeroRateCert({ vatTreatment: 'standard', certNo: '', certDate: '' }),
    ).toEqual({ certNo: null, certDate: null });
  });

  it('blocks a zero-rated issue with a blank cert number', () => {
    const errors = validateZeroRateCert({
      vatTreatment: 'zero_rated_80_1_5',
      certNo: '   ',
      certDate: '',
    });
    expect(errors.certNo).toBe('certNoRequired');
    expect(hasZeroRateCertError(errors)).toBe(true);
  });

  it('passes a zero-rated issue once a cert number is present', () => {
    const errors = validateZeroRateCert({
      vatTreatment: 'zero_rated_80_1_5',
      certNo: 'กต 0404/1234',
      certDate: '',
    });
    expect(errors).toEqual({ certNo: null, certDate: null });
    expect(hasZeroRateCertError(errors)).toBe(false);
  });

  it('flags a malformed cert date but only when one is entered', () => {
    expect(
      validateZeroRateCert({
        vatTreatment: 'zero_rated_80_1_5',
        certNo: 'กต 0404/1234',
        certDate: '2026/01/02',
      }).certDate,
    ).toBe('certDateFormat');
    expect(
      validateZeroRateCert({
        vatTreatment: 'zero_rated_80_1_5',
        certNo: 'กต 0404/1234',
        certDate: '2026-01-02',
      }).certDate,
    ).toBeNull();
  });
});

describe('buildIssueRequestBody — POST body shape', () => {
  it('returns null (empty POST) when the flag is off, even if zero-rate chosen', () => {
    expect(
      buildIssueRequestBody({
        taxAtPayment: false,
        vatTreatment: 'zero_rated_80_1_5',
        certNo: 'กต 0404/1',
        certDate: '2026-01-02',
      }),
    ).toBeNull();
  });

  it('returns null (empty POST) for a standard-rate issue under the flag', () => {
    expect(
      buildIssueRequestBody({
        taxAtPayment: true,
        vatTreatment: 'standard',
        certNo: '',
        certDate: '',
      }),
    ).toBeNull();
  });

  it('carries vat_treatment + cert number (+ date) for a zero-rated issue', () => {
    expect(
      buildIssueRequestBody({
        taxAtPayment: true,
        vatTreatment: 'zero_rated_80_1_5',
        certNo: '  กต 0404/1234  ',
        certDate: '  2026-01-02  ',
      }),
    ).toEqual({
      vatTreatment: 'zero_rated_80_1_5',
      zeroRateCertNo: 'กต 0404/1234',
      zeroRateCertDate: '2026-01-02',
    });
  });

  it('omits the cert date when the admin left it blank', () => {
    const body = buildIssueRequestBody({
      taxAtPayment: true,
      vatTreatment: 'zero_rated_80_1_5',
      certNo: 'กต 0404/1234',
      certDate: '',
    });
    expect(body).toEqual({
      vatTreatment: 'zero_rated_80_1_5',
      zeroRateCertNo: 'กต 0404/1234',
    });
    expect(body && 'zeroRateCertDate' in body).toBe(false);
  });

  it('never sends the scan blob key (UX-B)', () => {
    const body = buildIssueRequestBody({
      taxAtPayment: true,
      vatTreatment: 'zero_rated_80_1_5',
      certNo: 'กต 0404/1234',
      certDate: '2026-01-02',
    });
    expect(body && 'zeroRateCertBlobKey' in body).toBe(false);
  });
});

describe('isZeroRateLowAmount — ≥ 5,000 THB advisory', () => {
  it('mirrors the domain threshold (500,000 satang = 5,000 THB)', () => {
    expect(ZERO_RATE_MIN_SUBTOTAL_SATANG).toBe(500_000);
  });

  it('warns only for a zero-rated sale below the threshold', () => {
    expect(isZeroRateLowAmount('zero_rated_80_1_5', 499_900)).toBe(true);
    expect(isZeroRateLowAmount('zero_rated_80_1_5', 500_000)).toBe(false); // at threshold = no warn
    expect(isZeroRateLowAmount('zero_rated_80_1_5', 800_000)).toBe(false);
  });

  it('never warns for a standard sale or an unknown subtotal', () => {
    expect(isZeroRateLowAmount('standard', 100_000)).toBe(false);
    expect(isZeroRateLowAmount('zero_rated_80_1_5', null)).toBe(false);
  });
});

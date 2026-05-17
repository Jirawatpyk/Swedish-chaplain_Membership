/**
 * R8.W / Staff R3 R056 — unit tests for `sanitiseFormulaPrefix`
 * (OWASP CSV-Injection sanitiser used by `serialiseErrorCsv`).
 *
 * Production caller: `src/modules/events/application/use-cases/import-csv.ts`
 * @ line 1906-1907 (reason + failureStage cells of the error-CSV row).
 *
 * R044 (R7.S / Staff R2) extended the original 4-char guard
 * (`=`, `+`, `-`, `@`) with LibreOffice Calc triggers (`\t`, `\r`).
 * Prior to this test, the new code paths were COMPLETELY untested.
 * A future change that dropped a guard char (or accidentally inverted
 * the if-condition) would silently regress the CSV-injection
 * mitigation.
 *
 * Coverage matrix: 8 cases — every guarded char + benign string +
 * empty string. Asserts:
 *   - guarded chars: output is `'`-prefixed verbatim.
 *   - benign string: output equals input (pass-through).
 *   - empty string: output equals input (no prefix on empty).
 */
import { describe, it, expect } from 'vitest';
import { _internals } from '@/modules/events/application/use-cases/import-csv';

const { sanitiseFormulaPrefix } = _internals;

describe('R8.W / R056 — sanitiseFormulaPrefix OWASP CSV-Injection sanitiser', () => {
  it('prefixes single-quote on `=` (formula trigger — Excel + LibreOffice)', () => {
    expect(sanitiseFormulaPrefix('=SUM(A1:A10)')).toBe("'=SUM(A1:A10)");
  });

  it('prefixes single-quote on `+` (Excel formula trigger)', () => {
    expect(sanitiseFormulaPrefix('+1234567890')).toBe("'+1234567890");
  });

  it('prefixes single-quote on `-` (Excel formula trigger)', () => {
    expect(sanitiseFormulaPrefix('-cmd|"calc"')).toBe('\'-cmd|"calc"');
  });

  it('prefixes single-quote on `@` (Excel formula trigger, legacy LOTUS)', () => {
    expect(sanitiseFormulaPrefix('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('R044 — prefixes single-quote on `\\t` (LibreOffice Calc trigger)', () => {
    expect(sanitiseFormulaPrefix('\t=SUM(A1)')).toBe("'\t=SUM(A1)");
  });

  it('R044 — prefixes single-quote on `\\r` (LibreOffice Calc trigger)', () => {
    expect(sanitiseFormulaPrefix('\rmalicious')).toBe("'\rmalicious");
  });

  it('passes through benign string (no leading formula char)', () => {
    expect(sanitiseFormulaPrefix('attendee_email is not a valid email')).toBe(
      'attendee_email is not a valid email',
    );
  });

  it('passes through empty string (no prefix added — edge case)', () => {
    expect(sanitiseFormulaPrefix('')).toBe('');
  });

  // Bonus coverage — second character is irrelevant; only the FIRST
  // char is checked. Prevents a future regression that accidentally
  // sanitises mid-string formula chars.
  it('only checks first char — does NOT prefix when formula char appears mid-string', () => {
    expect(sanitiseFormulaPrefix('value=ok')).toBe('value=ok');
    expect(sanitiseFormulaPrefix('a+b')).toBe('a+b');
    expect(sanitiseFormulaPrefix('x@y.com')).toBe('x@y.com');
  });
});

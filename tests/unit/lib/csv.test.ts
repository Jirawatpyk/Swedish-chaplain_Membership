/**
 * `toCsvField` unit test — RFC-4180 escaping + CSV formula-injection defang
 * (F9 US2 audit export security finding T-F9-01).
 */
import { describe, expect, it } from 'vitest';
import { isCsvFormulaInjection, toCsvField } from '@/lib/csv';

describe('toCsvField', () => {
  it('always quotes + doubles embedded quotes (RFC-4180)', () => {
    expect(toCsvField('plain')).toBe('"plain"');
    expect(toCsvField('a "quoted" b')).toBe('"a ""quoted"" b"');
  });

  it('neutralises formula-trigger leading chars by prefixing a single quote', () => {
    expect(toCsvField('=cmd()')).toBe(`"'=cmd()"`);
    expect(toCsvField('+1')).toBe(`"'+1"`);
    expect(toCsvField('-2')).toBe(`"'-2"`);
    expect(toCsvField('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(toCsvField('\tTAB')).toBe(`"'\tTAB"`);
  });

  it('does not touch values that merely contain (not lead with) a trigger char', () => {
    expect(toCsvField('value=1')).toBe('"value=1"');
    expect(toCsvField('a@b')).toBe('"a@b"');
  });

  it('isCsvFormulaInjection flags only leading triggers', () => {
    expect(isCsvFormulaInjection('=x')).toBe(true);
    expect(isCsvFormulaInjection('x=y')).toBe(false);
    expect(isCsvFormulaInjection('')).toBe(false);
  });
});

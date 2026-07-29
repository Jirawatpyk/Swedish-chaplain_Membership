/**
 * Round-3 post-import verifier — pure helper unit tests (Part 3;
 * docs/import/ROUND3_PLAN.md § Verify).
 *
 * Covers the three pure checks the read-only verifier CLI
 * (scripts/verify-round3-import.ts) builds its assertions from:
 *   - parseDocNumberRaw    — {PREFIX}-{YYYY}-{NNNNNN} document numbers
 *   - findMemberNumberProblems — 1..N gapless member_number invariant
 *   - checkSequenceConsistency — tenant_document_sequences vs minted maxima
 */
import { describe, expect, it } from 'vitest';
import {
  checkSequenceConsistency,
  findMemberNumberProblems,
  parseDocNumberRaw,
} from '@/../scripts/import-round3/verify-helpers';

describe('parseDocNumberRaw', () => {
  it('parses a bill number', () => {
    expect(parseDocNumberRaw('SC-2026-000123')).toEqual({
      prefix: 'SC',
      fiscalYear: 2026,
      seq: 123,
    });
  });

  it('parses a receipt number', () => {
    expect(parseDocNumberRaw('RC-2025-000001')).toEqual({
      prefix: 'RC',
      fiscalYear: 2025,
      seq: 1,
    });
  });

  it.each([
    ['short year', 'SC-26-000123'],
    ['short seq', 'SC-2026-123'],
    ['lowercase prefix', 'sc-2026-000123'],
    ['no prefix', '-2026-000123'],
    ['empty', ''],
    ['trailing junk', 'SC-2026-000123x'],
  ])('rejects %s', (_label, raw) => {
    expect(parseDocNumberRaw(raw)).toBeNull();
  });
});

describe('findMemberNumberProblems', () => {
  it('accepts a gapless 1..N set', () => {
    expect(findMemberNumberProblems([3, 1, 2], 3)).toEqual([]);
  });

  it('reports a duplicate and the missing number it displaced', () => {
    const problems = findMemberNumberProblems([1, 1, 3], 3);
    expect(problems.join('\n')).toMatch(/duplicate member_number 1/);
    expect(problems.join('\n')).toMatch(/missing member_number 2/);
  });

  it('reports numbers outside 1..N', () => {
    const problems = findMemberNumberProblems([1, 2, 4], 3);
    expect(problems.join('\n')).toMatch(/out-of-range member_number 4/);
    expect(problems.join('\n')).toMatch(/missing member_number 3/);
  });

  it('reports zero / negative numbers as out of range', () => {
    const problems = findMemberNumberProblems([0, 1, 2], 2);
    expect(problems.join('\n')).toMatch(/out-of-range member_number 0/);
  });

  it('caps the missing-number listing (large gap stays readable)', () => {
    const problems = findMemberNumberProblems([1], 150);
    // 149 missing numbers must not produce 149 lines.
    expect(problems.length).toBeLessThanOrEqual(25);
    expect(problems.join('\n')).toMatch(/missing/);
  });
});

describe('checkSequenceConsistency', () => {
  const minted = (
    entries: ReadonlyArray<readonly [string, number, number]>,
  ): ReadonlyMap<string, ReadonlyMap<number, number>> => {
    const outer = new Map<string, Map<number, number>>();
    for (const [type, fy, max] of entries) {
      const inner = outer.get(type) ?? new Map<number, number>();
      inner.set(fy, max);
      outer.set(type, inner);
    }
    return outer;
  };

  it('accepts next = max minted + 1 on every stream', () => {
    const problems = checkSequenceConsistency(
      [
        { documentType: 'bill', fiscalYear: 2026, nextSequenceNumber: 3 },
        { documentType: 'bill', fiscalYear: 2025, nextSequenceNumber: 2 },
        { documentType: 'receipt', fiscalYear: 2026, nextSequenceNumber: 2 },
      ],
      minted([
        ['bill', 2026, 2],
        ['bill', 2025, 1],
        ['receipt', 2026, 1],
      ]),
    );
    expect(problems).toEqual([]);
  });

  it('flags next <= max minted (re-mint collision risk)', () => {
    const problems = checkSequenceConsistency(
      [{ documentType: 'bill', fiscalYear: 2026, nextSequenceNumber: 2 }],
      minted([['bill', 2026, 2]]),
    );
    expect(problems.join('\n')).toMatch(/bill FY2026/);
    expect(problems.join('\n')).toMatch(/expected 3/);
  });

  it('flags minted documents with NO sequence row', () => {
    const problems = checkSequenceConsistency([], minted([['receipt', 2025, 4]]));
    expect(problems.join('\n')).toMatch(/receipt FY2025/);
    expect(problems.join('\n')).toMatch(/no tenant_document_sequences row/);
  });

  it('accepts a bootstrap row (next=1) with nothing minted, flags next>1', () => {
    expect(
      checkSequenceConsistency(
        [{ documentType: 'bill', fiscalYear: 2027, nextSequenceNumber: 1 }],
        minted([]),
      ),
    ).toEqual([]);
    expect(
      checkSequenceConsistency(
        [{ documentType: 'bill', fiscalYear: 2027, nextSequenceNumber: 5 }],
        minted([]),
      ).join('\n'),
    ).toMatch(/bill FY2027/);
  });

  it('ignores streams other than bill/receipt', () => {
    expect(
      checkSequenceConsistency(
        [{ documentType: 'credit_note', fiscalYear: 2026, nextSequenceNumber: 9 }],
        minted([]),
      ),
    ).toEqual([]);
  });
});

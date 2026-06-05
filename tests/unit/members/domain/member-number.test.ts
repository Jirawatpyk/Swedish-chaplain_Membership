import { describe, expect, it } from 'vitest';
import {
  asMemberNumber,
  InvalidMemberNumberError,
  type MemberNumber,
} from '@/modules/members/domain/value-objects/member-number';

describe('asMemberNumber — branded positive-integer constructor', () => {
  it('accepts a positive integer and returns it branded', () => {
    const n = asMemberNumber(42);
    // brand is compile-time only; at runtime the value is the plain number
    expect(n).toBe(42);
  });

  it('accepts 1 (lower boundary)', () => {
    expect(asMemberNumber(1)).toBe(1);
  });

  it('rejects 0 with InvalidMemberNumberError', () => {
    expect(() => asMemberNumber(0)).toThrow(InvalidMemberNumberError);
  });

  it('rejects a negative integer (-1)', () => {
    expect(() => asMemberNumber(-1)).toThrow(InvalidMemberNumberError);
  });

  it('rejects a non-integer (1.5)', () => {
    expect(() => asMemberNumber(1.5)).toThrow(InvalidMemberNumberError);
  });

  it('rejects NaN', () => {
    expect(() => asMemberNumber(Number.NaN)).toThrow(InvalidMemberNumberError);
  });

  it('error carries the offending value for diagnostics', () => {
    try {
      asMemberNumber(0);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidMemberNumberError);
      expect((e as InvalidMemberNumberError).value).toBe(0);
    }
  });
});

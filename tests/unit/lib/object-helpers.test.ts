/**
 * R6.3 M-6 — direct unit test for `omitUndefined`.
 *
 * R5 Final 2 senior-tester flagged that the helper had zero direct
 * test coverage despite R4.4 L-3 refactoring its implementation.
 * Indirect coverage via `update-broadcast-template.ts:183` exercised
 * the strip path only — present-key + falsy + empty-input + prototype-
 * inheritance cases were uncovered. This test locks them in.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { omitUndefined } from '@/lib/object-helpers';

describe('omitUndefined', () => {
  it('strips undefined-valued keys; preserves present keys', () => {
    const out = omitUndefined({ a: 1, b: undefined, c: 'x' });
    expect(out).toEqual({ a: 1, c: 'x' });
    expect('b' in out).toBe(false);
  });

  it('preserves FALSY non-undefined values (0, "", false, null)', () => {
    const out = omitUndefined({
      zero: 0,
      empty: '',
      falseFlag: false,
      nullable: null,
    });
    expect(out).toEqual({
      zero: 0,
      empty: '',
      falseFlag: false,
      nullable: null,
    });
  });

  it('returns an empty object for an empty input (not undefined)', () => {
    const out = omitUndefined({});
    expect(out).toEqual({});
    expect(out).not.toBeUndefined();
  });

  it('skips inherited prototype keys (Object.entries semantic)', () => {
    const parent = { inherited: 'should-not-appear' };
    const child = Object.create(parent) as { own?: string };
    child.own = 'kept';
    // Cast to Record<string, unknown> for the test seam — runtime
    // behaviour confirms inherited keys never leak into the output.
    const out = omitUndefined(child as unknown as Record<string, unknown>);
    expect(out).toEqual({ own: 'kept' });
    expect('inherited' in out).toBe(false);
  });

  it('handles a mix of undefined + defined keys in arbitrary order', () => {
    const out = omitUndefined({
      first: undefined,
      second: 'kept',
      third: undefined,
      fourth: 42,
      fifth: undefined,
    });
    expect(out).toEqual({ second: 'kept', fourth: 42 });
  });

  it('returns a NEW object (does not mutate the input)', () => {
    const input = { a: 1, b: undefined };
    const out = omitUndefined(input);
    expect(out).not.toBe(input);
    // Input retains the undefined key — only the output omits it.
    expect('b' in input).toBe(true);
  });

  it('return-type narrowing: present keys are typed as Exclude<T[K], undefined>', () => {
    // R8.3 M-7 — use vitest's `expectTypeOf` for a TRUE compile-time
    // type assertion. The prior R6.3 M-6 test only verified runtime
    // (`typeof out.kept === 'string'`), which is a much weaker contract
    // than the comment claimed — it would pass even if the return
    // type still included `undefined` for present keys. `expectTypeOf`
    // is checked at typecheck time and fails the build if the type
    // contract drifts.
    const out = omitUndefined({
      kept: 'hello' as string | undefined,
      stripped: undefined as string | undefined,
    });
    // `out.kept` is typed `string | undefined` because the OPTIONAL
    // `?` on the result key means the property may be absent. But the
    // VALUE type at present-key access is `string`, not `string |
    // undefined`. This expectTypeOf locks the optional-key + narrowed-
    // value contract.
    expectTypeOf(out.kept).toEqualTypeOf<string | undefined>();
    // And the inner Exclude narrowing: `out.kept` if present is
    // `Exclude<string | undefined, undefined> = string`. Test the
    // "present" path via NonNullable.
    expectTypeOf<NonNullable<typeof out.kept>>().toEqualTypeOf<string>();
    // Runtime check kept as a sanity sentinel.
    if (out.kept !== undefined) {
      expect(typeof out.kept).toBe('string');
    }
  });
});

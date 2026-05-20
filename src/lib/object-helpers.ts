/**
 * Phase 5 Round 1 R2.2 D4 — Object helpers.
 *
 * `omitUndefined` — strip keys whose value is exactly `undefined`
 * from a record. Replaces the verbose `...(x ? {key: x} : {})`
 * pattern at conditional-spread sites:
 *
 *     // before:
 *     const patch = {
 *       ...(input.name !== undefined ? { name: input.name } : {}),
 *       ...(input.subject !== undefined ? { subject: input.subject } : {}),
 *     };
 *
 *     // after:
 *     const patch = omitUndefined({
 *       name: input.name,
 *       subject: input.subject,
 *     });
 *
 * `exactOptionalPropertyTypes: true` in tsconfig already enforces that
 * callers don't pass `undefined` to omitted-optional fields — this
 * helper handles the runtime-strip step when the source object's
 * fields ARE typed as `T | undefined` (a deliberate input shape, not
 * a tsconfig gap).
 *
 * Preserves type-narrowing via `Partial<T>`: callers get back a
 * subset of the input shape (some keys may be absent) without losing
 * static knowledge of which keys CAN appear.
 */

/**
 * R3.6 L-2 — tightened return type from `Partial<T>` to
 * `{ [K in keyof T]?: Exclude<T[K], undefined> }`. The function
 * runtime-guarantees that present keys have non-undefined values;
 * the return type now reflects that work (callers see the stripped
 * type, not `T[K] | undefined`).
 *
 * R4.4 L-3 — re-implemented via `Object.entries` + `reduce` to drop
 * the inner `as Exclude<…>` cast that widened the right-hand side
 * across all string keys.
 *
 * R6.5 M-13 + L-2 — narrowed the cast back to per-value (closer to
 * the original R3.6 shape) so the type assertion only widens the
 * VALUE the runtime guard has just narrowed, not the entire
 * accumulator. Iteration via `Object.entries` covers OWN-ENUMERABLE-
 * STRING-KEYED properties only; symbol keys + inherited prototype
 * properties are dropped silently. The `T extends Record<string,
 * unknown>` constraint statically forbids symbol keys, so the
 * runtime semantic matches the typed contract.
 */
export function omitUndefined<T extends Record<string, unknown>>(
  input: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: { [K in keyof T]?: Exclude<T[K], undefined> } = {};
  for (const [key, value] of Object.entries(input) as Array<
    [keyof T, T[keyof T]]
  >) {
    if (value !== undefined) {
      // R6.5 M-13 — per-value cast: the runtime `!== undefined` guard
      // narrows `value`, so the assertion only papers over what TS
      // can't propagate through the bound iteration variable. Narrower
      // than the R4.4 wrap-the-whole-accumulator approach.
      out[key] = value as Exclude<T[keyof T], undefined>;
    }
  }
  return out;
}

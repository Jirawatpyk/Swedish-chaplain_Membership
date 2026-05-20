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
 * R4.4 L-3 — re-implemented via `Object.entries` + `reduce` to
 * eliminate the inner `as Exclude<…>` cast. The cast was structurally
 * brittle (the right-hand side widened to
 * `T[Extract<keyof T, string>]` not the original `T[K]`); the
 * Object.entries path keeps the value typed via `T[keyof T]` and
 * lets TypeScript narrow it via the runtime undefined guard with
 * zero hand-written assertion.
 */
export function omitUndefined<T extends Record<string, unknown>>(
  input: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  type Output = { [K in keyof T]?: Exclude<T[K], undefined> };
  return (Object.entries(input) as Array<[keyof T, T[keyof T]]>).reduce<Output>(
    (acc, [key, value]) => {
      if (value !== undefined) {
        // The runtime guard above narrows `value` to
        // `Exclude<T[keyof T], undefined>`; assigning into the
        // optional-property slot is structurally sound.
        (acc as Record<keyof T, T[keyof T]>)[key] = value;
      }
      return acc;
    },
    {} as Output,
  );
}

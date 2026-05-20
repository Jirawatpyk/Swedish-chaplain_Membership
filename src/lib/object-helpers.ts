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
 */
export function omitUndefined<T extends Record<string, unknown>>(
  input: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: { [K in keyof T]?: Exclude<T[K], undefined> } = {};
  for (const k in input) {
    if (Object.prototype.hasOwnProperty.call(input, k)) {
      const v = input[k];
      if (v !== undefined) {
        // Cast widens the assignment to satisfy the tightened return
        // type — the key's value type is by construction
        // Exclude<T[K], undefined> (NOT T[K] | undefined since we
        // just guarded above).
        out[k] = v as Exclude<T[Extract<keyof T, string>], undefined>;
      }
    }
  }
  return out;
}

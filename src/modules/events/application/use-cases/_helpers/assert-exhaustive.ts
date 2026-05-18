/**
 * R3-F2 (2026-05-18 /speckit-review Round 3 Final) — exhaustiveness
 * assertion helper for `switch` statements over discriminated unions.
 *
 * Replaces the 2-line `const _exhaustive: never = x; void _exhaustive;`
 * pattern used at 5 sites in F6 with a single function call. Pure
 * compile-time check — does NOT throw at runtime so callers retain
 * their existing fall-through return / log / continue semantics
 * (different from `assertNeverAuditEvent` in F3 which throws).
 *
 * Usage:
 * ```ts
 * switch (e.kind) {
 *   case 'db_error': return e.message;
 *   case 'invariant_violation': return e.invariant;
 *   default:
 *     assertExhaustive(e); // compile-error here if a new variant is added
 *     return `unknown: ${JSON.stringify(e)}`;
 * }
 * ```
 *
 * If a future addition to the union is unhandled, the compiler infers
 * the `default` branch's `e` as the unhandled variant (not `never`) and
 * `assertExhaustive(e)` becomes `assertExhaustive(<unhandled variant>)`
 * which fails the build because the variant is not assignable to
 * `never`. This is exactly the same compile-time enforcement as the
 * pre-R3-F2 pattern, in a single line.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
export function assertExhaustive(value: never): void {
  void value;
}

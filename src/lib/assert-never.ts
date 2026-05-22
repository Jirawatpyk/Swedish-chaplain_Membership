/**
 * `assertNever` — exhaustive-narrowing helper for discriminated unions.
 *
 * Place in the default branch of a `switch (kind)` over a DU so a new
 * variant fails typecheck at the switch site (the compiler reports
 * "Argument of type 'NewKind' is not assignable to parameter of type
 * 'never'"). Forces explicit handling instead of silent fall-through.
 *
 * PR-review fix 2026-05-20 TD-M4 — replaces ad-hoc
 * `const _exhaustive: never = result.error` patterns scattered across
 * route handlers (admin allowlist + member upload). Single import.
 *
 * Throws at runtime if reached unexpectedly (defensive — type system
 * already guarantees unreachable, but a generated bug or `as any`
 * cast could route past the type check at compile time).
 *
 * Pure helper — no framework imports.
 */
export function assertNever(value: never, message?: string): never {
  throw new Error(
    message ??
      `assertNever: unexpected value ${JSON.stringify(value)} — discriminated union missing a case`,
  );
}

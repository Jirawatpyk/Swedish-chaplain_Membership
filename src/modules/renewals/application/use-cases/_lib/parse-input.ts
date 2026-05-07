/**
 * F8 Phase 5 review backlog close — `parseInput` + `mapZodFirstIssue`
 * helpers extracted from the duplicated zod-error-mapping boilerplate
 * across most F8 use-cases (~18 inline `safeParse` callsites at the
 * time of extraction). 5 of those callsites have adopted this helper
 * (4 in commit `d4afa438` — block / unblock / opt-in / opt-out — plus
 * `reconcile-pending-reactivations` adopted in Round 2 Wave K18).
 * New use-cases SHOULD adopt this helper to keep the surface uniform;
 * the remaining inline callsites will migrate opportunistically as
 * they're touched for other reasons.
 *
 * Why a helper at all:
 *   - One canonical "what does invalid_input error look like?" answer
 *     for new code, instead of 12 hand-rolled copies that drift over
 *     time (different fallback strings, different field shapes).
 *   - Makes the error-shape contract grep-able (`kind: 'invalid_input'`).
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */

import { err, ok, type Result } from '@/lib/result';
import type { ZodType } from 'zod';

/**
 * Standard `invalid_input` error variant. Every F8 use-case error
 * union includes a member of this shape; the helper produces it
 * directly so callers can `return err(inputResult.error)` when the
 * outer error union is broader.
 */
export interface InvalidInputError {
  readonly kind: 'invalid_input';
  readonly message: string;
}

/**
 * Parse the raw input through the given zod schema. Returns:
 *   - `ok(input)` on success
 *   - `err({ kind: 'invalid_input', message })` on failure, where
 *     `message` is the FIRST issue's message (matches the
 *     pre-extraction inline pattern across all F8 use-cases) and
 *     falls back to `'invalid input'` if the schema produced no
 *     issues (defensive — should never happen for well-formed schemas).
 *
 * Use as:
 * ```ts
 * const inputResult = parseInput(myInputSchema, rawInput);
 * if (!inputResult.ok) return err(inputResult.error);
 * const input = inputResult.value;
 * ```
 *
 * The helper is intentionally narrow — it does NOT widen to the
 * caller's full error union (`MyUseCaseError`). That would require
 * generics over the union shape and obscure intent. Caller widens at
 * the `return err(...)` site, which keeps the use-case's error
 * variants visible at the call site.
 */
export function parseInput<T>(
  schema: ZodType<T>,
  raw: unknown,
): Result<T, InvalidInputError> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return err({
      kind: 'invalid_input',
      message: mapZodFirstIssue(parsed.error.issues),
    });
  }
  return ok(parsed.data);
}

/**
 * Extract the first zod issue's message with a `'invalid input'`
 * fallback. Exposed separately so use-cases that want to keep their
 * inline `safeParse` (for non-input schemas — e.g. payload-shape
 * validation in audit emitters) can still adopt the canonical
 * fallback string without pulling in `parseInput`.
 */
export function mapZodFirstIssue(
  issues: ReadonlyArray<{ readonly message: string }>,
): string {
  return issues[0]?.message ?? 'invalid input';
}

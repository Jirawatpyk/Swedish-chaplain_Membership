/**
 * The READ_ONLY_MODE refusal, read from a JSON error body — one place.
 *
 * A mutation refused while the emergency write freeze is on (`READ_ONLY_MODE`
 * in Vercel env, quickstart § 7.3) comes back in TWO shapes, and which one a
 * caller sees depends on WHICH layer refused:
 *
 *   - the proxy-level gate (`src/proxy.ts`) emits the FLAT hyphenated string
 *     `{ error: 'read-only-mode' }`;
 *   - a route-level guard (`src/app/api/plans/_read-only-guard.ts` and its
 *     siblings) emits the NESTED underscored `{ error: { code: 'read_only_mode' } }`.
 *
 * Six client components carried their own copy of that narrowing (PR-3 review
 * B7): `approval-switch.tsx`, `plans-table.tsx`, `invoice-settings-form.tsx`,
 * `clone-year-client.tsx`, `new-plan-client.tsx`, `edit-plan-client.tsx`. Each
 * copy had to get BOTH shapes and BOTH spellings right, and a seventh caller
 * getting one of the four wrong shows the operator "save failed, try again"
 * during a freeze — advice that cannot work until the freeze lifts.
 *
 * {@link readProblemCode} is the narrowing on its own: the code plus WHICH
 * envelope carried it. {@link problemCode} is the shape-blind reading of the
 * same thing. Callers that branch on OTHER codes
 * (`plan_has_active_members`, `vat_rate_out_of_range`, …) read the code once
 * through it and pass it to {@link isReadOnlyCode}; a caller that only asks
 * "was this the freeze?" uses {@link isReadOnlyRefusal}, which also requires
 * the 503.
 *
 * Pure and dependency-free on purpose — every caller is a client component.
 */

/** The two spellings of the same refusal — see the module docblock. */
const READ_ONLY_CODES: readonly string[] = ['read_only_mode', 'read-only-mode'];

/**
 * A problem code plus WHICH of the two envelopes carried it.
 *
 * The shape is not decoration: it says which layer refused. Our route handlers
 * answer the flat `{ error: 'code' }` themselves; the nested
 * `{ error: { code } }` comes from a guard in front of them
 * (`requireMemberContext`, `readOnlyModeResponse`, the proxy's route-level
 * gates). A caller that must tell "the route answered my own 404" from "a
 * guard answered a 404 for a different reason" reads the shape — the withdraw
 * banner does exactly that (PR-3 review A1), because the two spell the code
 * `not_found` identically and mean opposite things.
 */
export type ProblemCode = { readonly code: string; readonly shape: 'flat' | 'nested' };

/**
 * The problem code of a parsed JSON error body WITH its envelope shape, or
 * `null`.
 *
 * Accepts `unknown` rather than a hand-written body type: the value comes
 * from `res.json()`, which can answer anything at all (a proxy's HTML error
 * page parsed to `null`, a truncated body, a reshaped envelope). Anything
 * that is not one of the two envelopes is `null`, never a coerced string.
 */
export function readProblemCode(body: unknown): ProblemCode | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') return { code: error, shape: 'flat' };
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? { code, shape: 'nested' } : null;
}

/**
 * The normalised problem code of a parsed JSON error body, or `null` — the
 * shape-blind reading, for the ladders that only branch on the code.
 */
export function problemCode(body: unknown): string | null {
  return readProblemCode(body)?.code ?? null;
}

/** True when `code` is either spelling of the read-only-mode refusal. */
export function isReadOnlyCode(code: string | null | undefined): boolean {
  return code !== null && code !== undefined && READ_ONLY_CODES.includes(code);
}

/**
 * True when a **503** response body carries the read-only-mode refusal.
 *
 * The status is part of the question: a caller that reaches for this is asking
 * "is the write freeze on?", and only the 503 answers that. Callers that
 * branch on the code alone (because they also handle `not_found`,
 * `idempotency_conflict`, …) compose {@link problemCode} with
 * {@link isReadOnlyCode} instead — deliberately, so this helper does not
 * silently add a status condition to a ladder that never had one.
 */
export function isReadOnlyRefusal(status: number, body: unknown): boolean {
  return status === 503 && isReadOnlyCode(problemCode(body));
}

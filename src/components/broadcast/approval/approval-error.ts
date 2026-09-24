/**
 * F119 T063 / T064 — the one mapping from an approval-round route refusal to
 * the copy a staff user reads.
 *
 * The routes answer `{ error: { code, message, messageThai, fieldErrors? } }`.
 * The route's own `message` is English with a Thai twin and no Swedish, so the
 * client localises the CODE through `admin.broadcasts.approval.errors.*`
 * instead — and falls back to the translated generic line for a code it has
 * no key for. next-intl does not throw on a missing key (it returns the key
 * path), so the `has()` check is the fallback, not a `try/catch` (T155
 * finding U8).
 *
 * Framework-free on purpose: it takes the translator as a parameter.
 */

export interface RouteError {
  readonly code: string | null;
  /** zod's `flatten().fieldErrors` on a 400/422 — which field was refused. */
  readonly fields: readonly string[];
}

/** The refusal envelope of a response, tolerating a body that is not one. */
export async function readRouteError(res: Response): Promise<RouteError> {
  try {
    const body: unknown = await res.json();
    const error =
      typeof body === 'object' && body !== null
        ? (body as { error?: { code?: unknown; fieldErrors?: unknown } }).error
        : undefined;
    const code = typeof error?.code === 'string' ? error.code : null;
    const fieldErrors = error?.fieldErrors;
    const fields =
      typeof fieldErrors === 'object' && fieldErrors !== null ? Object.keys(fieldErrors) : [];
    return { code, fields };
  } catch {
    return { code: null, fields: [] };
  }
}

/** Just the `error.code`, or null when the body is not the envelope. */
export async function readErrorCode(res: Response): Promise<string | null> {
  return (await readRouteError(res)).code;
}

/** The subset of a next-intl translator this helper needs. */
export interface ErrorTranslator {
  (key: string): string;
  has(key: string): boolean;
}

/**
 * T166 follow-up — the 409 codes that refuse a send-time step WITHOUT moving
 * the row (the member's standing, re-read at approve-as-submitted and at the
 * promotion). The page is not stale, so a dialog stays open and says why
 * inside itself instead of closing on a toast.
 */
export const STANDING_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'member_halted',
  'member_not_in_good_standing',
]);

export function approvalErrorMessage(t: ErrorTranslator, code: string | null): string {
  if (code !== null && t.has(code)) return t(code);
  return t('generic');
}

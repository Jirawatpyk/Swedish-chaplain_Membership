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
  /** The envelope's `details` object (a 409's current stage, recorded decision, …), or null. */
  readonly details: Readonly<Record<string, unknown>> | null;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

/**
 * The refusal envelope of a response, tolerating a body that is not one.
 *
 * It reads only the NESTED `{ error: { code } }` envelope our routes answer.
 * The proxy's read-only 503 is the FLAT `{ error: 'read-only-mode' }` and
 * reads here as `code: null` — callers ask `isReadOnlyResponse(res)` (which
 * reads a clone) BEFORE this, as main #390 does on every member mutation.
 */
export async function readRouteError(res: Response): Promise<RouteError> {
  try {
    const body: unknown = await res.json();
    const error = isRecord(body) ? body.error : undefined;
    if (!isRecord(error)) return { code: null, fields: [], details: null };
    const code = typeof error.code === 'string' ? error.code : null;
    const fields = isRecord(error.fieldErrors) ? Object.keys(error.fieldErrors) : [];
    const details = isRecord(error.details) ? error.details : null;
    return { code, fields, details };
  } catch {
    return { code: null, fields: [], details: null };
  }
}

/**
 * PR #392 review C3 — does a 409 `stage_changed` carry THIS decision as the
 * one already recorded? A decision whose response was lost is retried, and the
 * retry is answered with the decision on file (contract § decision,
 * "Idempotency"). It was recorded when it names the same decision on the same
 * version; `recordedDecision` is the LATEST decision on the E-Blast, so a
 * same-kind decision from an earlier round must not count. And it must be the
 * caller's own (`byCaller`, review D6): a colleague at the same member who
 * recorded the same decision did not record THIS user's (or their reason).
 */
export function isRecordedDecision(
  details: RouteError['details'],
  decision: string,
  versionId: string,
): boolean {
  const recorded = details?.recordedDecision;
  return (
    isRecord(recorded) && recorded.decision === decision && recorded.versionId === versionId && recorded.byCaller === true
  );
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

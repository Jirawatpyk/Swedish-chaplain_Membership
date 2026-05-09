/**
 * F8 Phase 8 R10 S11 close — pure error-key dispatcher for the
 * escalation-task action toasts.
 *
 * Extracted from `escalation-task-queue.tsx` so the safeCode-narrowing
 * + per-action `forbidden` override + WIRE→`unknown` fallback have a
 * unit-testable seam (no React, no `useTranslations`). The component
 * imports `selectActionErrorKey` and feeds the returned key into its
 * `t(...)` call.
 *
 * Why pure: the dispatcher is pure logic over a closed wire-code
 * union — extracting it removes the need for a heavyweight
 * @testing-library/react render to exercise 8 wire codes × 3 actions
 * = 24 cases.
 */
export const WIRE_ERROR_CODES = [
  'task_not_open',
  'task_not_found',
  'feature_disabled',
  'forbidden',
  'unauthenticated',
  'invalid_input',
  'invalid_cursor',
  'server_error',
] as const;

export type WireErrorCode = (typeof WIRE_ERROR_CODES)[number];

export function isWireErrorCode(code: string): code is WireErrorCode {
  return (WIRE_ERROR_CODES as readonly string[]).includes(code);
}

export type TaskAction = 'done' | 'skip' | 'reassign';

/**
 * Resolves the i18n key for the given (action, rawCode) pair.
 *
 * Behaviour:
 *  - `'forbidden'` → per-action key `actions.<action>.errors.forbidden`
 *    (each action has its own forbidden copy explaining why the
 *    operation is blocked — e.g. manager can't Done).
 *  - `'offline'` (client-synthetic) → shared `actions.errors.offline`.
 *  - Any wire code in `WIRE_ERROR_CODES` → shared `actions.errors.<code>`.
 *  - Anything else (untrusted input from the server) → falls through
 *    to `actions.errors.unknown` (defence-in-depth).
 *
 * The shared `actions.errors.*` namespace was introduced in R8 HV-4 to
 * avoid 18 redundant key paths; this dispatcher is the canonical
 * decision point.
 */
export function selectActionErrorKey(
  action: TaskAction,
  rawCode: string,
): string {
  if (rawCode === 'forbidden') {
    return `actions.${action}.errors.forbidden`;
  }
  const safeCode: WireErrorCode | 'offline' | 'unknown' =
    rawCode === 'offline' || isWireErrorCode(rawCode) ? rawCode : 'unknown';
  return `actions.errors.${safeCode}`;
}

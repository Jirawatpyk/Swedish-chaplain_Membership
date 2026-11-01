/**
 * #57 / #58 — the issue-invoice and record-payment dialogs: which failed POST
 * leaves the outcome unknown.
 *
 * A 5xx that names no refusal (a Vercel 504 page, our own `internal_error`)
 * may come after the issue or the payment (and its §87 RC) committed: the
 * pay route still runs post-commit steps. A named code or a 4xx says what
 * happened. The READ_ONLY_MODE 503 is checked before this (it wrote nothing).
 */
export function isUnknownOutcome(status: number, code: string | null | undefined): boolean {
  return status >= 500 && (!code || code === 'internal_error');
}

/**
 * The browser's wait on those POSTs (#58). The routes keep the platform's
 * default run limit (300 s): a lower one would make a kill inside the
 * transaction likelier. So the server may still be running when this fires,
 * and the dialog says exactly that: it can't tell, refresh to check.
 */
export const MONEY_POST_TIMEOUT_MS = 75_000;

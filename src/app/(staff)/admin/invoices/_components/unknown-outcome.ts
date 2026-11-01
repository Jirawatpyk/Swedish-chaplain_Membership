import type { ProblemCode } from '@/lib/http/read-only-refusal';

/**
 * #57 / #58 — the issue-invoice and record-payment dialogs: which failed POST
 * leaves the outcome unknown.
 *
 * A 5xx that names no refusal (a Vercel 504 page, our own `internal_error`)
 * may come after the issue or the payment (and its §87 RC) committed: the
 * pay route still runs post-commit steps. A route's own named 5xx code
 * (`pdf_render_failed`, `blob_upload_failed`, …) is raised inside the
 * transaction, which rolled back, so it keeps its own copy; so does a 4xx. The READ_ONLY_MODE 503 is checked before this (it wrote nothing).
 */
export function isUnknownOutcome(status: number, problem: ProblemCode | null): boolean {
  if (!(status >= 500)) return false;
  // A flat `{ error: 'x' }` 5xx comes from a layer before or around the route
  // (an auth lookup, a platform page), never a route's own named refusal.
  return problem === null || problem.shape === 'flat' || problem.code === 'internal_error';
}

/**
 * The browser's wait on those POSTs (#58). The routes keep the platform's
 * default run limit (300 s): a lower one would make a kill inside the
 * transaction likelier. So the server may still be running when this fires,
 * and the dialog says exactly that: it can't tell, refresh to check.
 */
export const MONEY_POST_TIMEOUT_MS = 75_000;

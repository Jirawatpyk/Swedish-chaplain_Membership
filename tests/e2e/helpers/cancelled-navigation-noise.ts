/**
 * Recognise the one WebKit pageerror that a test's own navigation causes.
 *
 * Next fetches each route's RSC payload (`?_rsc=`) after a client navigation
 * (a link click, `router.push`, `router.refresh()` after sign-in). When a test
 * moves on before that fetch finishes — `waitForURL` resolves as soon as the
 * URL changes, then a `page.goto` follows — the browser cancels the fetch.
 * Chromium rejects it with an AbortError that Next swallows; WebKit rejects
 * with `TypeError: Load failed`, which surfaces as a pageerror and failed the
 * test through the fixture's net. Replayed on WebKit (2026-09-28): the
 * `?_rsc=` request was cancelled ~30 ms after the URL changed, in 4 of 4 runs.
 *
 * Only that pairing is noise: the exact message "Load failed" AND a cancelled
 * RSC request within `windowMs`. A "Load failed" with no cancelled RSC fetch
 * nearby (e.g. an app `fetch` to /api that really failed) still fails the test.
 */

/** A failed request is a cancelled RSC fetch (WebKit or Chromium wording). */
export function isCancelledRscRequest(url: string, errorText: string): boolean {
  let hasRsc = false;
  try {
    hasRsc = new URL(url).searchParams.has('_rsc');
  } catch {
    return false;
  }
  return hasRsc && /cancel|abort/i.test(errorText);
}

/** The pageerror is the cancelled-navigation noise described above. */
export function isCancelledNavigationError(
  error: { readonly name: string; readonly message: string },
  errorAt: number,
  cancelledRscAt: readonly number[],
  windowMs = 2_000,
): boolean {
  if (error.message !== 'Load failed') return false;
  return cancelledRscAt.some((at) => Math.abs(errorAt - at) <= windowMs);
}

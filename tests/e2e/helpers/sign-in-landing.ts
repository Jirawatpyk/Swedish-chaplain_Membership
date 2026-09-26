/**
 * Wait for the sign-in landing's RSC fetches to finish before a test moves on.
 *
 * The sign-in form (`src/components/auth/sign-in-form.tsx`) lands with
 * `router.push(redirect)` followed by `router.refresh()`: two RSC fetches of
 * the landing route, the refresh starting only after the push has rendered —
 * often more than 500 ms later on WebKit, so `networkidle` resolves in the gap
 * and `waitForURL` resolves even earlier. A test's next `page.goto` then
 * cancels the refresh. Chromium reports that as an AbortError, which Next
 * swallows; WebKit rejects with `TypeError: Load failed`, which the fixture's
 * pageerror net fails the test on. Before this wait, 24 of 29 mobile-safari
 * tests across five specs failed that way, on `main` as well.
 *
 * Usage — create the promise BEFORE clicking "Sign in" (the push fetch can
 * finish before `waitForURL` returns), then await it after `waitForURL`:
 *
 *   const landingSettled = signInLandingSettled(page, '/admin/sign-in');
 *   await page.getByRole('button', { name: /sign in/i }).click();
 *   await page.waitForURL('**\/admin');
 *   await landingSettled;
 *
 * Counts finished or failed RSC requests (`?_rsc=`) to any path other than the
 * sign-in page itself, since the landing route varies (`/admin`, `/portal`, a
 * tenant-configured portal page). The timeout is only a hang guard, should the
 * form ever stop issuing one of the two fetches — it never fails the caller.
 */
import type { Page, Request } from '@playwright/test';

export function signInLandingSettled(
  page: Page,
  signInPath: string,
  { expected = 2, timeoutMs = 15_000 }: { expected?: number; timeoutMs?: number } = {},
): Promise<void> {
  return new Promise((resolve) => {
    let finished = 0;
    const onDone = (req: Request): void => {
      const url = new URL(req.url());
      if (url.searchParams.has('_rsc') && url.pathname !== signInPath) {
        finished += 1;
        if (finished >= expected) settle();
      }
    };
    const timer = setTimeout(settle, timeoutMs);
    function settle(): void {
      clearTimeout(timer);
      page.off('requestfinished', onDone);
      page.off('requestfailed', onDone);
      resolve();
    }
    page.on('requestfinished', onDone);
    page.on('requestfailed', onDone);
  });
}

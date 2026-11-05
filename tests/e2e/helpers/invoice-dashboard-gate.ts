import { expect, type Page, type Response } from '@playwright/test';
import en from '@/i18n/messages/en.json';
import sv from '@/i18n/messages/sv.json';
import th from '@/i18n/messages/th.json';

const NOT_FOUND_TITLES: readonly string[] = [en, th, sv].map((m) => m.admin.notFound.title);

/**
 * True when `/admin/finance` is not served on this server
 * (FEATURE_INVOICE_DASHBOARD off).
 *
 * A 404 is not enough to tell: the route has a `loading.tsx` and no
 * `not-found.tsx`, so its `notFound()` streams the admin shell's
 * "Page not available" page with HTTP 200. The skip guard read only the
 * status, never fired, and the specs failed instead of skipping (R136).
 * So this also reads the page's one visible h1.
 */
export async function invoiceDashboardIsOff(page: Page, response: Response | null): Promise<boolean> {
  if (response?.status() === 404) return true;
  const h1 = page.locator('h1:visible');
  await expect(h1).toBeVisible();
  return NOT_FOUND_TITLES.includes((await h1.innerText()).trim());
}

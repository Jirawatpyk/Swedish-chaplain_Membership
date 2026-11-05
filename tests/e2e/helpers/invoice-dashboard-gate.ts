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
 * "Page not available" page with HTTP 200, and the skip guard that read
 * only the status never fired (R136). Nor is the first h1: the loading
 * skeleton already shows the dashboard's own title before the stream
 * swaps in the not-found page. So this waits for whichever settles — the
 * dashboard's tiles or the not-found heading — and reports which.
 */
export async function invoiceDashboardIsOff(page: Page, response: Response | null): Promise<boolean> {
  if (response?.status() === 404) return true;
  const notFound = page.getByRole('heading', { level: 1 }).filter({ hasText: new RegExp(`^(${NOT_FOUND_TITLES.join('|')})$`) });
  const served = page.getByTestId('dashboard-tiles');
  await expect(served.or(notFound)).toBeVisible({ timeout: 30_000 });
  return notFound.isVisible();
}

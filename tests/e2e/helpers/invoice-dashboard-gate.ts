import { expect, type Page, type Response } from '@playwright/test';
import en from '@/i18n/messages/en.json';
import sv from '@/i18n/messages/sv.json';
import th from '@/i18n/messages/th.json';

const NOT_FOUND_TITLES: readonly string[] = [en, th, sv].map((m) => m.admin.notFound.title);

/**
 * True when `/admin/finance` is not served on this server
 * (FEATURE_INVOICE_DASHBOARD off).
 *
 * Since PR P the route is `force-dynamic` with its own `not-found.tsx`, so a
 * flag-off visit answers HTTP 404 and short-circuits here. The heading wait
 * stays as a fallback for servers that still stream the not-found page as a
 * 200 (the dev server, an older build — R136): there the first h1 is not
 * enough either, since the loading skeleton shows the dashboard's own title
 * before the stream swaps in the not-found page. So this waits for whichever
 * settles — the dashboard's tiles or the not-found heading — and reports
 * which.
 */
export async function invoiceDashboardIsOff(page: Page, response: Response | null): Promise<boolean> {
  if (response?.status() === 404) return true;
  const notFound = page.getByRole('heading', { level: 1 }).filter({ hasText: new RegExp(`^(${NOT_FOUND_TITLES.join('|')})$`) });
  const served = page.getByTestId('dashboard-tiles');
  await expect(served.or(notFound)).toBeVisible({ timeout: 30_000 });
  return notFound.isVisible();
}

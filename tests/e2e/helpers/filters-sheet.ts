/**
 * Spec 122 (2026-10-15, AURA #146) — below 640px a list's filter controls
 * live in AURA's "Filters" sheet, behind one button in the bar; the search,
 * chips, Clear all and the count stay in the bar.
 *
 * A spec that uses a filter control opens the sheet first and closes it
 * (Done) before it touches the page behind: the sheet stays open after a pick
 * (changes apply at once) and its scrim takes the next click. Both helpers do
 * nothing from 640px, where the controls sit in the bar.
 */
import { expect, type Locator, type Page } from '@playwright/test';

const PHONE_MAX = 639;

/** True below 640px, where a list's filter controls live in the Filters sheet. */
export function onPhone(page: Page): boolean {
  const width = page.viewportSize()?.width ?? 1280;
  return width <= PHONE_MAX;
}

/**
 * Opens the Filters sheet on a phone and returns the scope to find the filter
 * controls in: the sheet below 640px, the page from 640px.
 */
export async function openFilters(page: Page, bar?: Locator): Promise<Locator> {
  if (!onPhone(page)) return page.locator('body');
  const sheet = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: /^(Done|เสร็จ|Klar)/ }) });
  // Already open (a caller re-opening after a pick): behind the sheet the bar's
  // Filters button is aria-hidden, so clicking it again would wait it out.
  if (await sheet.isVisible().catch(() => false)) return sheet;
  const button = (bar ?? page).getByRole('button', { name: /^(Filters?|ตัวกรอง)(,|$)/ }).first();
  // A click before hydration does nothing (the server HTML has the button but
  // no handler yet), so retry until the sheet is open.
  await expect(async () => {
    if (!(await sheet.isVisible())) await button.click();
    await expect(sheet).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  return sheet;
}

/** Closes the Filters sheet (Done) on a phone; a no-op from 640px or when it is not open. */
export async function closeFilters(page: Page): Promise<void> {
  if (!onPhone(page)) return;
  const done = page.getByRole('dialog').getByRole('button', { name: /^(Done|เสร็จ|Klar)/ });
  if (await done.isVisible().catch(() => false)) {
    await done.click();
    await expect(done).toBeHidden();
  }
}

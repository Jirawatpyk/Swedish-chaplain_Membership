/**
 * Spec 122 US5b-1 (maintainer, 29 Sep): on a phone the member header shows
 * Edit, Benefits and ⋯; Erase and Archive open from that menu. From 640px up
 * they are visible buttons. These helpers reach an action either way, so a
 * spec runs the same on chromium and mobile-chrome (Pixel 5, 393px).
 */
import { expect, type Page } from '@playwright/test';

const MORE = /^(More actions|การดำเนินการเพิ่มเติม|Fler åtgärder)$/;

function header(page: Page) {
  return page.locator('[data-slot="page-header-actions"]');
}

/** Waits for the header, then says whether this width has the ⋯ menu. */
async function usesMenu(page: Page, name: RegExp): Promise<boolean> {
  const button = header(page).getByRole('button', { name }).first();
  const more = header(page).getByRole('button', { name: MORE });
  await expect(button.or(more)).toBeVisible({ timeout: 15_000 });
  return !(await button.isVisible());
}

/** Asserts the action is offered: a visible button, or an item in the ⋯ menu. */
export async function expectMemberHeaderAction(page: Page, name: RegExp): Promise<void> {
  if (!(await usesMenu(page, name))) return;
  await header(page).getByRole('button', { name: MORE }).click();
  await expect(page.getByRole('menuitem', { name })).toBeVisible();
  await page.keyboard.press('Escape');
}

/** Opens the action's dialog from its button, or from the ⋯ menu on a phone. */
export async function openMemberHeaderAction(page: Page, name: RegExp): Promise<void> {
  if (!(await usesMenu(page, name))) {
    await header(page).getByRole('button', { name }).first().click();
    return;
  }
  await header(page).getByRole('button', { name: MORE }).click();
  await page.getByRole('menuitem', { name }).click();
}

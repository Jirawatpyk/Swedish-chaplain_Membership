/**
 * Layout B (maintainer, 22 Oct; first on phones only, 29 Sep): the member
 * header shows Benefits, Edit and ⋯; Archive and Erase open from that menu
 * at every width. These helpers still accept a visible button too, so a
 * spec reads the same whichever way the header offers an action.
 */
import { expect, type Page } from '@playwright/test';

const MORE = /^(More actions|การดำเนินการเพิ่มเติม|Fler åtgärder)$/;

function header(page: Page) {
  // AURA PageHeader (spec 122, #151): the actions row is AURA's.
  return page.locator('[data-slot="page-header"] .aura-page-header__actions');
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

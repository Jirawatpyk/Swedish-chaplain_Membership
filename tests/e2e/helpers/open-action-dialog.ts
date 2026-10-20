/**
 * Spec 122 US12c-1 — open a dialog from a button in the staff E-Blast
 * detail's action row (board `Admin-broadcast-review`: Cancel / Reject on
 * the left, Start formatted version / Approve / Confirm schedule on the
 * right, at the end of the page).
 *
 * From 640 px the row is static at the bottom of a long page, below the
 * sandboxed email-preview iframes. Playwright scrolls the button into view
 * and clicks a few milliseconds later; if that click lands before the new
 * scroll offset is painted, it goes into the iframe above (events inside a
 * sandboxed srcdoc frame never reach the page) and nothing opens. Measured
 * on the preview: 3 of 3 misses at 800, 1023 and 1440 px, none at 390 (the
 * row is pinned there, so nothing scrolls), none with a tall viewport.
 *
 * So scroll first, then click until the dialog is up. A click while the
 * dialog is open is never sent: the dialog is checked first.
 */
import type { Locator, Page } from '@playwright/test';
import { expect } from '../fixtures';

export async function openActionDialog(
  page: Page,
  trigger: Locator,
  dialog: Locator = page.getByRole('alertdialog'),
): Promise<void> {
  await trigger.scrollIntoViewIfNeeded();
  await expect(async () => {
    if (!(await dialog.isVisible())) await trigger.click();
    await expect(dialog).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

/**
 * Opens "Start formatted version"'s confirmation from wherever the row puts
 * it: its own button from 640 px, the ⋯ menu below (parity comment, 20 Oct;
 * board `Admin-broadcast-review-mobile`). Only one of the two is visible.
 */
export async function openStartConfirmation(page: Page): Promise<void> {
  const start = page.locator('[data-testid="eblast-start-version"]:visible');
  const more = page.locator('[data-testid="eblast-more-actions"]:visible');
  await expect(start.or(more), 'Start is absent — is FEATURE_EBLAST_MEMBER_APPROVAL on for this server?').toBeVisible();
  if ((await start.count()) > 0) {
    await openActionDialog(page, start);
    return;
  }
  await openActionDialog(page, more, page.getByRole('menu'));
  await page.getByRole('menuitem', { name: /start formatted version/i }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
}

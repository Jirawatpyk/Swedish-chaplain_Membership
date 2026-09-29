/**
 * Spec 122 US5a — locators for the members list on AURA `DataTable`.
 *
 * The table is an ARIA grid built from divs (`role="grid"` / `row` /
 * `gridcell` / `columnheader`), not a `<table>`, so `tbody tr` and the old
 * kit's `[data-slot="table"]` / `[data-slot="checkbox"]` match nothing. The
 * checkboxes are AURA's: a visually hidden `<input>` inside a
 * `label.aura-check`, so a click goes to the label. The bulk bar is AURA
 * `ActionBar` (a named region that stays mounted, clipped, when nothing is
 * selected).
 */
import type { Locator, Page } from '@playwright/test';

/** The members grid (also the directory grid on /admin/directory). */
export const MEMBERS_GRID = '[role="grid"]';

/** Every data row (the header row has no gridcell). */
export function memberRows(page: Page): Locator {
  return page.locator('[role="grid"] [role="row"]:has([role="gridcell"])');
}

/** The company link of the first data row — the row's link to the member. */
export function firstMemberRowLink(page: Page): Locator {
  return memberRows(page).first().locator('a.aura-table__row-link');
}

/** The header "Select all" checkbox's clickable label. */
export function selectAllCheckbox(page: Page): Locator {
  return page.locator('[role="grid"] [role="columnheader"] label.aura-check');
}

/** The first data row's checkbox label (a click toggles the row). */
export function firstRowCheckbox(page: Page): Locator {
  return memberRows(page).first().locator('label.aura-check');
}

/** Every checkbox input in the grid (header + rows). */
export function gridCheckboxInputs(page: Page): Locator {
  return page.locator('[role="grid"] input[type="checkbox"]');
}

/** The bulk bar (AURA ActionBar); `is-idle` while nothing is selected. */
export function bulkBar(page: Page): Locator {
  return page.locator('.aura-actionbar');
}

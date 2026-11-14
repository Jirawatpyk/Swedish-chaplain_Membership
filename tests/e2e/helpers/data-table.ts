/**
 * A column of an AURA `DataTable`, found the way each layout shows it.
 *
 * On a wide screen the grid has a header row, so a column is its
 * `columnheader`. On a phone the same grid is stacked into cards and the
 * header row is not rendered: each card cell carries the column's label
 * instead (`data-label`, drawn before the value), so the cell's accessible
 * name starts with the label — "Method Method: Card". A spec that asserts a
 * `columnheader` on mobile-chrome therefore fails on a table that is fine.
 *
 * Only the label-bearing ("field") cells carry the label; the card's title
 * cell (usually the name / company link) has none, so check that one through
 * the row's link instead.
 */
import type { Locator, Page } from '@playwright/test';

function startsWith(label: string | RegExp): RegExp {
  if (typeof label === 'string') {
    return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  }
  return new RegExp(`^(?:${label.source})`, label.flags.includes('i') ? 'i' : '');
}

/** The column `label`: its header on a wide screen, its first labelled cell on a phone. */
export function tableColumn(
  scope: Page | Locator,
  label: string | RegExp,
  isMobile: boolean,
): Locator {
  if (isMobile) {
    return scope.getByRole('gridcell', { name: startsWith(label) }).first();
  }
  return scope.getByRole('columnheader', { name: label });
}

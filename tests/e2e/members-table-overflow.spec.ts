/**
 * Regression guard for the `/admin/members` directory's fixed-width columns
 * bleeding into their neighbours (Plan 150px, Status 130px).
 *
 * `table-fixed` + an explicit `<colgroup>` pin each `<td>`'s BOX to the
 * column's declared width, but `TableCell` (`src/components/ui/table.tsx`)
 * sets `whitespace-nowrap` with no `overflow`/`text-overflow` guard, so
 * content wider than its column overflows *visibly* into the neighbour
 * instead of wrapping or clipping. The cell box itself never overlaps —
 * only its painted content does — so this asserts the content's rendered
 * right edge against the cell's right edge, not `scrollWidth`.
 *
 * Uses a dedicated seeded fixture (`seedLongContentMember`) rather than
 * iterating "every row": the existing directory specs are written to
 * tolerate an empty table, and there is no other members seed helper — a
 * generic iteration would pass vacuously against an empty/short-content
 * table, guarding nothing.
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import {
  cleanupLongContentMember,
  seedLongContentMember,
} from './helpers/long-content-member-seed';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe('members directory — column overflow @a11y', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD',
  );

  test.afterAll(async () => {
    await cleanupLongContentMember();
  });

  test('Plan and Status cell content stays inside its column', async ({ page }) => {
    const seed = await seedLongContentMember();
    test.skip(seed === null, 'seed unavailable (no DATABASE_URL or no active plan to clone)');

    await signInAsAdmin(page);
    await page.goto(`/admin/members?q=${encodeURIComponent(seed!.companyName)}`);
    await page.waitForLoadState('networkidle');

    const row = page.getByRole('row').filter({ hasText: seed!.companyName });
    await expect(row).toBeVisible();

    // Admin session → `enableSelection` is on, so the rendered column order
    // is: select(0), Member No.(1), Company(2), Plan(3), Contact(4),
    // Status(5), Engagement(6), Last activity(7) — verified against
    // `members-table.tsx`'s `columns` array. Company + Contact already wrap
    // (`break-words whitespace-normal` + a `max-w`) so only Plan + Status
    // are vulnerable to the `whitespace-nowrap` overflow bug.
    for (const columnIndex of [/* Plan */ 3, /* Status */ 5]) {
      const cell = row.getByRole('cell').nth(columnIndex);
      const bleed = await cell.evaluate((td) => {
        const cellRight = td.getBoundingClientRect().right;
        let worst = 0;
        for (const child of Array.from(td.querySelectorAll('*'))) {
          worst = Math.max(worst, child.getBoundingClientRect().right - cellRight);
        }
        return worst;
      });
      // 1px tolerance for sub-pixel rounding.
      expect(bleed, `column ${columnIndex} content bleed past its cell`).toBeLessThanOrEqual(1);
    }
  });
});

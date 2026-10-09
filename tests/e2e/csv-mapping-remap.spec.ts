/**
 * F6 · PR 4.2 (#10a/#10b) — CSV mapping remap UI E2E.
 *
 * Verifies the FR-026 "confirm or remap" flow end-to-end for a
 * NON-EventCreate tenant (Eventbrite/Meetup-style export):
 *   1. Admin selects an event via the picker (the event binding is
 *      picker-authoritative post-095).
 *   2. Uploads a CSV whose attendee columns are under NON-canonical
 *      headers ("Email Address" / "Full Name") and which has NO
 *      canonical event_* columns at all.
 *   3. Drives the per-column remap <select> dropdowns to map each
 *      required attendee column to its source header.
 *   4. Confirm is GATED until the required attendee columns are mapped,
 *      then enables → submit → import succeeds (result card surfaces).
 *
 * The parent `csv-eventcreate-import.spec.ts` covers the canonical-header
 * happy path; this sibling closes the interactive-remap gap (R-S04).
 *
 * Run:
 *   pnpm test:e2e --grep "F6.1-A CSV remap" --workers=1
 * (--workers=1 is mandatory per CLAUDE.md memory feedback_e2e_workers.)
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import { clearE2ERateLimits } from './helpers/rate-limit';
import en from '../../src/i18n/messages/en.json';

// F6.1: `csv-mapping-form.tsx:687` passes `triggerAriaLabelledBy`, so the
// picker's accessible name is its visible <Label> — NOT the `triggerAriaLabel`
// message the old locator searched for. `event-picker.tsx:72-79` documents the
// choice (a visible label, no duplicate accessible name). Read the label from
// the message file so a rename fails loudly here instead of silently.
const EVENT_PICKER_LABEL = en.admin.events.import.eventPicker.fieldLabel;
import path from 'node:path';
import fs from 'node:fs';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const FEATURE_FLAG = process.env.FEATURE_F6_EVENTCREATE;

test.describe.configure({ mode: 'serial' });

test.describe('F6.1-A CSV remap — non-canonical header admin flow', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD || FEATURE_FLAG !== 'true',
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD + FEATURE_F6_EVENTCREATE=true',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('admin remaps non-canonical CSV headers and completes import', async ({
    page,
  }, testInfo) => {
    await signInAsAdmin(page);
    await page.goto('/admin/events/import');
    await page.waitForLoadState('domcontentloaded');

    await expect(
      page.getByRole('heading', { level: 1, name: /import/i }),
    ).toBeVisible({ timeout: 15_000 });

    // 1. Select an event via the picker → inline "Create new event" modal
    //    (mirrors csv-eventcreate-import.spec.ts). The picker is the
    //    authoritative event binding; the CSV carries no event columns.
    const eventCombobox = page.getByRole('combobox', {
      name: EVENT_PICKER_LABEL,
      exact: true,
    });
    await expect(eventCombobox).toBeVisible();

    const createNewBtn = page.getByRole('button', {
      name: /create new event/i,
    });
    await expect(createNewBtn).toBeVisible();
    await createNewBtn.click();

    const dialog = page.getByRole('dialog', { name: /create new event/i });
    await expect(dialog).toBeVisible();

    const runId = Date.now().toString(36);
    await dialog.getByLabel(/external id/i).fill(`e2e-remap-${runId}`);
    await dialog.getByLabel(/event name/i).fill(`E2E Remap ${runId}`);
    // Spec 122 US9b-2: the start is an AURA DatePicker and TimePicker; each
    // takes typed text when it loses focus.
    await dialog.getByLabel(/^start date/i).fill('2026-06-01');
    await dialog.getByLabel(/^start date/i).press('Tab');
    await dialog.getByLabel(/^start time/i).fill('09:00');
    await dialog.getByLabel(/^start time/i).press('Tab');
    await dialog.getByLabel(/^category/i).fill('Workshop');
    await dialog.getByRole('button', { name: /^create event$/i }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    // The AURA Combobox is a text field: its value is the chosen event.
    await expect(eventCombobox).not.toHaveValue('');

    // 2. Upload a CSV with NON-canonical attendee headers + NO event
    //    columns — the picker supplies event_* per #10b.
    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    const csvPath = path.join(testInfo.outputDir, 'remap-fixture.csv');
    const csvContent =
      'Email Address,Full Name,Company Name\n' +
      'remap1@test.example,Test Person 1,Test Co 1\n' +
      'remap2@test.example,Test Person 2,Test Co 2\n';
    fs.writeFileSync(csvPath, csvContent);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(csvPath);
    await page.waitForLoadState('domcontentloaded');

    // 3. Remap fields render for the required attendee columns. Confirm
    //    is gated until both are mapped.
    const confirmBtn = page.getByRole('button', { name: /confirm and import/i });
    await expect(confirmBtn).toBeVisible({ timeout: 15_000 });
    await expect(confirmBtn).toBeDisabled();

    // Spec 122 US9b-2: each remap field is an AURA Select (a combobox that
    // opens a listbox of the detected headers).
    async function pick(field: RegExp, header: string): Promise<void> {
      await page.getByRole('combobox', { name: field }).click();
      await page.getByRole('option', { name: header, exact: true }).click();
    }
    await pick(/attendee_email/i, 'Email Address');
    // Still gated after mapping only one required column.
    await expect(confirmBtn).toBeDisabled();
    await pick(/attendee_name/i, 'Full Name');

    // 4. Gate opens → submit → import completes.
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();

    const resultCard = page.getByTestId('csv-import-result');
    const mismatchDialog = page.getByRole('alertdialog', {
      name: /may belong to a different event/i,
    });
    await Promise.race([
      resultCard.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => null),
      mismatchDialog
        .waitFor({ state: 'visible', timeout: 30_000 })
        .catch(() => null),
    ]);
    if (await mismatchDialog.isVisible()) {
      await mismatchDialog
        .getByRole('button', { name: /continue anyway/i })
        .click();
    }
    await expect(resultCard).toBeVisible({ timeout: 90_000 });
  });
});

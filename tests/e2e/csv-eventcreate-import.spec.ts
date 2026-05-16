/**
 * T055 (F6.1 · Feature 013 — Phase 6) — E2E: EventCreate adapter
 * happy-path workflow against a running dev server on :3100.
 *
 * Single end-to-end scenario covering US1 P1/MVP acceptance:
 *   1. Sign in as admin
 *   2. Navigate to /admin/events/import
 *   3. Open event-picker → "Create new event" → fill modal → submit
 *      (unique external_id per run via Date.now() prefix so re-runs
 *      don't collide with prior seeds)
 *   4. Upload Grant Thornton fixture → wait for preview phase
 *   5. Click "Confirm and import" → wait for result card
 *   6. Assert result card visible + recordId chip visible
 *
 * Separate scenario covers the history page (read-only) — independent
 * of the upload scenario so it survives a fresh tenant.
 *
 * Selectors verified against actual components 2026-05-16:
 *   - Event-picker trigger: role=combobox + aria-label="Choose event for CSV import"
 *   - Inline modal: shadcn Dialog with Label htmlFor → use getByLabel
 *   - Modal submit: t('submitCta') = "Create event"
 *   - File input: htmlFor={fileInputId} + Label "Choose a .csv file"
 *   - Preview phase: rendered after handleFile → PreviewPanel with submit
 *     button label t('confirmCta') = "Confirm and import"
 *   - Result card: data-testid="csv-import-result" (csv-import-result.tsx:99)
 *   - Result recordId: data-testid="result-record-id" (csv-import-result.tsx:161)
 *   - History table: data-testid="csv-import-history-table"
 *
 * Manual-gate: auto-skips when `E2E_ADMIN_EMAIL` + `E2E_ADMIN_PASSWORD`
 * env vars are absent (auto-loaded by playwright.config.ts from .env.local).
 * Run: `pnpm test:e2e --grep "F6.1 EventCreate CSV import" --workers=1`
 * (`--workers=1` mandatory per CLAUDE.md `feedback_e2e_workers` memory).
 */
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { signInAsAdmin } from './helpers/admin-session';

const ADMIN_EMAIL = process.env['E2E_ADMIN_EMAIL'];
const ADMIN_PASSWORD = process.env['E2E_ADMIN_PASSWORD'];
const E2E_GATE = Boolean(ADMIN_EMAIL && ADMIN_PASSWORD);

const FIXTURE_PATH = join(
  process.cwd(),
  'docs',
  'Attendee list',
  'EventCreate_Guestlist-grant-thornton-workshop.csv',
);

test.describe('F6.1 EventCreate CSV import — manual-gate E2E', () => {
  test.skip(!E2E_GATE, 'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to enable');
  test.describe.configure({ timeout: 180_000 });

  test('happy path — admin uploads Grant Thornton fixture via event-picker + inline modal → result card surfaces', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/events/import');

    // Wait for the page heading + event-picker combobox to mount.
    await expect(
      page.getByRole('heading', { name: /import.*csv|import attendees/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Event-picker uses role=combobox + aria-label "Choose event for CSV import".
    const eventCombobox = page.getByRole('combobox', {
      name: /choose event for csv import/i,
    });
    await expect(eventCombobox).toBeVisible();

    // Open the "Create new event" inline modal (button sits next to the
    // combobox, NOT inside the popover; visible as long as `onCreateNew`
    // is wired by csv-mapping-form.tsx).
    const createNewBtn = page.getByRole('button', { name: /create new event/i });
    await expect(createNewBtn).toBeVisible();
    await createNewBtn.click();

    // Modal is a shadcn Dialog; fields use Label htmlFor association.
    const dialog = page.getByRole('dialog', { name: /create new event/i });
    await expect(dialog).toBeVisible();

    // Unique external_id per run so re-runs don't 200 'already_exists'.
    const runId = Date.now().toString(36);
    const externalId = `e2e-gt-${runId}`;
    const eventName = `E2E Grant Thornton ${runId}`;

    await dialog.getByLabel(/external id/i).fill(externalId);
    await dialog.getByLabel(/event name/i).fill(eventName);
    // The datetime-local input — fill ISO-ish local datetime.
    await dialog.getByLabel(/start date/i).fill('2026-03-15T13:00');
    // Category is optional — fill anyway for completeness.
    await dialog.getByLabel(/^category/i).fill('Workshop');

    // Submit (createEvent use-case → POST /api/admin/events → 201).
    await dialog.getByRole('button', { name: /^create event$/i }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // Combobox should now show the just-created event as selected.
    // We don't assert exact label text (locale-dependent date formatting)
    // — instead verify the combobox value changed away from placeholder.
    await expect(eventCombobox).not.toHaveText(/choose an event/i);

    // Upload the Grant Thornton fixture via the file input.
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'EventCreate_Guestlist-grant-thornton-workshop.csv',
      mimeType: 'text/csv',
      buffer: await readFile(FIXTURE_PATH),
    });

    // Form transitions to preview phase — wait for the Confirm button
    // (rendered by PreviewPanel; only visible once parse completes).
    const confirmBtn = page.getByRole('button', { name: /^confirm and import$/i });
    await expect(confirmBtn).toBeVisible({ timeout: 30_000 });
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();

    // Result card renders after the use-case returns.
    const resultCard = page.getByTestId('csv-import-result');
    await expect(resultCard).toBeVisible({ timeout: 90_000 });

    // recordId chip is part of the result card per csv-import-result.tsx:161
    await expect(page.getByTestId('result-record-id')).toBeVisible();
  });

  test('history page renders for an admin — table OR empty-state visible', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/events/import/history');

    // Either the table is mounted (one or more imports exist) or the
    // explicit empty-state region is shown. Both are valid renders.
    const tableOrEmpty = page
      .locator(
        '[data-testid="csv-import-history-table"], [data-testid="csv-import-history-empty"]',
      )
      .first();
    await expect(tableOrEmpty).toBeVisible({ timeout: 30_000 });

    // Page heading sanity check.
    await expect(
      page.getByRole('heading', { name: /csv import history/i }),
    ).toBeVisible();
  });
});

/**
 * T054 — E2E test: close browser mid-compose → reopen → draft restored.
 *
 * Spec authority: spec.md US1 AS3.
 *
 * Flow:
 *   1. Sign in + navigate /portal/broadcasts/new.
 *   2. Fill subject + Tiptap body partially.
 *   3. Click "Save draft" (or autosave triggers after typing pause).
 *   4. Close browser context.
 *   5. Re-open browser, sign in, navigate /portal/broadcasts → click "Drafts" tab.
 *   6. Verify draft visible, click → /portal/broadcasts/new?draftId=... loads with prior values.
 *
 * Turns GREEN: T079 (compose page server shell loads draft if draftId
 * URL param) + T068 (save-draft.ts) + T073 (POST /api/broadcasts/draft).
 */
import { test } from '@playwright/test';

test.describe('Broadcast draft restore (T054 — US1 AS3)', () => {
  test.fixme('save draft persists row with status=draft', async ({ page }) => {
    await page.goto('/portal/broadcasts/new');
    // Fill + click Save Draft
    // Assert toast "Draft saved"
  });

  test.fixme('draft visible in /portal/broadcasts list with status badge', async ({ page: _page }) => {
    // After save, navigate to broadcasts list
  });

  test.fixme('clicking draft loads /portal/broadcasts/new?draftId=... with prior values restored', async ({ page: _page }) => {
    // Verify subject + body fields hydrated
  });

  test.fixme('30-day retention: draft older than 30 days NOT restored (auto-deleted)', async () => {
    // Seed 31-day-old draft → assert deleted by retention cron
  });

  test.fixme('draft autosave triggers after typing pause (FR-001b — UX detail)', async ({ page: _page }) => {
    // Type → wait 2s idle → assert autosave network request fired
  });
});

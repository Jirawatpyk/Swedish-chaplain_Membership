/**
 * T055 — E2E test: all-suppressed custom list rejected.
 *
 * Spec authority: spec.md US1 AS4.
 *
 * Flow:
 *   1. Seed member + 3 contacts (all on marketing_unsubscribes suppression list).
 *   2. Sign in + compose broadcast with custom segment listing those 3 emails.
 *   3. Submit → verify rejection with broadcast_empty_segment_blocked
 *      AFTER suppression filter applied.
 *   4. Bilingual error toast (EN + TH).
 *
 * Turns GREEN: T065 (validate-custom-recipients.ts) + T066 (resolve-segment-recipients.ts
 * with suppression filter) + T076 (submit route) + T085 (segment-picker.tsx) +
 * T086 (custom-list-input.tsx).
 */
import { test } from '@playwright/test';

test.describe('Broadcast empty segment after suppression filter (T055 — US1 AS4)', () => {
  test.fixme('custom list with all-suppressed emails → 422 broadcast_empty_segment_blocked', async ({ page }) => {
    await page.goto('/portal/broadcasts/new');
    // Select "Custom list" segment + paste 3 suppressed emails
    // Submit → assert error toast "All recipients suppressed; broadcast cannot be sent"
  });

  test.fixme('partially-suppressed list still proceeds with non-suppressed recipients', async () => {
    // Custom list 5 emails, 2 suppressed → succeeds with 3 effective recipients
  });

  test.fixme('error toast bilingual EN + TH copy', async ({ page: _page }) => {
    // Switch locale → submit again → assert TH copy
  });

  test.fixme('audit broadcast_empty_segment_blocked emitted', async () => {
    // SELECT * FROM audit_log WHERE event_type = 'broadcast_empty_segment_blocked'
  });
});

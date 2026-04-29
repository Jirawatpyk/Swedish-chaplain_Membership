/**
 * T053 — E2E test: quota-exhausted member sees disabled CTA.
 *
 * Spec authority: spec.md US1 AS2.
 *
 * Flow:
 *   1. Seed member with quota fully consumed (used=6, cap=6).
 *   2. Sign in + navigate /portal/benefits/e-blasts.
 *   3. Verify "Compose new E-Blast" CTA disabled with explainer "Quota exhausted".
 *   4. Bilingual EN+TH: switch locale, verify TH copy.
 *   5. Direct API submit returns 409 broadcast_quota_blocked.
 *
 * Turns GREEN: T089 (quota-display.tsx) + T090 (submit-button disabled
 * state) + T076 (POST /api/broadcasts/submit precondition).
 */
import { test, expect } from '@playwright/test';

test.describe('Broadcast quota block (T053 — US1 AS2)', () => {
  test.fixme('disabled CTA when quota exhausted (used=cap)', async ({ page }) => {
    await page.goto('/portal/benefits/e-blasts');
    await expect(page.getByRole('button', { name: /compose/i })).toBeDisabled();
  });

  test.fixme('explainer copy "Quota exhausted" in EN locale', async ({ page: _page }) => {
    // Assert visible explainer text matches en.json key
  });

  test.fixme('explainer copy in TH locale', async ({ page: _page }) => {
    // Switch to /th, assert th.json key visible
  });

  test.fixme('API submit returns 409 broadcast_quota_blocked when quota exhausted', async ({ request: _request }) => {
    // POST /api/broadcasts/submit → expect 409 with code: 'broadcast_quota_blocked'
  });

  test.fixme('quota-display shows used/reserved/remaining/cap counters', async ({ page: _page }) => {
    // Verify 4 numeric counters visible
  });
});

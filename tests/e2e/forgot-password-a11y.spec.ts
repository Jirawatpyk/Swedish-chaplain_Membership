/**
 * T096 — Forgot-password + reset-password axe a11y scan
 * (spec FR-024, WCAG 2.1 AA).
 *
 * Uses @axe-core/playwright to run an automated accessibility scan
 * on every public auth page. Asserts ZERO serious or critical
 * violations; warnings are logged but don't fail.
 *
 * Reset-password page is scanned against an arbitrary token slug
 * (server returns "link invalid" but the page still renders the
 * error state, which must also pass axe).
 */
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function scan(page: import('@playwright/test').Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = result.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  if (serious.length > 0) {
    console.log(
      `  axe violations on ${url}: ${serious
        .map((v) => `${v.id}(${v.impact})`)
        .join(', ')}`,
    );
  }
  expect(serious).toHaveLength(0);
}

test.describe('forgot-password + reset-password a11y (T096, WCAG 2.1 AA)', () => {
  test('forgot-password page has no serious axe violations', async ({ page }) => {
    await scan(page, '/forgot-password');
  });

  test('reset-password with invalid token still passes axe on error state', async ({ page }) => {
    await scan(page, '/reset-password/not-a-real-token-but-still-64-chars-' + 'a'.repeat(32));
  });
});

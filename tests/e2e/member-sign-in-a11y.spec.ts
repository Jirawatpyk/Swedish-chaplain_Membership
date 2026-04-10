/**
 * T141 — Member sign-in + placeholder axe a11y scan
 * (spec WCAG 2.1 AA).
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

test.describe('member a11y scans (T141, WCAG 2.1 AA)', () => {
  test('/portal/sign-in has no serious axe violations', async ({ page }) => {
    await scan(page, '/portal/sign-in');
  });
});

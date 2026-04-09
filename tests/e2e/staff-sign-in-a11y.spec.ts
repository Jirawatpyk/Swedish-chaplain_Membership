/**
 * T064 — Staff sign-in a11y scan (Playwright + @axe-core/playwright).
 *
 * Asserts the sign-in page has zero WCAG 2.1 AA violations per spec
 * SC-005. Runs axe-core in the page's DOM and fails if any violation
 * is reported for the configured WCAG levels.
 *
 * The test opens the public sign-in page only — no credentials
 * required.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('staff sign-in a11y', () => {
  test('has zero WCAG 2.1 AA violations', async ({ page }) => {
    await page.goto('/admin/sign-in');

    // Wait for the form to render so axe sees real content
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    // Verbose output on failure: dump violations to help debug
    if (results.violations.length > 0) {
      console.log('axe violations:');
      for (const violation of results.violations) {
        console.log(`  [${violation.id}] ${violation.help}`);
        for (const node of violation.nodes) {
          console.log(`    - ${node.target.join(', ')}`);
          console.log(`      ${node.failureSummary}`);
        }
      }
    }

    expect(results.violations).toEqual([]);
  });
});

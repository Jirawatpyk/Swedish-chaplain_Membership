/**
 * E2E axe-core scan helper.
 *
 * F7.1b B7 closure 2026-05-21 — centralizes the WCAG 2.1 AA accessibility
 * scan that was duplicated across ~20 E2E spec files with slight variations.
 *
 * Why this helper:
 *   - Single source of truth for which axe tags + impact levels to enforce
 *   - Moderate violations get attached to the test report as warnings
 *     (was: silently filtered out by the legacy `serious || critical`
 *     filter — `moderate` violations slipped through invisible)
 *   - Strict mode (`E2E_AXE_STRICT=true`) flips moderate from
 *     WARN-only → FAIL, useful when an a11y-hardening sprint wants
 *     stricter gating
 *   - Critical + serious violations ALWAYS fail (matches legacy
 *     behaviour for all callers — no regression on existing specs)
 *
 * Usage pattern (replaces the inline `new AxeBuilder + .filter + expect`
 * blocks scattered across E2E specs):
 *
 *   import { runAxeScan } from '../helpers/axe-scan';
 *   // ...
 *   await runAxeScan(page, testInfo);
 *
 * Migration path: the helper is opt-in — existing specs continue to
 * work with their inline AxeBuilder code until they are migrated to
 * call `runAxeScan`. The F7.1a broadcasts specs are the first 3 to
 * adopt the helper as proof-of-pattern. Remaining ~17 specs are an
 * F7.2 a11y-hardening sweep per retrospective.md F7.1b backlog B7.
 *
 * Why `testInfo` is required:
 *   - `testInfo.attach()` surfaces moderate violations in the HTML
 *     report + JUnit XML output, so a11y debt is visible during
 *     review without failing the build
 *   - Without `testInfo`, the moderate-warning path would be silent
 *     (defeating the helper's purpose)
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';

const STRICT_MODE = process.env.E2E_AXE_STRICT === 'true';

const DEFAULT_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

export interface AxeScanOptions {
  /** Override the default WCAG tag set. */
  readonly tags?: readonly string[];
  /** Restrict the scan to a CSS selector subtree. */
  readonly include?: string;
  /** Exclude a CSS selector subtree (e.g. third-party widgets). */
  readonly exclude?: string;
  /**
   * When true (default), serious + critical violations FAIL the test.
   * Set false to make ALL violations warnings only (useful for
   * exploratory scans during a11y triage).
   */
  readonly failOnSeriousOrCritical?: boolean;
}

export async function runAxeScan(
  page: Page,
  testInfo: TestInfo,
  options: AxeScanOptions = {},
): Promise<void> {
  const tags = options.tags ?? DEFAULT_TAGS;
  const failOnSeriousOrCritical = options.failOnSeriousOrCritical ?? true;

  let builder = new AxeBuilder({ page }).withTags([...tags]);
  if (options.include) builder = builder.include(options.include);
  if (options.exclude) builder = builder.exclude(options.exclude);

  const results = await builder.analyze();

  const critical = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  const moderate = results.violations.filter((v) => v.impact === 'moderate');

  // Surface moderate violations as a test attachment (HTML report +
  // JUnit XML). Does NOT fail unless strict mode is on.
  if (moderate.length > 0) {
    await testInfo.attach('axe-moderate-violations.json', {
      body: Buffer.from(JSON.stringify(moderate, null, 2)),
      contentType: 'application/json',
    });
    if (STRICT_MODE) {
      throw new Error(
        `[axe-scan strict mode] ${moderate.length} moderate violation(s): ` +
          moderate.map((v) => v.id).join(', '),
      );
    }
  }

  if (failOnSeriousOrCritical) {
    expect(critical, 'axe-core serious+critical violations').toEqual([]);
  }
}

/**
 * Shared helpers for F5 admin-refund E2E specs.
 *
 * Extracted from `admin-refund-full.spec.ts` + `admin-refund-
 * partial.spec.ts` (review 2026-04-26 simplify R2). The amount-input
 * help-text under `[id$="-help"]` carries
 *   "Maximum refundable: 53,500.00 THB"
 * — both specs read this to drive their assertions, so the parser
 * lives here as the single source of truth.
 */
import type { Page } from '@playwright/test';

/**
 * Read the maximum refundable amount displayed in the form's
 * help-text and return it as a major-unit string suitable for
 * pasting back into the amount input (e.g. `"53500.00"`).
 */
export async function readMaximumRefundableMajor(page: Page): Promise<string> {
  const helpText = await page.locator('[id$="-help"]').first().textContent();
  const match = helpText?.match(/([\d,]+(?:\.\d+)?)/);
  return match ? match[1]!.replace(/,/g, '') : '0';
}

/**
 * Numeric variant of `readMaximumRefundableMajor` — returns the
 * value as a `number` (THB major units). Use when callers need to
 * compute fractions (half remaining etc.).
 */
export async function readMaximumRefundableMajorNumber(
  page: Page,
): Promise<number> {
  const major = await readMaximumRefundableMajor(page);
  return Number(major);
}

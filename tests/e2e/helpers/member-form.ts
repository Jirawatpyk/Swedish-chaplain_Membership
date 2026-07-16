/**
 * Shared fill helpers for the /admin/members/new create form.
 *
 * 065 final-review — the same required-fields block was pasted into three
 * specs (members-create, members-self-service, renewals/rolling-anchor);
 * each new REQUIRED member-form field (088 added the TH address, 065 §5.1
 * added billing_cycle) then had to be hand-propagated to every create-flow
 * spec, and the one that got missed didn't fail cleanly — it hung at the
 * blocked POST's waitForResponse (see memory note "E2E member-create needs
 * §86/4 TH address"). Add future required fields HERE, once.
 */
import type { Page } from '@playwright/test';
import { expect, fillField } from '../fixtures';

/**
 * Selects the required plan + billing-cycle picks and fills the required
 * §86/4 TH address on the member create form. Assumes `#company_name` has
 * been filled by the caller (specs differ there) and country is left at
 * its 'TH' schema default.
 *
 * - Plan / billing_cycle: shadcn (Base UI) Selects — click trigger, pick
 *   the first option.
 * - Address (088 §86/4, TH create): `address_line1` + an UNAMBIGUOUS
 *   Bangkok postcode (10800 → Bang Sue) whose lookup auto-fills
 *   province/city/sub_district; we wait for that to land (300ms debounce
 *   + local /api/geo/postal fetch) before returning, or the schema
 *   superRefine blocks the POST on submit.
 */
export async function fillRequiredMembershipAndAddress(
  page: Page,
): Promise<void> {
  // Plan select trigger has id="plan_id"; pick the first option.
  await page.locator('#plan_id').click();
  await page.getByRole('option').first().click();
  // 065 §5.1 — billing_cycle is a REQUIRED Select (no default); pick the
  // first option or the form fails validation on submit.
  await page.locator('#billing_cycle').click();
  await page.getByRole('option').first().click();
  // 088 §86/4 — TH member buyer address (required on create).
  await fillField(page.locator('#address_line1'), '99 Test Tower');
  await fillField(page.locator('#postal_code'), '10800');
  await expect(page.locator('#province')).toContainText(/bangkok/i, {
    timeout: 10_000,
  });
}

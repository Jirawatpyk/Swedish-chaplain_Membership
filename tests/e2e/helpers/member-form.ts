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
import type { Locator, Page } from '@playwright/test';
import { expect, fillField } from '../fixtures';

/**
 * Selects the required plan + billing-cycle picks and fills the required
 * §86/4 TH address on the member create form. Assumes `#company_name` has
 * been filled by the caller (specs differ there) and country is left at
 * its 'TH' schema default.
 *
 * - Plan / billing_cycle: AURA Selects (spec 122 US5b-2) — click the
 *   field, pick the first option.
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
  await pickFirstOption(page, page.locator('#plan_id'));
  // 065 §5.1 — billing_cycle is a REQUIRED Select (no default); pick the
  // first option or the form fails validation on submit.
  await pickFirstOption(page, page.locator('#billing_cycle'));
  // 088 §86/4 — TH member buyer address (required on create).
  await fillField(page.locator('#address_line1'), '99 Test Tower');
  await fillField(page.locator('#postal_code'), '10800');
  // The AURA combobox is the text input itself (spec 122 US5b-2).
  await expect(page.locator('#province')).toHaveValue(/bangkok/i, {
    timeout: 10_000,
  });
}

/**
 * Opens an AURA Select and picks its first choice (the placeholder is listed
 * disabled, so it is skipped). The open is retried: a click that lands
 * before hydration toggles nothing, and the option wait then times out. After
 * the pick it waits for the list to close, so the NEXT Select's options are
 * not confused with this one's.
 */
async function pickFirstOption(page: Page, trigger: Locator): Promise<void> {
  await expect(async () => {
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true', { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await page.locator('[role="option"]:not([aria-disabled="true"])').first().click();
  await expect(page.getByRole('option')).toHaveCount(0);
}

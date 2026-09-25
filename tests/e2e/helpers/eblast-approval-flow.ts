/**
 * F119 — drive an E-Blast into the approval-round stages THROUGH THE UI, the
 * way marketing does, so a spec that needs a real `in_design` or
 * `awaiting_member_approval` row gets one the state machine produced rather
 * than a hand-written INSERT that would have to mirror `broadcast_versions`,
 * the 0308 stage columns and the round counter (and drift from them).
 *
 * Start from a `submitted` row (`seedMemberDetailBroadcast`). Both helpers
 * need `FEATURE_EBLAST_MEMBER_APPROVAL=true` on the server under test — the
 * flag gates the `submitted → in_design` edge (T152), so without it the Start
 * control is absent and the helper fails at its first assertion, loudly.
 *
 * Every locator is scoped to `:visible`: Next keeps the previous segment's DOM
 * hidden after a client navigation.
 */
import type { Page } from '@playwright/test';
import { expect } from '../fixtures';
import { signInAsAdmin } from './admin-session';

/**
 * Sign in as `e2e-admin`, open the E-Blast and start a formatted version.
 * Leaves the row in `in_design` with the working copy open in the workspace.
 */
export async function startFormattedVersionAsMarketing(page: Page, broadcastId: string): Promise<void> {
  await signInAsAdmin(page);
  await page.goto(`/admin/broadcasts/${broadcastId}`);
  const start = page.locator('[data-testid="eblast-start-version"]:visible');
  await expect(start, 'Start is absent — is FEATURE_EBLAST_MEMBER_APPROVAL on for this server?').toBeVisible();
  await start.click();
  // From `submitted`, starting ends approve-as-submitted, so it asks first (UX review M3).
  await page.locator('[data-testid="eblast-start-version-confirm"]:visible').click();
  await expect(page.locator('[data-testid="eblast-format-workspace"]:visible')).toBeVisible({ timeout: 60_000 });
}

/**
 * Start, edit, save and send a formatted version to the member. Leaves the row
 * in `awaiting_member_approval` with one sent version (round 1).
 */
export async function formatAndSendAsMarketing(page: Page, broadcastId: string, subject: string): Promise<void> {
  await startFormattedVersionAsMarketing(page, broadcastId);
  const workspace = page.locator('[data-testid="eblast-format-workspace"]:visible');
  await workspace.locator('#eblast-format-subject').fill(subject);
  await workspace.locator('#eblast-format-note').fill('We moved the date into the heading.');
  await workspace.locator('[data-testid="eblast-format-save"]').click();
  await expect(workspace.getByText(/Saved at/)).toBeVisible();
  await workspace.locator('[data-testid="eblast-send-to-member"]').click();
  await page.locator('[data-testid="eblast-send-to-member-confirm"]:visible').click();
  await expect(page.locator('[data-testid="eblast-whose-turn"]:visible')).toHaveText(/Member/, { timeout: 30_000 });
}

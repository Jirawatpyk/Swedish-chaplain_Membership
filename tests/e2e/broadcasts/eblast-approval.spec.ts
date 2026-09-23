/**
 * F119 T063 (US1-AS1, US1-AS2) — "@eblast marketing formats and sends".
 *
 * On the staff detail page a marketing-capable staff user starts a formatted
 * version of a submitted E-Blast, edits it beside the member's original,
 * saves it and sends it to the member. The page then shows the member's turn
 * and round 1, and the working copy is no longer editable (FR-003).
 *
 * **Needs `FEATURE_EBLAST_MEMBER_APPROVAL=true` on the server under test.**
 * The flag gates the `submitted → in_design` edge (T152), so on a server
 * without it the Start control is absent by design and this spec fails at its
 * first step — loudly, on purpose: it is not skipped, because a skipped
 * acceptance test reads as a passing one (`check:fixme`).
 *
 * Persona: `e2e-admin` signs in (holds `broadcasts.write` + `broadcasts.send`);
 * the E-Blast is owned by `e2e-member-empty`, the in-good-standing persona who
 * HAS a portal user — the send refuses a member company without one
 * (409 `no_portal_user`). The primary `e2e-member` is LAPSED by the F8 fixture.
 *
 * Run: `pnpm test:e2e tests/e2e/broadcasts/eblast-approval.spec.ts --workers=1 --project=chromium`.
 */
import { expect, test } from '../fixtures';
import { signInAsAdmin } from '../helpers/admin-session';
import { seedMemberDetailBroadcast, wipeE2EMemberBroadcasts } from '../helpers/broadcasts-seed';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL_EMPTY;

/** Cold Turbopack compiles (Tiptap especially) dominate. */
test.describe.configure({ timeout: 240_000, retries: 0 });

test.describe('F119 T063 — the staff format surface', () => {
  test('@eblast marketing formats and sends', async ({ page }) => {
    await wipeE2EMemberBroadcasts(MEMBER_EMAIL);
    const broadcastId = await seedMemberDetailBroadcast(MEMBER_EMAIL);
    expect(broadcastId, 'DATABASE_URL + E2E_MEMBER_EMAIL_EMPTY are required to seed the E-Blast').not.toBeNull();

    await signInAsAdmin(page);
    await page.goto(`/admin/broadcasts/${broadcastId}`);

    // Next keeps the previous segment's DOM hidden after a client navigation,
    // so every locator is scoped to what is visible.
    const start = page.locator('[data-testid="eblast-start-version"]:visible');
    await expect(start, 'Start is absent — is FEATURE_EBLAST_MEMBER_APPROVAL on for this server?').toBeVisible();
    await start.click();
    // From `submitted`, starting ends approve-as-submitted, so it asks first (UX review M3).
    await page.locator('[data-testid="eblast-start-version-confirm"]:visible').click();

    const workspace = page.locator('[data-testid="eblast-format-workspace"]:visible');
    await expect(workspace).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid="eblast-member-original"]:visible')).toBeVisible();
    await expect(page.locator('[data-testid="eblast-whose-turn"]:visible')).toHaveText(/Marketing/);

    const subject = '[E2E] Formatted by marketing';
    await workspace.locator('#eblast-format-subject').fill(subject);
    await workspace.locator('#eblast-format-note').fill('We tidied the layout and added a heading.');
    await workspace.locator('[data-testid="eblast-format-save"]').click();
    await expect(workspace.getByText(/Saved at/)).toBeVisible();

    await workspace.locator('[data-testid="eblast-send-to-member"]').click();
    await page.locator('[data-testid="eblast-send-to-member-confirm"]:visible').click();

    // The stage moved: the member's turn, round 1, and no editor any more.
    await expect(page.locator('[data-testid="eblast-whose-turn"]:visible')).toHaveText(/Member/, { timeout: 30_000 });
    await expect(page.locator('[data-testid="eblast-round"]:visible')).toHaveText('1');
    await expect(page.locator('[data-testid="eblast-format-workspace"]:visible')).toHaveCount(0);
    const comparison = page.locator('[data-testid="eblast-version-comparison"]:visible');
    await expect(comparison).toBeVisible();
    await expect(comparison.getByText(subject)).toBeVisible();
  });
});

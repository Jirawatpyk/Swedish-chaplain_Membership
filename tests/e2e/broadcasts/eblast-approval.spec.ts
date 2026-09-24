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
import { formatAndSendAsMarketing } from '../helpers/eblast-approval-flow';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL_EMPTY;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD_EMPTY;

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

/**
 * F119 T086 (US2, FR-008, FR-009, SC-003) — "@eblast member approves on a
 * 375 px viewport".
 *
 * Marketing formats and sends a version (the staff half above, as a setup
 * step), then the owning member signs in on a PHONE-width viewport: the
 * formatted version comes first and the original is below it on the same
 * page (FR-008), Approve is confirmed in a dialog that says marketing now
 * confirms the send time (FR-009), and afterwards the stage banner shows the
 * new stage and the page still offers the way back to the E-Blast list.
 *
 * Same flag requirement as the staff case (T152 gates the first edge), and
 * the member is `e2e-member-empty` — the in-good-standing persona that owns
 * the seeded row and has a portal user. The staff half is
 * `formatAndSendAsMarketing` (`helpers/eblast-approval-flow.ts`), shared with
 * the T086a a11y scan.
 */
test.describe('F119 T086 — the member sign-off view', () => {
  test('@eblast member approves on a 375 px viewport', async ({ page, browser }) => {
    expect(MEMBER_PASSWORD, 'E2E_MEMBER_PASSWORD_EMPTY is required to sign in as the owning member').toBeTruthy();
    await wipeE2EMemberBroadcasts(MEMBER_EMAIL);
    const broadcastId = await seedMemberDetailBroadcast(MEMBER_EMAIL);
    expect(broadcastId, 'DATABASE_URL + E2E_MEMBER_EMAIL_EMPTY are required to seed the E-Blast').not.toBeNull();
    const subject = '[E2E] Ready for the member';
    await formatAndSendAsMarketing(page, broadcastId!, subject);

    // The member, on a phone.
    const phone = await browser.newContext({ viewport: { width: 375, height: 812 } });
    try {
      const member = await phone.newPage();
      await member.goto('/portal/sign-in');
      await member.locator('input#email').fill(MEMBER_EMAIL!);
      await member.locator('input#password').fill(MEMBER_PASSWORD!);
      await member.getByRole('button', { name: /sign in/i }).click();
      await member.waitForURL((u) => /^\/portal(\/|$)/.test(u.pathname) && !u.pathname.startsWith('/portal/sign-in'), {
        timeout: 120_000,
      });
      await member.goto(`/portal/broadcasts/${broadcastId}`);

      // FR-008 — formatted FIRST, the original BELOW it on the same page.
      const formatted = member.locator('[data-testid="eblast-formatted-version"]:visible');
      const original = member.locator('[data-testid="eblast-member-original"]:visible');
      await expect(formatted).toBeVisible({ timeout: 60_000 });
      await expect(formatted.getByText(subject)).toBeVisible();
      await expect(formatted.getByText('We moved the date into the heading.')).toBeVisible();
      const [f, o] = [await formatted.boundingBox(), await original.boundingBox()];
      expect(f, 'formatted card has no box').not.toBeNull();
      expect(o, 'original card has no box').not.toBeNull();
      expect(o!.y).toBeGreaterThan(f!.y + f!.height - 1);
      // Nothing scrolls sideways at phone width.
      expect(await member.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

      // FR-009 — Approve is confirmed, and the dialog says what happens next.
      await member.locator('[data-testid="eblast-approve"]:visible').click();
      const dialog = member.getByRole('alertdialog');
      await expect(dialog).toContainText('will now confirm the send time');
      await expect(dialog).toContainText('cannot change without a new approval');
      await dialog.locator('[data-testid="eblast-approve-confirm"]').click();

      // After the decision: the new stage in the banner, the way back to the list.
      const banner = member.locator('[data-testid="eblast-stage-banner"]:visible');
      // The member's own banner speaks to them (UX review M4).
      await expect(banner).toContainText(/Approved — awaiting schedule/, { timeout: 30_000 });
      await expect(banner).toContainText(/chamber's turn/);
      await expect(member.locator('[data-testid="eblast-approve"]:visible')).toHaveCount(0);
      await expect(member.getByRole('link', { name: /back to/i })).toBeVisible();
    } finally {
      await phone.close();
    }
  });
});

/**
 * F119 UX review H3 — the stage banner at the narrowest phone (320 px) in the
 * longest locale (SV). A Badge is `whitespace-nowrap`, and the SV
 * `member_approved` stage label was wider than the ~246 px the banner leaves
 * at 320 px; the 375 px case above never saw it. Checked at the member's turn
 * and again after approving (the longest stage label), with nothing scrolling
 * sideways and the banner inside the viewport.
 */
test.describe('F119 UX review H3 — the sign-off page at 320 px in Swedish', () => {
  test('@eblast the SV stage banner fits a 320 px viewport, before and after approving', async ({ page, browser }) => {
    expect(MEMBER_PASSWORD, 'E2E_MEMBER_PASSWORD_EMPTY is required to sign in as the owning member').toBeTruthy();
    await wipeE2EMemberBroadcasts(MEMBER_EMAIL);
    const broadcastId = await seedMemberDetailBroadcast(MEMBER_EMAIL);
    expect(broadcastId, 'DATABASE_URL + E2E_MEMBER_EMAIL_EMPTY are required to seed the E-Blast').not.toBeNull();
    await formatAndSendAsMarketing(page, broadcastId!, '[E2E] Swedish at 320 px');

    const phone = await browser.newContext({ viewport: { width: 320, height: 700 } });
    try {
      // The locale cookie before sign-in, so every page renders in Swedish.
      await phone.addCookies([{ name: 'NEXT_LOCALE', value: 'sv', url: 'http://localhost:3100' }]);
      const member = await phone.newPage();
      await member.goto('/portal/sign-in');
      await member.locator('input#email').fill(MEMBER_EMAIL!);
      await member.locator('input#password').fill(MEMBER_PASSWORD!);
      await member.locator('button[type="submit"]').click();
      await member.waitForURL((u) => /^\/portal(\/|$)/.test(u.pathname) && !u.pathname.startsWith('/portal/sign-in'), {
        timeout: 120_000,
      });
      await member.goto(`/portal/broadcasts/${broadcastId}`);

      const banner = member.locator('[data-testid="eblast-stage-banner"]:visible');
      const fits = async (): Promise<void> => {
        expect(await member.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
        const box = await banner.boundingBox();
        expect(box, 'the stage banner has no box').not.toBeNull();
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      };

      // The member's turn: "Inväntar ditt godkännande".
      await expect(banner).toContainText('Inväntar ditt godkännande', { timeout: 60_000 });
      await fits();

      // After approving: the longest stage label, "Godkänd — inväntar schemaläggning".
      await member.locator('[data-testid="eblast-approve"]:visible').click();
      await member.getByRole('alertdialog').locator('[data-testid="eblast-approve-confirm"]').click();
      await expect(banner).toContainText('Godkänd — inväntar schemaläggning', { timeout: 30_000 });
      await fits();
    } finally {
      await phone.close();
    }
  });
});

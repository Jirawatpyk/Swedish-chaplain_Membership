/**
 * F114 — member change-request approval workflow, real-browser E2E
 * (`@change-requests`, `@a11y`). Grows per story: US1 (T044) here; US2
 * (T058), US3 (T066), US4 (T081), US5 (T091), US6 (T104) extend this file.
 *
 * US1 (this block):
 *   1. the `e2e-member-empty` persona (a PRIMARY contact with a login — the
 *      `e2e-member` persona is LAPSED by the F8 fixture) changes their phone on
 *      /portal/edit and submits → /portal/profile shows the "awaiting review"
 *      banner (role=status) and the CONTACT ROW IS UNCHANGED (FR-001), read
 *      straight from the DB;
 *   2. axe (WCAG 2.1 AA) at 320 px on the edit form and on the profile banner;
 *   3. a secondary contact sees no company fields — gated on an
 *      `E2E_MEMBER_SECONDARY_EMAIL` / `_PASSWORD` persona (prod has 0
 *      secondaries with a login — research § V4 — and `seed-e2e-user.ts` mints
 *      none yet), so it skips with a named reason until that seed exists.
 *
 * Gates: `--workers=1` mandatory; skips cleanly when the personas / DATABASE_URL
 * are unset; skips at runtime when the dev server's platform flag is OFF (the
 * gate route answers 404 — FR-039), because the flag is the server's env, not
 * something a spec can flip. The tenant SETTING is flipped on in beforeAll and
 * restored in afterAll.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { fillField } from './fixtures';
import { runAxeScan } from './helpers/axe-scan';
import { signInAsAdmin } from './helpers/admin-session';
import { signInAsManager } from './helpers/manager-session';
import {
  ensureApprovalSetting,
  readContactPhone,
  readMemberDescription,
  resolvePortalMember,
  seedPendingRequest,
  wipeChangeRequestsForUser,
  writeContactPhone,
  type PortalMemberRef,
  type SeededPendingRequest,
} from './helpers/change-request-seed';
import en from '../../src/i18n/messages/en.json';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL_EMPTY;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD_EMPTY;
const SECONDARY_EMAIL = process.env.E2E_MEMBER_SECONDARY_EMAIL;
const SECONDARY_PASSWORD = process.env.E2E_MEMBER_SECONDARY_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const MANAGER_PASSWORD = process.env.E2E_MANAGER_PASSWORD;

const copy = en.portal.changeRequests;
const adminCopy = en.admin.changeRequests;

test.describe.configure({ timeout: 180_000 });

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/portal/sign-in');
  await fillField(page.getByLabel(/email/i), email);
  await fillField(page.getByRole('textbox', { name: /^password$/i }), password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(
    (u) => {
      const p = new URL(u).pathname;
      return p.startsWith('/portal') && !p.startsWith('/portal/sign-in');
    },
    { timeout: 120_000 },
  );
}

/**
 * FR-039 — the platform flag is the server's env; skip (not fail) when it is
 * off. The probe is the member gate route, which answers 404 BEFORE any
 * session work while the flag is off and reaches the session gate once it is
 * on — so a STAFF session (US2 / US3 sign in as admin or manager first) gets
 * 403 there, which still proves the flag is on; the tenant-mode check only
 * applies to the member's own 200 (the first e2e run read the 403 as a
 * failure — fixture bug, not a product one).
 */
async function skipUnlessFlagOn(page: Page): Promise<void> {
  const res = await page.request.get('/api/portal/change-requests/gate');
  test.skip(res.status() === 404, 'FEATURE_MEMBER_CHANGE_APPROVAL is off on the dev server (gate route → 404)');
  expect([200, 401, 403]).toContain(res.status());
  if (res.status() !== 200) return; // a staff session: the flag is on, the mode is the seed's business
  const body = (await res.json()) as { mode: string };
  test.skip(body.mode !== 'approval', `tenant gate is "${body.mode}" — the seed could not switch approval on`);
}

test.describe('@change-requests US1 — member submits, nothing applied, staff notified', () => {
  test.skip(
    !MEMBER_EMAIL || !MEMBER_PASSWORD || !DATABASE_URL,
    'Set E2E_MEMBER_EMAIL_EMPTY + E2E_MEMBER_PASSWORD_EMPTY + DATABASE_URL',
  );

  let member: PortalMemberRef | null = null;
  let previousSetting: boolean | null = null;

  test.beforeAll(async () => {
    previousSetting = await ensureApprovalSetting(true);
    await wipeChangeRequestsForUser(MEMBER_EMAIL!);
    member = await resolvePortalMember(MEMBER_EMAIL!);
  });

  test.afterAll(async () => {
    await wipeChangeRequestsForUser(MEMBER_EMAIL!);
    if (previousSetting !== null) await ensureApprovalSetting(previousSetting);
  });

  test('submit a phone change → pending banner on the profile, record unchanged', async ({ page }) => {
    test.skip(!member, 'persona is not linked to a member — run scripts/seed-e2e-user.ts');
    await signIn(page, MEMBER_EMAIL!, MEMBER_PASSWORD!);
    await skipUnlessFlagOn(page);

    const phoneBefore = await readContactPhone(member!.contactId);
    const proposed = phoneBefore === '+66811111111' ? '+66822222222' : '+66811111111';

    await page.goto('/portal/edit');
    await expect(page.getByRole('heading', { level: 1, name: copy.form.pageTitle })).toBeVisible();
    // FR-010 — the review notice with the privacy link is on the form
    await expect(page.getByTestId('review-notice')).toContainText(copy.form.notice);
    await expect(page.getByTestId('review-notice').getByRole('link', { name: copy.form.privacyLink })).toBeVisible();

    // Dev-mode hydration race (mobile-safari showed it): a `fill` that lands
    // before react-hook-form hydrates is wiped by the hydration reset, and
    // the submit then answers "nothing to submit". Let the page go quiet
    // first, then fill until the value STICKS.
    await page.waitForLoadState('networkidle');
    const phoneField = page.getByLabel(copy.form.fields.phone, { exact: true });
    await expect(async () => {
      await phoneField.fill(proposed);
      await expect(phoneField).toHaveValue(proposed, { timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await page.getByRole('button', { name: copy.form.submit }).click();

    await page.waitForURL('**/portal/profile', { timeout: 60_000 });
    const banner = page.getByTestId('pending-request-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('role', 'status');
    await expect(banner).toContainText(copy.pending.title);
    // the diff row shows the proposed phone and the label
    await expect(banner.getByTestId('change-request-diff')).toContainText(copy.diff.labels.phone);
    await expect(banner.getByTestId('change-request-diff')).toContainText(proposed);

    // FR-001 — the member record is NOT modified
    expect(await readContactPhone(member!.contactId)).toBe(phoneBefore);
  });

  test('resubmitting the same values → "already awaiting review" announced inline, no toast', async ({ page }) => {
    test.skip(!member, 'persona is not linked to a member');
    await signIn(page, MEMBER_EMAIL!, MEMBER_PASSWORD!);
    await skipUnlessFlagOn(page);
    await page.goto('/portal/edit');
    await page.waitForLoadState('networkidle');
    // the form starts from the pending proposal (US5 AS5) — submitting unchanged is "already pending";
    // the click is retried across the dev-mode hydration window (a pre-hydration click no-ops)
    const status = page.getByTestId('submit-status');
    await expect(async () => {
      await page.getByRole('button', { name: copy.form.submit }).click();
      await expect(status).toContainText(copy.status.alreadyPending, { timeout: 5_000 });
    }).toPass({ timeout: 45_000 });
    await expect(page).toHaveURL(/\/portal\/edit$/);
  });

  test('@a11y axe: edit form + profile banner at 320 px', async ({ page }, testInfo) => {
    test.skip(!member, 'persona is not linked to a member');
    await page.setViewportSize({ width: 320, height: 720 });
    await signIn(page, MEMBER_EMAIL!, MEMBER_PASSWORD!);
    await skipUnlessFlagOn(page);
    await page.goto('/portal/edit');
    await expect(page.getByTestId('change-request-form')).toBeVisible();
    await runAxeScan(page, testInfo, { include: 'main' });
    await page.goto('/portal/profile');
    await expect(page.getByTestId('pending-request-banner')).toBeVisible();
    await runAxeScan(page, testInfo, { include: 'main' });
  });

  test('a secondary contact sees only their own fields with the primary-contact note', async ({ page }) => {
    test.skip(
      !SECONDARY_EMAIL || !SECONDARY_PASSWORD,
      'Set E2E_MEMBER_SECONDARY_EMAIL + E2E_MEMBER_SECONDARY_PASSWORD (a secondary contact with a login — no such persona is seeded yet; research § V4)',
    );
    await signIn(page, SECONDARY_EMAIL!, SECONDARY_PASSWORD!);
    await skipUnlessFlagOn(page);
    await page.goto('/portal/edit');
    await expect(page.getByTestId('secondary-note')).toContainText(copy.form.secondaryNote);
    await expect(page.getByLabel(copy.form.fields.companyName, { exact: true })).toHaveCount(0);
    await expect(page.getByLabel(copy.form.fields.phone, { exact: true })).toBeVisible();
  });
});

/**
 * US2 (T058): the staff decision. A pending request is seeded straight into
 * the tables (phone + description) for the `e2e-member-empty` persona; the
 * admin opens the EMAIL deep link (`?submitter=…&state=pending` → redirect to
 * the review page), de-selects the description row, enters a reason and
 * confirms → lands on the member record with the approved phone applied and
 * the description untouched (partial approval, FR-014–FR-016); a manager
 * sees the review page read-only (FR-013); axe at 320 px and desktop.
 */
test.describe('@change-requests US2 — staff decides per field', () => {
  test.skip(
    !MEMBER_EMAIL || !ADMIN_EMAIL || !ADMIN_PASSWORD || !DATABASE_URL,
    'Set E2E_MEMBER_EMAIL_EMPTY + E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD + DATABASE_URL',
  );

  let member: PortalMemberRef | null = null;
  let previousSetting: boolean | null = null;
  let originalPhone: string | null = null;
  let originalDescription: string | null = null;

  async function seed(): Promise<SeededPendingRequest | null> {
    if (!member) return null;
    await wipeChangeRequestsForUser(MEMBER_EMAIL!);
    const proposedPhone = originalPhone === '+66833333333' ? '+66844444444' : '+66833333333';
    return seedPendingRequest(member, {
      phone: proposedPhone,
      description: `e2e proposed description ${Date.now()}`,
      seenPhone: originalPhone,
      seenDescription: originalDescription,
    });
  }

  test.beforeAll(async () => {
    previousSetting = await ensureApprovalSetting(true);
    member = await resolvePortalMember(MEMBER_EMAIL!);
    if (member) {
      originalPhone = await readContactPhone(member.contactId);
      originalDescription = await readMemberDescription(member.memberId);
    }
  });

  test.afterAll(async () => {
    await wipeChangeRequestsForUser(MEMBER_EMAIL!);
    if (member) await writeContactPhone(member.contactId, originalPhone);
    if (previousSetting !== null) await ensureApprovalSetting(previousSetting);
  });

  test('admin: email deep link → review page → de-select one row + reason → member record shows the approved value only', async ({ page }) => {
    test.skip(!member, 'persona is not linked to a member — run scripts/seed-e2e-user.ts');
    const seeded = await seed();
    test.skip(!seeded, 'could not seed a pending request');
    await signInAsAdmin(page);
    await skipUnlessFlagOn(page);

    // FR-011 — the staff email links to the submitter, never a request id
    await page.goto(`/admin/change-requests?submitter=${member!.userId}&state=pending`);
    await page.waitForURL(`**/admin/change-requests/${seeded!.requestId}`, { timeout: 60_000 });
    await expect(page.getByRole('heading', { level: 1, name: adminCopy.review.title })).toBeVisible();
    const table = page.getByTestId('change-request-decision-table');
    await expect(table.locator('[data-field-key="phone"]')).toContainText(seeded!.proposedPhone);
    await expect(table.locator('[data-field-key="description"]')).toContainText(seeded!.proposedDescription);

    // de-select the description row (Space / click both toggle the checkbox)
    const descriptionBox = page.getByTestId('approve-description');
    await expect(descriptionBox).toHaveAttribute('aria-checked', 'true');
    await descriptionBox.click();
    await expect(descriptionBox).toHaveAttribute('aria-checked', 'false');

    await page.getByTestId('confirm-decision').click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    // a rejection is in the decision → focus starts on the REQUIRED reason
    // (review round 1, UX: `initialFocusRef`); the confirm is disabled until
    // a reason is typed
    await expect(page.getByTestId('decision-reason')).toBeFocused();
    const confirm = dialog.getByRole('button', { name: /^Approve 1, reject 1$/ });
    await expect(confirm).toBeDisabled();
    await fillField(page.getByTestId('decision-reason'), 'Please keep the registered description.');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await page.waitForURL(`**/admin/members/${member!.memberId}`, { timeout: 60_000 });
    await expect(page.getByText(seeded!.proposedPhone).first()).toBeVisible();
    // the record: phone applied, description untouched (FR-015 / FR-016)
    expect(await readContactPhone(member!.contactId)).toBe(seeded!.proposedPhone);
    expect(await readMemberDescription(member!.memberId)).toBe(originalDescription);
  });

  test('manager: the review page is read-only — no decision controls, checkboxes disabled', async ({ page }) => {
    test.skip(!member, 'persona is not linked to a member');
    test.skip(!MANAGER_EMAIL || !MANAGER_PASSWORD, 'Set E2E_MANAGER_EMAIL + E2E_MANAGER_PASSWORD');
    const seeded = await seed();
    test.skip(!seeded, 'could not seed a pending request');
    await signInAsManager(page);
    await skipUnlessFlagOn(page);
    await page.goto(`/admin/change-requests/${seeded!.requestId}`);
    await expect(page.getByTestId('review-notice')).toContainText(adminCopy.review.readOnly);
    await expect(page.getByTestId('confirm-decision')).toHaveCount(0);
    await expect(page.getByTestId('approve-phone')).toBeDisabled();
  });

  test('@a11y axe: review page at 320 px and desktop', async ({ page }, testInfo) => {
    test.skip(!member, 'persona is not linked to a member');
    const seeded = await seed();
    test.skip(!seeded, 'could not seed a pending request');
    await signInAsAdmin(page);
    await skipUnlessFlagOn(page);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(`/admin/change-requests/${seeded!.requestId}`);
    await expect(page.getByTestId('change-request-decision-table')).toBeVisible();
    await runAxeScan(page, testInfo, { include: 'main' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByTestId('confirm-decision').click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    // Base UI's invisible focus-guard sentinels (`<span role="button"
    // data-base-ui-focus-guard>`) around the decision AlertDialog trip
    // `aria-command-name` on WebKit — the documented exemption in
    // eventcreate-a11y.spec.ts / idle-warning-a11y.spec.ts
    await runAxeScan(page, testInfo, { exclude: '[data-base-ui-focus-guard]' });
  });
});

/**
 * US3 (T066): the reject path as the MEMBER sees it. A pending request
 * (phone + description) is seeded; the admin rejects BOTH rows with a reason
 * through the decide API (the review-page UI is US2's spec); the member then
 * sees the decision banner on /portal/profile (role=status, reason verbatim,
 * record unchanged), follows "edit and resubmit" to /portal/edit?resubmit=<id>
 * (reason shown, the rejected values prefilled, every field editable), and
 * finally dismisses the banner — it does not come back.
 */
test.describe('@change-requests US3 — member sees the rejection, resubmits, dismisses', () => {
  test.skip(
    !MEMBER_EMAIL || !MEMBER_PASSWORD || !ADMIN_EMAIL || !ADMIN_PASSWORD || !DATABASE_URL,
    'Set E2E_MEMBER_EMAIL_EMPTY + E2E_MEMBER_PASSWORD_EMPTY + E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD + DATABASE_URL',
  );

  let member: PortalMemberRef | null = null;
  let previousSetting: boolean | null = null;
  let originalPhone: string | null = null;
  let originalDescription: string | null = null;
  const REASON = 'Please use the registered phone number and description.';

  test.beforeAll(async () => {
    previousSetting = await ensureApprovalSetting(true);
    member = await resolvePortalMember(MEMBER_EMAIL!);
    if (member) {
      originalPhone = await readContactPhone(member.contactId);
      originalDescription = await readMemberDescription(member.memberId);
    }
  });

  test.afterAll(async () => {
    await wipeChangeRequestsForUser(MEMBER_EMAIL!);
    if (previousSetting !== null) await ensureApprovalSetting(previousSetting);
  });

  test('reject all with a reason → decision banner, record unchanged, resubmit prefilled, dismiss sticks', async ({ page }) => {
    test.skip(!member, 'persona is not linked to a member — run scripts/seed-e2e-user.ts');
    await wipeChangeRequestsForUser(MEMBER_EMAIL!);
    const seeded = await seedPendingRequest(member!, {
      phone: originalPhone === '+66855555555' ? '+66866666666' : '+66855555555',
      description: `e2e rejected description ${Date.now()}`,
      seenPhone: originalPhone,
      seenDescription: originalDescription,
    });
    test.skip(!seeded, 'could not seed a pending request');

    // the admin rejects both rows through the API (US2's spec drives the UI)
    await signInAsAdmin(page);
    await skipUnlessFlagOn(page);
    // `page.request` sends no Origin; the proxy's CSRF allow-list refuses a
    // state-changing /api call without one (`missing-origin` → 403)
    const decideRes = await page.request.post(`/api/admin/change-requests/${seeded!.requestId}/decide`, {
      headers: { Origin: new URL(page.url()).origin },
      data: {
        decisions: [
          { key: 'phone', outcome: 'rejected' },
          { key: 'description', outcome: 'rejected' },
        ],
        reason: REASON,
        note: null,
      },
    });
    expect(decideRes.status()).toBe(200);
    expect(((await decideRes.json()) as { request: { outcome: string } }).request.outcome).toBe('rejected');
    // FR-015 / US3 AS2 — nothing applied
    expect(await readContactPhone(member!.contactId)).toBe(originalPhone);
    expect(await readMemberDescription(member!.memberId)).toBe(originalDescription);

    // the member: decision banner on the profile
    await page.context().clearCookies();
    await signIn(page, MEMBER_EMAIL!, MEMBER_PASSWORD!);
    await page.goto('/portal/profile');
    const banner = page.getByTestId('decision-outcome-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('role', 'status');
    await expect(banner).toHaveAttribute('data-outcome', 'rejected');
    await expect(banner).toContainText(copy.outcome.title.rejected);
    await expect(banner.getByTestId('decision-reason')).toContainText(REASON);
    await expect(banner.getByTestId('change-request-diff')).toContainText(copy.diff.outcome.rejected);

    // edit and resubmit → prefilled with exactly the rejected values, reason shown
    await banner.getByTestId('resubmit-link').click();
    await page.waitForURL(`**/portal/edit?resubmit=${seeded!.requestId}`);
    await expect(page.getByTestId('resubmit-reason')).toContainText(REASON);
    await expect(page.getByLabel(copy.form.fields.phone, { exact: true })).toHaveValue(seeded!.proposedPhone);
    await expect(page.getByLabel(copy.form.fields.description, { exact: true })).toHaveValue(seeded!.proposedDescription);
    // a required field's label carries the aria-hidden RequiredMark ("*"), so
    // the exact-name match used for the optional fields above does not apply
    await expect(page.getByLabel(copy.form.fields.companyName)).toBeEditable();

    // dismiss → the banner is gone and stays gone after a reload. The click
    // is retried until the banner unmounts: in dev mode Playwright can click
    // the server-rendered button BEFORE the client component hydrates, so the
    // handler is not attached yet and the click no-ops (the precedent in
    // admin-pending-reactivation.spec.ts); the acknowledge POST is idempotent
    // (a second call keeps the first stamp), so re-clicking is safe.
    await page.goto('/portal/profile');
    await expect(async () => {
      const dismiss = page.getByTestId('dismiss-decision');
      if ((await dismiss.count()) > 0) await dismiss.click();
      await expect(page.getByTestId('decision-outcome-banner')).toHaveCount(0, { timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    // the dismiss ends with `router.refresh()`; reloading while that RSC
    // fetch is in flight surfaces as a WebKit "Load failed" pageerror
    await page.waitForLoadState('networkidle');
    await page.reload();
    await expect(page.getByTestId('decision-outcome-banner')).toHaveCount(0);
  });

  test('@a11y axe: profile with the decision banner + the resubmit form at 320 px', async ({ page }, testInfo) => {
    test.skip(!member, 'persona is not linked to a member');
    await wipeChangeRequestsForUser(MEMBER_EMAIL!);
    const seeded = await seedPendingRequest(member!, {
      phone: '+66877777777',
      description: `e2e a11y description ${Date.now()}`,
      seenPhone: originalPhone,
      seenDescription: originalDescription,
    });
    test.skip(!seeded, 'could not seed a pending request');
    await signInAsAdmin(page);
    await skipUnlessFlagOn(page);
    const decideRes = await page.request.post(`/api/admin/change-requests/${seeded!.requestId}/decide`, {
      headers: { Origin: new URL(page.url()).origin },
      data: { decisions: [{ key: 'phone', outcome: 'rejected' }, { key: 'description', outcome: 'rejected' }], reason: REASON, note: null },
    });
    expect(decideRes.status()).toBe(200);
    await page.context().clearCookies();
    await page.setViewportSize({ width: 320, height: 720 });
    await signIn(page, MEMBER_EMAIL!, MEMBER_PASSWORD!);
    await page.goto('/portal/profile');
    await expect(page.getByTestId('decision-outcome-banner')).toBeVisible();
    await runAxeScan(page, testInfo, { include: 'main' });
    await page.goto(`/portal/edit?resubmit=${seeded!.requestId}`);
    await expect(page.getByTestId('resubmit-reason')).toBeVisible();
    await runAxeScan(page, testInfo, { include: 'main' });
  });
});

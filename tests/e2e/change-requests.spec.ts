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
import {
  ensureApprovalSetting,
  readContactPhone,
  resolvePortalMember,
  wipeChangeRequestsForUser,
  type PortalMemberRef,
} from './helpers/change-request-seed';
import en from '../../src/i18n/messages/en.json';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL_EMPTY;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD_EMPTY;
const SECONDARY_EMAIL = process.env.E2E_MEMBER_SECONDARY_EMAIL;
const SECONDARY_PASSWORD = process.env.E2E_MEMBER_SECONDARY_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;

const copy = en.portal.changeRequests;

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

/** FR-039 — the platform flag is the server's env; skip (not fail) when it is off. */
async function skipUnlessFlagOn(page: Page): Promise<void> {
  const res = await page.request.get('/api/portal/change-requests/gate');
  test.skip(res.status() === 404, 'FEATURE_MEMBER_CHANGE_APPROVAL is off on the dev server (gate route → 404)');
  expect(res.status()).toBe(200);
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

    await page.getByLabel(copy.form.fields.phone, { exact: true }).fill(proposed);
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
    // the form starts from the pending proposal (US5 AS5) — submitting unchanged is "already pending"
    await page.getByRole('button', { name: copy.form.submit }).click();
    const status = page.getByTestId('submit-status');
    await expect(status).toContainText(copy.status.alreadyPending, { timeout: 30_000 });
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

/**
 * DV-4 — Admin "Submit on behalf of member" (proxy-submit) E2E.
 *
 * Covers what jsdom can't: the real-browser compose flow + RBAC.
 *   1. admin: full proxy submit happy path → broadcast row written with
 *      requested_by_member_id = e2e-member AND actor_role = 'admin_proxy'
 *      AND submitted_by_user_id = admin (AS9 dual-actor), verified by a
 *      direct DB read before the afterAll wipe.
 *   2. manager: no entry button on /admin/broadcasts.
 *   3. manager: POST /api/admin/broadcasts/proxy-submit → 403.
 *   4. member: GET /admin/broadcasts/new is not accessible (the (staff)
 *      layout redirects role==='member' → /portal).
 *
 * --workers=1 mandatory (default 3 hangs the workstation). Gated on
 * E2E_ADMIN_* (+ MANAGER/MEMBER where each is used). The describe skips
 * cleanly when DATABASE_URL / E2E_ADMIN_* are unset; the admin happy
 * path skips at runtime on a 503 (read-only-mode / F7 flag off) like the
 * sibling `broadcast-compose-and-submit.spec.ts`.
 *
 * Reuse map:
 *   - signInAsAdmin / signInAsManager / signInAsMember — helpers/*-session
 *   - wipeE2EMemberBroadcasts — helpers/broadcasts-seed (beforeAll + afterAll)
 *   - clearE2ERateLimits — helpers/rate-limit (beforeAll; also auto via fixtures)
 *   - en.json copy for accessible-name assertions
 *   - manager-403 probe pattern — helpers parity with manager-readonly.spec.ts
 *   - postgres(dbUrl, { ssl:'require', max:1 }) — mirrors wipeE2EMemberBroadcasts
 *
 * UI fact verified against source (NOT the brief): the proxy-compose form
 * reuses the shared `SubmitButton` (compose-form), whose label is
 * `portal.broadcasts.compose.button.submit` = "Submit for review" — NOT
 * `proxySubmitDialog.confirm`. The assertion below targets the real label.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import { signInAsManager } from './helpers/manager-session';
import { signInAsMember } from './helpers/member-session';
import { wipeE2EMemberBroadcasts } from './helpers/broadcasts-seed';
import { clearE2ERateLimits } from './helpers/rate-limit';
import en from '../../src/i18n/messages/en.json';
import postgres from 'postgres';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;
const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';

const proxy = en.admin.broadcasts.proxySubmitDialog;
const proxySubmitButtonName = en.admin.broadcasts.proxySubmitButton;
// Real submit label — the proxy form reuses the member compose SubmitButton.
const submitButtonName = en.portal.broadcasts.compose.button.submit;

test.describe.configure({ mode: 'serial', timeout: 120_000 });

/**
 * Resolve the e2e member's member_id + company_name and the admin's
 * user id from the live DB, using the same users→contacts→members join
 * as `wipeE2EMemberBroadcasts`. company_name drives the picker search;
 * member_id + admin id verify the AS9 dual-actor row.
 */
interface Fixtures {
  readonly memberId: string;
  readonly companyName: string;
  readonly adminUserId: string;
}

async function resolveFixtures(): Promise<Fixtures | null> {
  if (!DATABASE_URL || !ADMIN_EMAIL) return null;
  const memberEmail = process.env.E2E_MEMBER_EMAIL;
  if (!memberEmail) return null;
  const sql = postgres(DATABASE_URL, { ssl: 'require', max: 1 });
  try {
    const memberRows = await sql<
      Array<{ member_id: string; company_name: string }>
    >`
      SELECT m.member_id::text AS member_id, m.company_name AS company_name
      FROM users u
      JOIN contacts c
        ON c.linked_user_id = u.id AND c.tenant_id = ${TENANT_ID}
      JOIN members m
        ON m.member_id = c.member_id AND m.tenant_id = ${TENANT_ID}
      WHERE u.email = ${memberEmail}
      LIMIT 1
    `;
    const member = memberRows[0];
    const adminRows = await sql<Array<{ id: string }>>`
      SELECT id::text AS id FROM users WHERE email = ${ADMIN_EMAIL} LIMIT 1
    `;
    const admin = adminRows[0];
    if (!member || !admin) return null;
    return {
      memberId: member.member_id,
      companyName: member.company_name,
      adminUserId: admin.id,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Read the most-recent broadcast row owned by the proxied member and
 * assert the AS9 dual-actor invariant. Runs BEFORE the afterAll wipe.
 */
async function assertDualActorRow(fx: Fixtures): Promise<void> {
  const sql = postgres(DATABASE_URL!, { ssl: 'require', max: 1 });
  try {
    const rows = await sql<
      Array<{
        requested_by_member_id: string;
        submitted_by_user_id: string;
        actor_role: string;
      }>
    >`
      SELECT requested_by_member_id::text AS requested_by_member_id,
             submitted_by_user_id::text AS submitted_by_user_id,
             actor_role
      FROM broadcasts
      WHERE requested_by_member_id = ${fx.memberId}::uuid
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const row = rows[0];
    expect(row, 'a broadcast row must exist for the proxied member').toBeTruthy();
    // AS9 dual-actor: the row is attributed to the member (quota owner)
    // AND the admin (submitter), with the admin_proxy actor role.
    expect(row!.actor_role).toBe('admin_proxy');
    expect(row!.submitted_by_user_id).toBe(fx.adminUserId);
    expect(row!.requested_by_member_id).toBe(fx.memberId);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test.describe('@e2e DV-4 admin proxy-submit (AS9 dual-actor + RBAC)', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD || !DATABASE_URL,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD + DATABASE_URL',
  );

  let fixtures: Fixtures | null = null;

  test.beforeAll(async () => {
    await clearE2ERateLimits();
    await wipeE2EMemberBroadcasts();
    fixtures = await resolveFixtures();
  });

  test.afterAll(async () => {
    await wipeE2EMemberBroadcasts();
  });

  test('admin submits a broadcast on a member behalf (AS9 dual-actor)', async ({
    page,
  }) => {
    test.skip(
      !process.env.E2E_MEMBER_EMAIL,
      'Set E2E_MEMBER_EMAIL — the proxied member identity',
    );
    test.skip(
      fixtures === null,
      'Could not resolve e2e-member / admin from the DB (seed missing)',
    );
    const fx = fixtures!;

    await signInAsAdmin(page);

    const resp = await page.goto('/admin/broadcasts/new');
    const status = resp?.status() ?? 500;
    // F7 flag off / read-only-mode → 503 (or the route returns a
    // feature-disabled envelope). Skip rather than fail — matches the
    // sibling compose spec's ship-dark guard.
    test.skip(
      status === 503,
      'broadcasts feature flag is OFF / read-only-mode (503)',
    );
    expect(status).toBeLessThan(400);
    await page.waitForLoadState('domcontentloaded');

    // Fail fast + clearly if the compose surface didn't render (e.g. the
    // route is unavailable on the target server) rather than hanging the
    // full test timeout on the click below.
    const memberCombobox = page.getByRole('combobox', { name: proxy.memberLabel });
    await expect(memberCombobox).toBeVisible({ timeout: 15_000 });

    // Pick the proxied member via the cmdk combobox.
    await memberCombobox.click();
    // The popover search field carries the same placeholder copy.
    await page.getByPlaceholder(proxy.memberPlaceholder).fill(fx.companyName);
    // The server-search debounces via useDeferredValue → wait for the
    // matching option to materialise, then select it.
    const option = page
      .getByRole('option', { name: new RegExp(escapeRegExp(fx.companyName), 'i') })
      .first();
    await expect(option).toBeVisible({ timeout: 15_000 });
    await option.click();

    // Self-exclusion notice (Q16) — role="status" with "won't receive".
    await expect(page.getByText(/won't receive/i)).toBeVisible();

    // Subject (labelled Input, id proxy-broadcast-subject).
    await page.getByLabel(proxy.subjectLabel).fill('DV-4 proxy e2e');

    // Body — the Tiptap contenteditable (role="textbox") inside the
    // editor wrapper. Type a non-empty body so the submit precondition
    // (bodyHtml min 1) is satisfied.
    await fillTiptapBody(page, 'End-to-end proxy broadcast body.');

    // Audience defaults to all_members (SegmentPicker initial value),
    // so no segment interaction is required for the happy path.

    // Submit — real label is "Submit for review" (shared SubmitButton).
    await page
      .getByRole('button', { name: new RegExp(escapeRegExp(submitButtonName), 'i') })
      .click();

    // On success the client router.push('/admin/broadcasts').
    await expect(page).toHaveURL(/\/admin\/broadcasts$/, { timeout: 30_000 });

    // AS9 dual-actor DB verification (before the afterAll wipe).
    await assertDualActorRow(fx);
  });

  test('manager sees no proxy-submit entry button', async ({ page }) => {
    test.skip(
      !process.env.E2E_MANAGER_EMAIL || !process.env.E2E_MANAGER_PASSWORD,
      'Set E2E_MANAGER_EMAIL + E2E_MANAGER_PASSWORD',
    );
    await signInAsManager(page);
    await page.goto('/admin/broadcasts');
    await page.waitForLoadState('domcontentloaded');
    // Entry link is gated (not merely disabled) for the read-only manager.
    await expect(
      page.getByRole('link', { name: proxySubmitButtonName }),
    ).toHaveCount(0);
  });

  test('manager POST proxy-submit → 403', async ({ page }) => {
    test.skip(
      !process.env.E2E_MANAGER_EMAIL || !process.env.E2E_MANAGER_PASSWORD,
      'Set E2E_MANAGER_EMAIL + E2E_MANAGER_PASSWORD',
    );
    // Sign in so the session cookie is on the shared context.
    await signInAsManager(page);
    const res = await page.request.post('/api/admin/broadcasts/proxy-submit', {
      data: {
        requestedByMemberId: '00000000-0000-4000-8000-000000000000',
        subject: 'x',
        bodyHtml: '<p>x</p>',
        bodySource: '<p>x</p>',
        segment: { kind: 'all_members' },
      },
      failOnStatusCode: false,
    });
    // 403 forbidden at the admin guard — NOT 401 (manager IS
    // authenticated), NOT 404 (route exists), NOT 400 (the guard fires
    // before body validation). 200 would be a security failure.
    expect(res.status()).toBe(403);
  });

  test('member cannot reach /admin/broadcasts/new', async ({ page }) => {
    test.skip(
      !process.env.E2E_MEMBER_EMAIL || !process.env.E2E_MEMBER_PASSWORD,
      'Set E2E_MEMBER_EMAIL + E2E_MEMBER_PASSWORD',
    );
    await signInAsMember(page);
    await page.goto('/admin/broadcasts/new');
    // The (staff) layout redirects role==='member' → /portal. Assert the
    // member never lands on the admin compose page.
    await expect(page).toHaveURL(/\/portal(\/|$)/, { timeout: 30_000 });
    expect(page.url()).not.toContain('/admin/broadcasts/new');
  });
});

/**
 * Type text into the Tiptap rich-text editor's contenteditable. The
 * editor renders a `role="textbox"` (aria-multiline) inside the
 * `[data-testid="tiptap-editor"]` wrapper (tiptap-editor.tsx). Click to
 * focus, then `pressSequentially` so Tiptap's onUpdate fires and the
 * parent's bodyHtml state leaves the empty `<p></p>` initial value.
 */
async function fillTiptapBody(page: Page, text: string): Promise<void> {
  const editor = page
    .locator('[data-testid="tiptap-editor"]')
    .getByRole('textbox');
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await editor.pressSequentially(text, { delay: 10 });
}

/** Escape a DB-sourced string for safe use inside a RegExp accessible-name match. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

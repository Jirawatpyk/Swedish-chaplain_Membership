/**
 * T046 (016 PR 3, US1) — super_admin persona on the ON leg (flag ON + Migration C).
 *
 * The other half of the US1 independent test (spec §US1): the super_admin can
 * reach and operate the surfaces D4 narrowed away from plain admins — invite
 * staff, change a role (the PR-3 picker), open the audit log, see a non-empty
 * command palette, and reach the erasure-log nav entry. Also carries the
 * retrofitted users-PAGE + dialog axe evidence (the plain-admin persona in T045
 * 404s on the page and can never render it).
 *
 * Preconditions identical to T045 — FEATURE_RBAC_V2=true + Migration C on dev +
 * `scripts/seed-e2e-user.ts` re-run (which mints E2E_SUPER_ADMIN_*), gated by
 * `E2E_RBAC_V2_ON=true`. Run:
 *   `pnpm test:e2e --grep "rbac-super-admin-persona" --workers=1`
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import { signInAsSuperAdmin } from './helpers/admin-session';

const SUPER_ADMIN_EMAIL = process.env.E2E_SUPER_ADMIN_EMAIL;
const RBAC_V2_ON = process.env.E2E_RBAC_V2_ON === 'true';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

/** Palette accelerator — same form the proven command-palette spec uses. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test.describe('T046 RBAC v2 — super_admin persona (ON leg) @a11y', () => {
  test.skip(
    !SUPER_ADMIN_EMAIL || !RBAC_V2_ON,
    'ON-leg suite: needs FEATURE_RBAC_V2=true + Migration C on dev + E2E_SUPER_ADMIN_* ' +
      '(re-run scripts/seed-e2e-user.ts), then set E2E_RBAC_V2_ON=true. See runbook §dev-branch.',
  );

  // The sign-in helper budgets 60s for `waitForURL` (bumped in R9.B1 to absorb
  // a Turbopack cold compile of `/admin`). Playwright's 30s TEST timeout caps
  // the whole `beforeEach`, so that 60s was unreachable and the suite only ever
  // passed against an already-warm server. `global-setup.ts` now warms the
  // routes, and this makes the helper's stated budget actually reachable if a
  // compile still lands here.
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ page }) => {
    await signInAsSuperAdmin(page);
  });

  test('reaches /admin/users and can open the invite dialog with the super_admin option', async ({
    page,
  }) => {
    await page.goto('/admin/users', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /users/i, level: 1 })).toBeVisible();

    await page.getByRole('button', { name: /invite user/i }).click();
    // The invite dialog's role select now offers Super Admin (PR 3 assignable).
    await expect(page.getByRole('dialog')).toBeVisible();
    // Target the trigger by its explicit id rather than an accessible name: the
    // dialog also renders the MemberPicker combobox, so a bare
    // getByRole('combobox') is ambiguous under strict mode, and the Base UI
    // Select trigger's name derives from a <Label htmlFor> association that is
    // not worth betting the assertion on.
    await page.locator('#invite-role').click();
    await expect(page.getByRole('option', { name: /super admin/i })).toBeVisible();
  });

  test('can open the change-role picker on a staff row (all four staff roles)', async ({
    page,
  }) => {
    await page.goto('/admin/users', { waitUntil: 'domcontentloaded' });
    // The seeded population includes staff rows (e2e-admin, e2e-manager); the
    // "Change role" trigger renders for a super_admin viewer on each.
    await page.getByRole('button', { name: /change role/i }).first().click();

    // The picker offers the four STAFF roles. `marketing` moved from absent to
    // present in PR 4 (T059) — PR 3 deliberately shipped the role unassignable,
    // and this case asserted that state. `member` stays out: it is not a staff
    // role, and promoting a member from this table would strand their portal
    // access. That distinction is the reason the list is not simply `ROLES`.
    await expect(page.getByRole('radio', { name: /^super admin$/i })).toBeVisible();
    await expect(page.getByRole('radio', { name: /^admin$/i })).toBeVisible();
    await expect(page.getByRole('radio', { name: /^manager$/i })).toBeVisible();
    await expect(page.getByRole('radio', { name: /^marketing$/i })).toBeVisible();
    await expect(page.getByRole('radio', { name: /^member$/i })).toHaveCount(0);
  });

  test('finalFocus: closing the change-role picker keeps focus OFF <body> (CHK050 / C1)', async ({
    page,
  }) => {
    // The parent mounts the picker unconditionally so Base UI runs its close
    // cycle + finalFocus (016 UX review C1). Without that, focus drops to
    // <body> on close. Assert the CHK050 measure (activeElement !== body) after
    // the Cancel close; the success close runs the identical cycle.
    await page.goto('/admin/users', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /change role/i }).first().click();
    await expect(page.getByRole('radio', { name: /^manager$/i })).toBeVisible();
    await page.getByRole('button', { name: /^cancel$/i }).click();
    await expect(page.getByRole('radio', { name: /^manager$/i })).toHaveCount(0);
    // Read activeElement directly — that IS the CHK050 measure. `expect(body)
    // .not.toBeFocused()` would also pass when focus sits on a DETACHED node,
    // which is the very failure mode being guarded.
    const activeTag = await page.evaluate(() => document.activeElement?.tagName ?? 'NONE');
    expect(activeTag, 'focus must not fall back to <body> after the dialog closes').not.toBe(
      'BODY',
    );
  });

  test('reaches the audit log', async ({ page }) => {
    const audit = await page.context().request.get('/admin/audit', {
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    expect(audit.status(), '/admin/audit must render for a super_admin').toBeLessThan(400);
  });

  test('the erasure-log nav entry is present in the sidebar', async ({ page, isMobile }) => {
    // Desktop rail only — mobile renders the nav inside a closed Sheet, so the
    // link is legitimately absent from the DOM (idiom: nav-a11y.spec.ts:124).
    test.skip(isMobile === true, 'Desktop rail only — mobile renders the nav in a Sheet');
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('link', { name: /erasure log/i })).toBeVisible();
  });

  test('command palette surfaces ADMIN-tier actions for a super_admin (D16 client mirror)', async ({
    page,
  }) => {
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    // Accelerator + dialog name match the proven command-palette spec.
    await page.keyboard.press(`${MOD}+KeyK`);
    const palette = page.getByRole('dialog', { name: /command palette/i });
    await expect(palette).toBeVisible();

    // The palette deliberately renders NOTHING until a query is typed
    // (command-palette.tsx swaps in EMPTY_RESULTS while the query is blank), so
    // asserting options on the bare open would always fail.
    //
    // "audit" matches the STATIC action registry entry `audit.view`
    // (search-plans.ts ACTION_REGISTRY — label key 'palette.actions.viewAuditLog'),
    // so this assertion is data-independent: it needs no seeded plan or member.
    // It also directly proves the D16 client mirror fix — before it, a promoted
    // super_admin fell through a raw `role === 'admin'` check and received
    // `actions: []`, leaving this option missing while the server sent it.
    //
    // Wait for the SEARCH RESPONSE rather than racing the default expect
    // timeout: the palette debounces through `useDeferredValue` and then fetches
    // /api/plans/search, whose first hit pays a Turbopack cold compile. Without
    // this the test is flaky — it failed once and passed on retry during the
    // first real execution of this suite.
    const searchDone = page.waitForResponse(
      (r) => r.url().includes('/api/plans/search') && r.status() === 200,
      { timeout: 60_000 },
    );
    await palette.getByRole('combobox').fill('audit');
    await searchDone;
    await expect(palette.getByRole('option', { name: /view audit log/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('axe-core WCAG 2.1/2.2 AA — users page + change-role picker + invite dialog', async ({
    page,
  }) => {
    await page.goto('/admin/users', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /users/i, level: 1 })).toBeVisible();

    // Scan #1 — the retrofitted users page (static).
    expect(
      (await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze()).violations,
    ).toEqual([]);

    // Scan #2 — the change-role picker open (RadioGroup + inline-error region).
    await page.getByRole('button', { name: /change role/i }).first().click();
    await expect(page.getByRole('radio', { name: /^manager$/i })).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze()).violations,
    ).toEqual([]);
    await page.keyboard.press('Escape');

    // Scan #3 — the invite dialog open.
    await page.getByRole('button', { name: /invite user/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze()).violations,
    ).toEqual([]);
  });
});

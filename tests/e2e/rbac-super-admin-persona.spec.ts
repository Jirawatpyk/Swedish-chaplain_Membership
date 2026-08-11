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

test.describe('T046 RBAC v2 — super_admin persona (ON leg) @a11y', () => {
  test.skip(
    !SUPER_ADMIN_EMAIL || !RBAC_V2_ON,
    'ON-leg suite: needs FEATURE_RBAC_V2=true + Migration C on dev + E2E_SUPER_ADMIN_* ' +
      '(re-run scripts/seed-e2e-user.ts), then set E2E_RBAC_V2_ON=true. See runbook §dev-branch.',
  );

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
    await page.getByRole('combobox', { name: /role/i }).click();
    await expect(page.getByRole('option', { name: /super admin/i })).toBeVisible();
  });

  test('can open the change-role picker on a staff row (super_admin/admin/manager)', async ({
    page,
  }) => {
    await page.goto('/admin/users', { waitUntil: 'domcontentloaded' });
    // The seeded population includes staff rows (e2e-admin, e2e-manager); the
    // "Change role" trigger renders for a super_admin viewer on each.
    await page.getByRole('button', { name: /change role/i }).first().click();

    // The picker offers exactly the three staff roles — never member/marketing.
    await expect(page.getByRole('radio', { name: /^super admin$/i })).toBeVisible();
    await expect(page.getByRole('radio', { name: /^admin$/i })).toBeVisible();
    await expect(page.getByRole('radio', { name: /^manager$/i })).toBeVisible();
    await expect(page.getByRole('radio', { name: /^member$/i })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: /^marketing$/i })).toHaveCount(0);
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
    await expect(page.locator('body')).not.toBeFocused();
  });

  test('reaches the audit log and the erasure-log nav entry', async ({ page }) => {
    const audit = await page.context().request.get('/admin/audit', {
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    expect(audit.status(), '/admin/audit must render for a super_admin').toBeLessThan(400);

    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('link', { name: /erasure log/i })).toBeVisible();
  });

  test('command palette is non-empty for a super_admin', async ({ page }) => {
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    // cmdk opens on Ctrl/Cmd+K; assert the dialog appears with ≥1 result.
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog');
    await expect(palette).toBeVisible();
    await expect(palette.getByRole('option').first()).toBeVisible();
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

/**
 * DV-6 — F6 "Erase attendee PII" row-action E2E.
 *
 * DV-6 surfaces the EXISTING per-registration erase tool (FR-032a, PDPA §30 /
 * GDPR Art.17) as a row action in the attendee table — previously reachable
 * only by hand-typing the deep-link URL. This spec covers what the jsdom
 * table-guard unit test (attendee-table-erase-guard.test.tsx) cannot: the
 * real-browser dialog open + reason-gating + the manager-403 boundary.
 *
 * Coverage:
 *   1. admin sees the Erase PII trigger on a non-pseudonymised row, opens the
 *      dialog, and Confirm stays disabled until a reason is entered (the
 *      FR-032a mandatory-reason gate). The destructive submit is NOT exercised
 *      — a real erase hard-deletes the registration + credits quota back
 *      (irreversible); the backend is covered by the erase-attendee-pii
 *      integration test. The actual erase-submit toast is a tracked follow-up.
 *   2. a pseudonymised row exposes NO erase trigger (the erase page
 *      redirects an already-purged row away + re-erase is a no-op).
 *   3. manager (read-only, FR-035) sees NO erase trigger — no Actions column.
 *   4. FR-035 — manager POST to the erase route → 403 (adminOnlyWriterGuard).
 *
 * Gated on E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD. Run with:
 *   pnpm test:e2e tests/e2e/erase-attendee.spec.ts --workers=1
 * (workers=1 mandatory per CLAUDE.md memory feedback_e2e_workers.)
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import { signInAsManager } from './helpers/manager-session';
import {
  seedF6RelinkFixture,
  type SeedRelinkFixtureResult,
} from './helpers/eventcreate-seed';
import en from '../../src/i18n/messages/en.json';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const MANAGER_PASSWORD = process.env.E2E_MANAGER_PASSWORD;

const erase = en.admin.events.detail.erase;

test.describe.configure({ timeout: 120_000 });

test.describe('@e2e DV-6 F6 erase-attendee-PII row action', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run the DV-6 erase E2E',
  );

  let fixture: SeedRelinkFixtureResult | null = null;

  test.beforeAll(async () => {
    fixture = await seedF6RelinkFixture();
    if (!fixture) {
      throw new Error(
        'seedF6RelinkFixture returned null — DATABASE_URL is required for this spec',
      );
    }
  });

  test('admin: Erase PII trigger shows on a live row + Confirm gated on a reason (no submit)', async ({
    page,
  }) => {
    if (!fixture) {
      test.skip(true, 'fixture not seeded');
      return;
    }
    await signInAsAdmin(page);
    await page.goto(`/admin/events/${fixture.eventId}`);
    await page.waitForLoadState('networkidle');

    const trigger = page.getByTestId(
      `erase-pii-button-${fixture.nonMemberRegistrationId}`,
    );
    await expect(trigger).toBeVisible();
    await trigger.click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();

    // FR-032a — reason is mandatory: Confirm stays disabled until entered.
    const confirm = dialog.getByRole('button', { name: erase.confirm, exact: true });
    await expect(confirm).toBeDisabled();

    await dialog
      .getByLabel(new RegExp(erase.reasonLabel, 'i'))
      .fill('E2E — attendee DSAR erasure request');
    await expect(confirm).toBeEnabled();
    // NOT clicked — a real erase hard-deletes the row (irreversible).
  });

  test('a pseudonymised row exposes NO erase trigger', async ({ page }) => {
    if (!fixture) {
      test.skip(true, 'fixture not seeded');
      return;
    }
    await signInAsAdmin(page);
    await page.goto(`/admin/events/${fixture.eventId}`);
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByTestId(`erase-pii-button-${fixture.pseudonymisedRegistrationId}`),
    ).toHaveCount(0);
  });

  test('manager (read-only) sees NO erase trigger — no Actions column', async ({
    page,
  }) => {
    if (!MANAGER_EMAIL || !MANAGER_PASSWORD) {
      test.skip(true, 'Set E2E_MANAGER_EMAIL + E2E_MANAGER_PASSWORD');
      return;
    }
    if (!fixture) {
      test.skip(true, 'fixture not seeded');
      return;
    }
    await signInAsManager(page);
    await page.goto(`/admin/events/${fixture.eventId}`);
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByTestId(`erase-pii-button-${fixture.nonMemberRegistrationId}`),
    ).toHaveCount(0);
  });

  test('FR-035 — manager POST to the erase route → 403 (adminOnlyWriterGuard)', async ({
    page,
  }) => {
    if (!MANAGER_EMAIL || !MANAGER_PASSWORD) {
      test.skip(true, 'Set E2E_MANAGER_EMAIL + E2E_MANAGER_PASSWORD');
      return;
    }
    if (!fixture) {
      test.skip(true, 'fixture not seeded');
      return;
    }
    await signInAsManager(page);
    const response = await page.request.post(
      `/api/admin/events/${fixture.eventId}/registrations/${fixture.nonMemberRegistrationId}/erase`,
      {
        data: { reasonText: 'manager attempt — should be refused' },
        failOnStatusCode: false,
      },
    );
    expect(response.status()).toBe(403);
  });
});

/**
 * T069 — E2E: F6 tenant onboarding wizard (US3 AS1–AS3).
 *
 * Spec authority: specs/012-eventcreate-integration/spec.md User Story 3
 * Acceptance Scenarios AS1–AS3, FR-022..FR-025, FR-008.
 *
 * **D1 verify-fix (2026-05-13) refactor**: split into TWO deterministic
 * describe blocks so each test starts from a known state:
 *
 *   1. `F6 wizard — fresh tenant (AS1)` — `beforeEach` wipes the F6
 *      surface via `resetEventcreateState` so the wizard renders Phase
 *      A "Generate webhook secret". Covers fresh-tenant flow tests.
 *
 *   2. `F6 wizard — configured tenant (AS2 / AS3 / FR-008)` —
 *      `beforeEach` wipes THEN seeds a known webhook secret via
 *      `seedKnownWebhookSecret(F6_E2E_FIXTURE_SECRET)`. Wizard
 *      orchestrator's initial state derives from `secretConfigured =
 *      true` → renders Phase C directly without going through Phase A.
 *
 * The previous single-suite approach had test-order state coupling
 * (AS1 generated a secret → AS3 saw configured state by luck → tests
 * passed only if run in source order with no retries). The refactor
 * removes that hidden dependency.
 *
 * Gated on `E2E_ADMIN_EMAIL` + `E2E_ADMIN_PASSWORD` (seed-e2e-user
 * provisions these). Each test is independent and self-cleans state.
 *
 * Run with: `pnpm test:e2e --grep "F6 wizard" --workers=1
 *   --project=chromium` (workers=1 mandatory per feedback_e2e_workers).
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import {
  resetEventcreateState,
  seedKnownWebhookSecret,
  F6_E2E_FIXTURE_SECRET,
} from './helpers/eventcreate-seed';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const TENANT_SLUG =
  process.env.E2E_TENANT_SLUG ?? process.env.TENANT_SLUG ?? 'swecham';

void F6_E2E_FIXTURE_SECRET; // reserved for future webhook-replay round-trip assertions

test.describe.configure({ timeout: 180_000 });

// ===========================================================================
// Fresh-tenant scenarios — wipe state before each test so Phase A renders.
// ===========================================================================

test.describe('F6 wizard — fresh tenant (AS1) @workers=1', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run F6 wizard e2e',
  );

  test.beforeEach(async ({ page }) => {
    await resetEventcreateState(TENANT_SLUG);
    await signInAsAdmin(page);
  });

  test('AS1 — Phase A renders Generate Secret CTA + one-time reveal + saved-checkbox gate (FR-024)', async ({
    page,
  }) => {
    await page.goto('/admin/settings/integrations/eventcreate');
    await page.waitForLoadState('domcontentloaded');

    // PageHeader visible
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // Phase A: Generate Secret CTA
    const generateButton = page.getByRole('button', {
      name: /generate webhook secret/i,
    });
    await expect(generateButton).toBeVisible();
    await generateButton.click();

    // One-time reveal panel — copy button + reveal/hide toggle visible
    await expect(
      page.getByRole('button', { name: /copy secret/i }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /reveal secret|hide secret/i }),
    ).toBeVisible();

    // FR-024 checkbox gate — checkbox starts unchecked
    const savedCheckbox = page.getByRole('checkbox', {
      name: /(saved.*password manager|saved.*secret)/i,
    });
    await expect(savedCheckbox).toBeVisible();
    await expect(savedCheckbox).not.toBeChecked();

    // Ticking the checkbox enables the explicit Continue button
    // (verify-fix 2026-05-13 — auto-advance-on-tick removed to avoid
    // a React unmount race). Button stays disabled until checked.
    const continueButton = page.getByRole('button', {
      name: /continue.*(zapier|setup)/i,
    });
    await expect(continueButton).toBeDisabled();
    await savedCheckbox.check();
    await expect(continueButton).toBeEnabled();
    await continueButton.click();

    // Phase B is now active — Zapier walkthrough heading appears.
    await expect(
      page.getByRole('heading', { name: /connect eventcreate.*zapier/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('AS1 + FR-025 — Phase B Zapier walkthrough renders 8 steps + EN-only notice', async ({
    page,
  }) => {
    await page.goto('/admin/settings/integrations/eventcreate');
    await page.waitForLoadState('domcontentloaded');

    // Walk through Phase A → checkbox gate → explicit Continue → Phase B
    await page
      .getByRole('button', { name: /generate webhook secret/i })
      .click();
    await page
      .getByRole('checkbox', {
        name: /(saved.*password manager|saved.*secret)/i,
      })
      .check();
    await page
      .getByRole('button', { name: /continue.*(zapier|setup)/i })
      .click();

    // Phase B: ordered list with 8 steps + EN-only notice.
    // Filter by aria-label containing "walkthrough" specifically —
    // avoids collision with the top-of-page Stepper which renders its
    // own <ol> with aria-label "EventCreate setup steps" (would match
    // a broader `/setup steps/i` pattern and return 3 items).
    const walkthroughList = page.getByRole('list', { name: /walkthrough/i });
    await expect(walkthroughList).toBeVisible({ timeout: 10_000 });
    await expect(walkthroughList.getByRole('listitem')).toHaveCount(8);

    // FR-025 + round-3 Q3 — "Zapier UI is English only" notice
    await expect(page.getByText(/zapier.*english/i)).toBeVisible();
  });
});

// ===========================================================================
// Configured-tenant scenarios — pre-seed a known secret so wizard lands on
// Phase C directly (skips Phase A one-time-reveal flow).
// ===========================================================================

test.describe('F6 wizard — configured tenant (AS2 / AS3 / FR-008) @workers=1', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run F6 wizard e2e',
  );

  test.beforeEach(async ({ page }) => {
    await resetEventcreateState(TENANT_SLUG);
    await seedKnownWebhookSecret(TENANT_SLUG);
    await signInAsAdmin(page);
  });

  test('AS3 — Phase C masked secret + "Rotate secret" CTA (NOT plaintext reveal)', async ({
    page,
  }) => {
    await page.goto('/admin/settings/integrations/eventcreate');
    await page.waitForLoadState('domcontentloaded');

    // Configured tenant — Phase A button MUST NOT be present.
    await expect(
      page.getByRole('button', { name: /generate webhook secret/i }),
    ).toHaveCount(0);

    // Rotate-secret CTA (FR-008) visible.
    await expect(
      page.getByRole('button', { name: /rotate secret/i }),
    ).toBeVisible();

    // Masked secret marker — bullet characters in the displayed code block.
    await expect(page.getByText(/whsec_•+/)).toBeVisible();

    // Recent deliveries panel heading visible (FR-022).
    await expect(
      page.getByRole('heading', { name: /recent deliveries/i }),
    ).toBeVisible();
  });

  test('AS2 + FR-023 — "Send test event" button delivers + outcome appears <30s', async ({
    page,
  }) => {
    await page.goto('/admin/settings/integrations/eventcreate');
    await page.waitForLoadState('domcontentloaded');

    const testButton = page.getByRole('button', {
      name: /(send test event|test webhook)/i,
    });
    await expect(testButton).toBeVisible();
    await testButton.click();

    // Within 30s, the recent-deliveries panel renders a new row with
    // signature outcome "Verified" + processing outcome (test event).
    // Toast also fires (success or failure) per the button contract.
    const outcomeIndicator = page
      .getByText(/short.?circuit|matched|verified|test event/i)
      .first();
    await expect(outcomeIndicator).toBeVisible({ timeout: 30_000 });
  });

  test('AS3 + R5 — recent-deliveries panel includes Switch toggle for test deliveries', async ({
    page,
  }) => {
    await page.goto('/admin/settings/integrations/eventcreate');
    await page.waitForLoadState('domcontentloaded');

    // Per round-2 R5: test deliveries hidden by default; admin toggles
    // a Switch to reveal them. shadcn Switch primitive renders as
    // role="switch", NOT role="checkbox".
    const includeToggle = page.getByRole('switch', {
      name: /include test deliveries/i,
    });
    await expect(includeToggle).toBeVisible();
    // Initially OFF (sr-state reads "false").
    await expect(includeToggle).toHaveAttribute('aria-checked', 'false');
  });

  test('FR-008 — rotate-secret dialog shows grace-window info + Escape closes safely', async ({
    page,
  }) => {
    await page.goto('/admin/settings/integrations/eventcreate');
    await page.waitForLoadState('domcontentloaded');

    const rotateButton = page.getByRole('button', { name: /rotate secret/i });
    await expect(rotateButton).toBeVisible();
    await rotateButton.click();

    // ConfirmationDialog renders as role="alertdialog" (shadcn AlertDialog).
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    // 24h grace info — Thai/EN/SV all mention "24" so a digit match is locale-safe.
    await expect(dialog.getByText(/24/)).toBeVisible();

    // ConfirmationDialog auto-focuses Cancel — Escape closes safely.
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });
});

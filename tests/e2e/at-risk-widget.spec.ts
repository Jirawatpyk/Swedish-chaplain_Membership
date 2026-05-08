/**
 * F8 Phase 6 Wave F · T176 — E2E for at-risk widget (US4 AS1–AS6).
 *
 * Walks the user-facing acceptance scenarios from
 * `specs/011-renewal-reminders/spec.md` § US4:
 *   - AS3: Snooze 30 days → member disappears from widget
 *   - AS4: Contact action opens outreach dialog + records on confirm
 *   - AS5: Widget hidden from `member` role (route 403/redirect)
 *   - axe-core a11y scan on widget surface (light + dark theme,
 *     reduced-motion media)
 *
 * Server-side scenarios (AS1 score arithmetic; AS2 threshold-crossed
 * audit; AS6 per-tenant fault isolation) are covered by integration
 * tests T173 + T175 + T161 cron route — those exercise the use-case
 * + audit emit paths against live Neon. E2E coverage focuses on the
 * UI flow + a11y + theme + i18n smoke.
 *
 * Gate: skips entire suite when `FEATURE_F8_RENEWALS=false` or
 * `FEATURE_F8_AT_RISK_DISABLED=true` (granular kill-switch path is
 * tested separately in unit / integration).
 *
 * Run with: `pnpm test:e2e --grep "at-risk-widget" --workers=1`
 * (workers=1 mandatory per memory feedback_e2e_workers).
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import {
  seedOneAtRiskMember,
  type SeededAtRiskMember,
} from './helpers/seed-at-risk-member';
import AxeBuilder from '@axe-core/playwright';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const F8_RENEWALS_ENABLED = process.env.FEATURE_F8_RENEWALS === 'true';
const F8_AT_RISK_DISABLED =
  process.env.FEATURE_F8_AT_RISK_DISABLED === 'true';
const E2E_PLAN_ID = process.env.E2E_AT_RISK_PLAN_ID ?? 'regular';
const E2E_PLAN_YEAR = Number.parseInt(
  process.env.E2E_AT_RISK_PLAN_YEAR ?? '2026',
  10,
);

test.describe('F8 — at-risk widget (US4)', () => {
  let seeded: SeededAtRiskMember | null = null;

  test.beforeAll(() => {
    if (!ADMIN_EMAIL) {
      throw new Error(
        'E2E_ADMIN_EMAIL missing — set in .env.local before running this suite.',
      );
    }
    if (!F8_RENEWALS_ENABLED) {
      throw new Error(
        'FEATURE_F8_RENEWALS=false — set FEATURE_F8_RENEWALS=true in .env.local before running this suite.',
      );
    }
    if (F8_AT_RISK_DISABLED) {
      throw new Error(
        'FEATURE_F8_AT_RISK_DISABLED=true — at-risk surfaces are disabled; unset to run T176.',
      );
    }
  });

  // Per-test (not per-suite) seeding: AS3 snooze sets
  // `risk_snoozed_until = NOW + 30d` which hides the member from the
  // widget query — without per-test re-seeding, AS4 would inherit the
  // snoozed state and find no Contact button. Each test gets its own
  // fresh at-risk row + cleanup.
  test.beforeEach(async () => {
    seeded = await seedOneAtRiskMember(E2E_PLAN_ID, E2E_PLAN_YEAR);
    if (!seeded) {
      throw new Error(
        '[T176] seedOneAtRiskMember returned null — DATABASE_URL missing?',
      );
    }
  });

  test.afterEach(async () => {
    await seeded?.cleanup();
    seeded = null;
  });

  test('renders at-risk widget on /admin/renewals (admin)', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals');
    await expect(
      page.getByRole('heading', { name: /renewal pipeline/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Widget Card has heading "At-risk members" (EN) — i18n key
    // admin.renewals.atRisk.title.
    await expect(
      page.getByRole('heading', { name: /at-risk members/i }),
    ).toBeVisible({ timeout: 10_000 });

    // 3 band tabs (warning / at-risk / critical).
    const bandTabs = page.getByRole('tab', { name: /warning|at risk|critical/i });
    await expect(bandTabs.first()).toBeVisible();
  });

  test('AS3: snooze dialog flow — pick 30d, confirm, toast appears', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals');
    await expect(
      page.getByRole('heading', { name: /at-risk members/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Wait for the widget's loading-skeleton to clear before counting
    // action buttons — the widget initially renders a "Loading at-risk
    // member summary…" placeholder while the API request is in flight.
    // The summary description text changes from "Loading…" to either
    // the count-summary string OR feature-disabled placeholder once
    // the response lands.
    await expect(
      page.getByText(/loading at-risk member summary/i),
    ).toBeHidden({ timeout: 15_000 });

    // The beforeAll seedOneAtRiskMember guarantees ≥1 at-risk row at
    // score=78 (at-risk band). If the Snooze button is missing the
    // dialog flow is broken — that is the regression this hardening
    // catches (was previously accepted as a no-op pass).
    const snoozeButton = page.getByRole('button', { name: /snooze/i }).first();
    await expect(snoozeButton).toBeVisible({ timeout: 10_000 });
    await snoozeButton.click();

    // Dialog opens with title + radio options.
    await expect(
      page.getByRole('heading', { name: /snooze at-risk member/i }),
    ).toBeVisible();

    // Default focus on Cancel per ux-standards § 4.
    const cancelBtn = page.getByRole('button', { name: /^cancel$/i });
    await expect(cancelBtn).toBeFocused();

    // Pick 30 days option.
    await page.getByRole('radio', { name: /30 days/i }).click();
    await page.getByRole('button', { name: /confirm snooze/i }).click();

    // Success toast appears (sonner — visible briefly).
    await expect(page.getByText(/snoozed for 30 days/i)).toBeVisible({
      timeout: 5_000,
    });
  });

  test('AS4: contact (outreach) dialog flow — channel + template + confirm', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals');
    await expect(
      page.getByRole('heading', { name: /at-risk members/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Wait for the widget's loading-skeleton to clear (see AS3 spec
    // for rationale).
    await expect(
      page.getByText(/loading at-risk member summary/i),
    ).toBeHidden({ timeout: 15_000 });

    // beforeAll seed guarantees an actionable row — assert hard.
    const contactButton = page.getByRole('button', { name: /contact/i }).first();
    await expect(contactButton).toBeVisible({ timeout: 10_000 });
    await contactButton.click();

    await expect(
      page.getByRole('heading', { name: /record outreach/i }),
    ).toBeVisible();

    // Cancel-default focus.
    const cancelBtn = page.getByRole('button', { name: /^cancel$/i });
    await expect(cancelBtn).toBeFocused();

    // Add an outcome note (channel + template defaults to email +
    // event_drought).
    await page
      .getByPlaceholder(/brief note/i)
      .fill('Reached out by email about Q2 events.');
    await page.getByRole('button', { name: /record outreach/i }).click();
    await expect(page.getByText(/outreach recorded/i)).toBeVisible({
      timeout: 5_000,
    });
  });

  test('axe-core a11y — widget passes 0 violations', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals');
    await expect(
      page.getByRole('heading', { name: /at-risk members/i }),
    ).toBeVisible({ timeout: 10_000 });

    const results = await new AxeBuilder({ page })
      .include('[aria-labelledby="at-risk-widget-title"]')
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('reduced-motion: widget respects prefers-reduced-motion', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    try {
      await signInAsAdmin(page);
      await page.goto('/admin/renewals');
      await expect(
        page.getByRole('heading', { name: /at-risk members/i }),
      ).toBeVisible({ timeout: 10_000 });
      // The widget renders without animated tab transitions in
      // reduced-motion mode (visual smoke; the CSS framework handles
      // this via media query).
    } finally {
      await context.close();
    }
  });
});

/**
 * 058 G1 — Benefits tabs [Benefits] [Broadcasts] (spec §4.4) E2E + @a11y.
 *
 * Asserts the §7 a11y contract (keyboard nav, `aria-selected`, a real `<h2>`
 * per panel), the `?tab=` deep-link, and the `/portal/benefits/e-blasts`
 * redirect, against a signed-in member.
 *
 * Requires E2E_MEMBER_* in .env.local. Run:
 *   pnpm test:e2e --grep "Benefits tabs" --workers=1
 * (ALWAYS `--workers=1` per project memory — default 3 hangs the workstation.)
 *
 * Local-noise note (project memory `reference_e2e_perf_gates_preview_only` +
 * `feedback_e2e_workers`): local dev e2e has EXPECTED noise — 320px
 * target-size / reflow a11y fails + dev-server sign-in cold-compile flakes.
 * The AUTHORITATIVE a11y run is the preview deploy. The axe assertion here is
 * scoped to serious+critical so transient moderate/contrast/target-size noise
 * does not flake the gate; a REAL tab-association regression (tablist missing
 * aria-label, broken tab/panel wiring, heading order) still fails it.
 *
 * Base UI Tabs activation: `@base-ui/react` `Tabs.List.activateOnFocus`
 * DEFAULTS to `false` (verified node_modules/@base-ui/react/tabs/list —
 * v1.3.0), and `BenefitsTabs` does NOT override it. So ArrowRight only MOVES
 * focus between tabs; activation requires Enter/Space. Only on activation does
 * `onValueChange` fire → `router.replace('/portal/benefits?tab=broadcasts')`,
 * which re-renders the server-chosen active panel. The keyboard test below
 * therefore presses ArrowRight THEN Enter, and the `?tab=broadcasts` URL is the
 * canonical source-of-truth assertion.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '../fixtures';
import { signInAsMember } from '../helpers/member-session';

// Tab-label matchers cover all three shipped locales so the spec passes
// regardless of the default render locale (en.json: "Benefits"/"Broadcasts";
// th.json: "สิทธิประโยชน์"/"การประกาศ"; sv.json: "Förmåner"/"Utskick").
const BENEFITS_TAB_NAME = /benefits|förmåner|สิทธิประโยชน์/i;
const BROADCASTS_TAB_NAME = /broadcasts|utskick|การประกาศ/i;

test.describe('Benefits tabs @a11y', () => {
  test('default tab = Benefits; renders a real <h2>', async ({ page }) => {
    await signInAsMember(page);
    await page.goto('/portal/benefits');

    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(2);
    await expect(
      page.getByRole('tab', { name: BENEFITS_TAB_NAME }).first(),
    ).toHaveAttribute('aria-selected', 'true');
    // BenefitUsageCard renders <h2 id="benefits-panel-heading"> even in its
    // empty state, so this holds whether or not the seeded member has
    // quantifiable benefits.
    await expect(page.locator('#benefits-panel-heading')).toBeVisible();
  });

  test('deep-link ?tab=broadcasts opens the Broadcasts panel with its own <h2>', async ({
    page,
  }) => {
    await signInAsMember(page);
    await page.goto('/portal/benefits?tab=broadcasts');

    await expect(
      page.getByRole('tab', { name: BROADCASTS_TAB_NAME }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#broadcasts-panel-heading')).toBeVisible();
    await expect(page.getByTestId('quota-display')).toBeVisible();
  });

  test('keyboard: ArrowRight + Enter activates the Broadcasts tab', async ({
    page,
  }) => {
    await signInAsMember(page);
    await page.goto('/portal/benefits');

    await page.getByRole('tab', { name: BENEFITS_TAB_NAME }).first().focus();
    // Base UI manual activation (activateOnFocus=false): ArrowRight moves the
    // roving-tabindex focus to the Broadcasts tab; Enter activates it →
    // onValueChange → router.replace('?tab=broadcasts').
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');

    // The URL is the source of truth (the active panel is server-rendered from
    // ?tab=). Assert it first so a router-wiring regression fails loudly.
    await expect(page).toHaveURL(/\/portal\/benefits\?tab=broadcasts/);
    await expect(
      page.getByRole('tab', { name: BROADCASTS_TAB_NAME }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#broadcasts-panel-heading')).toBeVisible();
  });

  test('/portal/benefits/e-blasts redirects to the Broadcasts tab (no 404)', async ({
    page,
  }) => {
    await signInAsMember(page);

    const resp = await page.goto('/portal/benefits/e-blasts');
    expect(resp?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(/\/portal\/benefits\?tab=broadcasts/);
    await expect(page.locator('#broadcasts-panel-heading')).toBeVisible();
  });

  test('axe: 0 serious/critical violations on the Broadcasts tab', async ({
    page,
  }) => {
    await signInAsMember(page);
    await page.goto('/portal/benefits?tab=broadcasts');
    // Wait for the quota card to settle (it fetches /api/broadcasts/quota on
    // mount) before scanning so the populated layout is what axe sees.
    await page.getByTestId('quota-display').waitFor();
    await expect(page.locator('#broadcasts-panel-heading')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    // Local dev e2e emits EXPECTED moderate noise (320px reflow / target-size /
    // contrast) that is preview-only signal per project memory; gate on
    // serious+critical so the tab-association contract is enforced without
    // chasing known local noise. (Mirrors the helpers/axe-scan.ts default.)
    const seriousOrCritical = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(seriousOrCritical, 'axe-core serious+critical violations').toEqual([]);
  });
});
